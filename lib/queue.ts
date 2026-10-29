/**
 * The booking service: the state machine, every action that changes a queue, and the deadline
 * worker. All booking status writes in the app happen in `insert` and `move` below, and both
 * consult TRANSITIONS.
 */
import type { PoolClient } from 'pg';
import { config } from './config';
import { db, inTransaction, uniqueViolation } from './db';
import { AppError } from './http';

export const STATUSES = ['WAITING', 'NOTIFIED', 'ACTIVE', 'DONE', 'CANCELLED', 'EXPIRED', 'AUTO_RELEASED'] as const;
export type Status = (typeof STATUSES)[number];
type Final = 'DONE' | 'CANCELLED' | 'EXPIRED' | 'AUTO_RELEASED';

/** The allowed status changes. `NEW` is the pseudo-state of a booking being created. */
export const TRANSITIONS: Record<Status | 'NEW', readonly Status[]> = {
  NEW: ['WAITING', 'ACTIVE'], // ACTIVE only when the toilet is free and nobody waits
  WAITING: ['NOTIFIED', 'CANCELLED'],
  NOTIFIED: ['ACTIVE', 'EXPIRED', 'CANCELLED'],
  ACTIVE: ['DONE', 'AUTO_RELEASED'],
  DONE: [],
  CANCELLED: [],
  EXPIRED: [],
  AUTO_RELEASED: [],
};

export function canTransition(from: Status | 'NEW', to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

/** A notification to send once the transaction has committed. Carries only the recipient's own data. */
export type Notice = { kind: 'your-turn' | 'still-there'; userId: string; toiletName: string };

type Booking = { id: string; user_id: string; status: Status; nudged: boolean; overdue: boolean; started_at: Date | null };
type Ctx = { tx: PoolClient; toilet: { id: string; name: string; disabled: boolean }; notices: Notice[] };

const OPEN = `('WAITING', 'NOTIFIED', 'ACTIVE')`;
const BOOKING = `id, user_id, status, nudged_at IS NOT NULL AS nudged, coalesce(deadline <= now(), false) AS overdue, started_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALREADY_BOOKED = 'You already have a booking. Leave it before booking another toilet.';

/**
 * Runs `fn` holding the toilet's row lock (SELECT ... FOR UPDATE). Every booking write happens
 * inside one of these, so changes to one queue are serialized: two "Book" taps on a free toilet
 * at the same instant yield one ACTIVE and one WAITING booking. Deadlines are compared with the
 * database clock, so app servers and the cron job agree on what is overdue.
 */
async function onToilet(toiletId: string, fn: (ctx: Ctx) => Promise<void>): Promise<Notice[]> {
  if (!UUID.test(toiletId)) throw new AppError(404, 'Toilet not found.');
  return inTransaction(async (tx) => {
    const { rows } = await tx.query<Ctx['toilet']>('SELECT id, name, disabled FROM toilets WHERE id = $1 FOR UPDATE', [toiletId]);
    if (!rows[0]) throw new AppError(404, 'Toilet not found.');
    const ctx: Ctx = { tx, toilet: rows[0], notices: [] };
    await fn(ctx);
    return ctx.notices;
  });
}

/** Like onToilet, for one of the caller's own bookings. Other people's bookings do not exist (404). */
async function onBooking(userId: string, bookingId: string, fn: (ctx: Ctx, b: Booking) => Promise<void>): Promise<Notice[]> {
  if (!UUID.test(bookingId)) throw new AppError(404, 'Booking not found.');
  const { rows } = await db().query<{ toilet_id: string }>('SELECT toilet_id FROM bookings WHERE id = $1 AND user_id = $2', [bookingId, userId]);
  if (!rows[0]) throw new AppError(404, 'Booking not found.');
  return onToilet(rows[0].toilet_id, async (ctx) => {
    // Re-read under the lock: the deadline worker may have moved it meanwhile.
    const { rows: [booking] } = await ctx.tx.query<Booking>(`SELECT ${BOOKING} FROM bookings WHERE id = $1`, [bookingId]);
    if (!booking) throw new AppError(404, 'Booking not found.');
    await fn(ctx, booking);
  });
}

async function insert(ctx: Ctx, userId: string, status: Status): Promise<void> {
  if (!canTransition('NEW', status)) throw new Error(`A booking cannot start as ${status}`);
  try {
    await ctx.tx.query(
      `INSERT INTO bookings (toilet_id, user_id, status, deadline, started_at)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'ACTIVE' THEN now() + make_interval(secs => $4) END, CASE WHEN $3 = 'ACTIVE' THEN now() END)`,
      [ctx.toilet.id, userId, status, config.maxOccupancySec],
    );
  } catch (err) {
    // The same user booked another toilet in a concurrent transaction that committed first.
    if (uniqueViolation(err) === 'bookings_one_open_per_user') throw new AppError(409, ALREADY_BOOKED);
    throw err;
  }
}

/** The single place a booking changes status. Sets the timestamps that belong to the new status. */
async function move(ctx: Ctx, b: Booking, to: Status): Promise<void> {
  if (!canTransition(b.status, to)) {
    throw new AppError(409, `Not possible: this booking is ${b.status.toLowerCase().replace('_', ' ')}.`);
  }
  await ctx.tx.query(
    `UPDATE bookings SET
       status = $2,
       deadline = CASE $2 WHEN 'NOTIFIED' THEN now() + make_interval(secs => $3)
                          WHEN 'ACTIVE' THEN now() + make_interval(secs => $4) END,
       started_at = CASE WHEN $2 = 'ACTIVE' THEN now() ELSE started_at END,
       nudged_at = NULL,
       ended_at = CASE WHEN $2 IN ('DONE', 'CANCELLED', 'EXPIRED', 'AUTO_RELEASED') THEN now() END
     WHERE id = $1`,
    [b.id, to, config.claimWindowSec, config.maxOccupancySec],
  );
}

/** Ends a booking. If it held the toilet, the next person in line gets their turn. */
async function finish(ctx: Ctx, b: Booking, to: Final): Promise<void> {
  await move(ctx, b, to);
  if (b.status !== 'NOTIFIED' && b.status !== 'ACTIVE') return;
  const { rows: [next] } = await ctx.tx.query<Booking>(
    `SELECT ${BOOKING} FROM bookings WHERE toilet_id = $1 AND status = 'WAITING' ORDER BY queued_at, id LIMIT 1`,
    [ctx.toilet.id],
  );
  if (!next) return;
  await move(ctx, next, 'NOTIFIED');
  ctx.notices.push({ kind: 'your-turn', userId: next.user_id, toiletName: ctx.toilet.name });
}

// --- User actions. Repeating a completed action is a no-op, so double taps and retries are safe.

export function book(userId: string, toiletId: string): Promise<Notice[]> {
  return onToilet(toiletId, async (ctx) => {
    const { rows: [mine] } = await ctx.tx.query<{ toilet_id: string }>(
      `SELECT toilet_id FROM bookings WHERE user_id = $1 AND status IN ${OPEN}`,
      [userId],
    );
    if (mine?.toilet_id === toiletId) return;
    if (mine) throw new AppError(409, ALREADY_BOOKED);
    if (ctx.toilet.disabled) throw new AppError(409, 'This toilet is closed.');
    const { rowCount } = await ctx.tx.query(`SELECT 1 FROM bookings WHERE toilet_id = $1 AND status IN ${OPEN} LIMIT 1`, [toiletId]);
    await insert(ctx, userId, rowCount ? 'WAITING' : 'ACTIVE');
  });
}

export function claim(userId: string, bookingId: string): Promise<Notice[]> {
  return onBooking(userId, bookingId, async (ctx, b) => {
    if (b.status === 'ACTIVE') return;
    // The window is strict even if the worker has not expired the booking yet.
    if ((b.status === 'NOTIFIED' && b.overdue) || b.status === 'EXPIRED') throw new AppError(409, 'Too late: your turn has passed.');
    await move(ctx, b, 'ACTIVE');
  });
}

export function done(userId: string, bookingId: string): Promise<Notice[]> {
  return onBooking(userId, bookingId, async (ctx, b) => {
    if (b.status === 'DONE') return;
    await finish(ctx, b, 'DONE');
    // Exponentially weighted average of real visits; it drives the wait estimate.
    await ctx.tx.query(
      `UPDATE toilets SET avg_occupancy_sec = 0.8 * avg_occupancy_sec + 0.2 * extract(epoch FROM now() - $2::timestamptz) WHERE id = $1`,
      [ctx.toilet.id, b.started_at],
    );
  });
}

export function cancel(userId: string, bookingId: string): Promise<Notice[]> {
  return onBooking(userId, bookingId, async (ctx, b) => {
    if (b.status !== 'CANCELLED') await finish(ctx, b, 'CANCELLED');
  });
}

/**
 * Answers "Are you still there?": restarts the occupancy timer, but never past MAX_STAY_SEC from
 * going in. After that the next check cannot be answered and the toilet is released. Not a status change.
 */
export function stillHere(userId: string, bookingId: string): Promise<Notice[]> {
  return onBooking(userId, bookingId, async (ctx, b) => {
    if (b.status !== 'ACTIVE') throw new AppError(409, 'You are not signed in to this toilet.');
    const { rowCount } = await ctx.tx.query(
      `UPDATE bookings SET nudged_at = NULL,
         deadline = least(now() + make_interval(secs => $2), started_at + make_interval(secs => $3))
       WHERE id = $1 AND now() < started_at + make_interval(secs => $3)`,
      [b.id, config.maxOccupancySec, config.maxStaySec],
    );
    if (!rowCount) throw new AppError(409, `${Math.round(config.maxStaySec / 60)} minutes is the limit, so you will be signed out shortly.`);
  });
}

// --- Deadlines -------------------------------------------------------------------------------

/**
 * The deadline worker. Run by the cron job and by every instance serving live updates; running it
 * concurrently is safe because each toilet is re-checked under its lock.
 */
export async function processDueDeadlines(): Promise<Notice[]> {
  const { rows } = await db().query<{ toilet_id: string }>(
    `SELECT DISTINCT toilet_id FROM bookings WHERE status IN ('NOTIFIED', 'ACTIVE') AND deadline <= now()`,
  );
  const notices: Notice[] = [];
  for (const { toilet_id } of rows) notices.push(...(await onToilet(toilet_id, settle)));
  return notices;
}

async function settle(ctx: Ctx): Promise<void> {
  // A toilet has at most one holder (unique index), hence at most one due booking.
  const { rows: [due] } = await ctx.tx.query<Booking>(
    `SELECT ${BOOKING} FROM bookings WHERE toilet_id = $1 AND status IN ('NOTIFIED', 'ACTIVE') AND deadline <= now()`,
    [ctx.toilet.id],
  );
  if (!due) return;
  if (due.status === 'NOTIFIED') return finish(ctx, due, 'EXPIRED');
  if (due.nudged) return finish(ctx, due, 'AUTO_RELEASED');
  // Max occupancy reached: ask first, release after the grace period.
  await ctx.tx.query(`UPDATE bookings SET nudged_at = now(), deadline = now() + make_interval(secs => $2) WHERE id = $1`, [
    due.id,
    config.graceSec,
  ]);
  ctx.notices.push({ kind: 'still-there', userId: due.user_id, toiletName: ctx.toilet.name });
}

/** Finished bookings are kept 24 h, then deleted; only each toilet's average visit length remains. */
export async function purgeFinished(): Promise<number> {
  const { rowCount } = await db().query(`DELETE FROM bookings WHERE ended_at < now() - interval '24 hours'`);
  return rowCount ?? 0;
}

// --- Admin: toilets only. There is deliberately no way to list who booked what. ---------------

function toiletName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 80) throw new AppError(400, 'Name must be 1 to 80 characters.');
  return name;
}

function duplicateName(err: unknown): never {
  if (uniqueViolation(err) === 'toilets_name_key') throw new AppError(409, 'A toilet with that name already exists.');
  throw err;
}

export async function createToilet(name: unknown): Promise<void> {
  await db().query('INSERT INTO toilets (name) VALUES ($1)', [toiletName(name)]).catch(duplicateName);
}

export async function updateToilet(toiletId: string, patch: { name?: unknown; disabled?: unknown }): Promise<void> {
  if (patch.disabled !== undefined && typeof patch.disabled !== 'boolean') throw new AppError(400, '"disabled" must be true or false.');
  const name = patch.name === undefined ? undefined : toiletName(patch.name);
  await onToilet(toiletId, async (ctx) => {
    if (name !== undefined) await ctx.tx.query('UPDATE toilets SET name = $2 WHERE id = $1', [ctx.toilet.id, name]).catch(duplicateName);
    if (patch.disabled === undefined) return;
    await ctx.tx.query('UPDATE toilets SET disabled = $2 WHERE id = $1', [ctx.toilet.id, patch.disabled]);
    if (!patch.disabled) return;
    // Nobody should be sent to a closed toilet; whoever is inside finishes normally.
    const { rows } = await ctx.tx.query<Booking>(`SELECT ${BOOKING} FROM bookings WHERE toilet_id = $1 AND status IN ('WAITING', 'NOTIFIED')`, [
      ctx.toilet.id,
    ]);
    for (const b of rows) await move(ctx, b, 'CANCELLED');
  });
}
