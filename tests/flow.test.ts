/**
 * Integration tests against a real Postgres: `TEST_DATABASE_URL=postgres://... npm test`.
 * The database is wiped before every test, so never point this at real data.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createSessionCookie } from '@/lib/auth';
import { db } from '@/lib/db';
import { book, cancel, claim, done, processDueDeadlines, purgeFinished, stillHere, updateToilet } from '@/lib/queue';
import { stateFor } from '@/lib/state';
import type { StateView } from '@/lib/types';
import { migrate } from '@/scripts/migrate';
import { POST as actionRoute } from '@/app/api/bookings/[id]/[action]/route';
import { POST as bookRoute } from '@/app/api/toilets/[id]/book/route';

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
process.env.SESSION_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const CSRF = 'test-csrf-token';
type User = { uid: string; headers: Record<string, string> };
type Route<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;

async function newUser(): Promise<User> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO users (google_sub, email) VALUES (gen_random_uuid()::text, gen_random_uuid()::text || '@odoo.com') RETURNING id`,
  );
  const uid = rows[0]!.id;
  const cookie = (await createSessionCookie({ uid, csrf: CSRF, admin: false })).split(';')[0]!;
  return { uid, headers: { cookie, 'x-csrf-token': CSRF } };
}

const newUsers = (n: number) => Promise.all(Array.from({ length: n }, newUser));

async function newToilet(name = 'Floor 1 / Toilet A'): Promise<string> {
  const { rows } = await db().query<{ id: string }>('INSERT INTO toilets (name) VALUES ($1) RETURNING id', [name]);
  return rows[0]!.id;
}

function post<P>(route: Route<P>, path: string, headers: Record<string, string>, params: P): Promise<Response> {
  return route(new Request(`http://localhost${path}`, { method: 'POST', headers }), { params: Promise.resolve(params) });
}

const bookVia = (user: User, toiletId: string) => post(bookRoute, `/api/toilets/${toiletId}/book`, user.headers, { id: toiletId });
const myBooking = async (user: User) => (await stateFor(user.uid)).myBooking!;
const statusOf = async (bookingId: string) =>
  (await db().query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0]?.status;
/** Moves a booking's deadline into the past, as if its timer had run out. */
const runOutTimer = (bookingId: string) => db().query(`UPDATE bookings SET deadline = now() - interval '1 second' WHERE id = $1`, [bookingId]);
const turn = (user: User, kind: 'your-turn' | 'still-there' = 'your-turn') => ({ kind, userId: user.uid, toiletName: 'Floor 1 / Toilet A' });

describe('booking flow on Postgres', { skip: TEST_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  before(() => migrate());
  beforeEach(() => db().query('TRUNCATE users, toilets, bookings, push_subscriptions, rate_limits'));
  after(() => db().end());

  test('simultaneous Book taps on a free toilet: exactly one gets in, the rest queue in order', async () => {
    for (let round = 0; round < 5; round++) {
      const toilet = await newToilet(`Race ${round}`);
      const users = await newUsers(8);
      const responses = await Promise.all(users.map((u) => bookVia(u, toilet)));
      assert.deepEqual(responses.map((r) => r.status), Array(8).fill(200));

      const bookings = await Promise.all(responses.map(async (r) => ((await r.json()) as StateView).myBooking!));
      assert.equal(bookings.filter((b) => b.status === 'ACTIVE').length, 1);
      const positions = bookings.filter((b) => b.status === 'WAITING').map((b) => b.position!);
      assert.deepEqual(positions.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
    }
  });

  test('double-tapping Book keeps a single booking', async () => {
    const toilet = await newToilet();
    const [user] = await newUsers(1);
    const responses = await Promise.all(Array.from({ length: 4 }, () => bookVia(user!, toilet)));
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200]);
    const ids = await Promise.all(responses.map(async (r) => ((await r.json()) as StateView).myBooking!.id));
    assert.equal(new Set(ids).size, 1);
  });

  test('one booking per user, even when booking two toilets at the same instant', async () => {
    const toilets = [await newToilet('A'), await newToilet('B')];
    const [user] = await newUsers(1);
    const responses = await Promise.all(toilets.map((t) => bookVia(user!, t)));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const { rows } = await db().query('SELECT 1 FROM bookings WHERE user_id = $1', [user!.uid]);
    assert.equal(rows.length, 1);
  });

  test("“I'm done” twice: the second tap changes nothing", async () => {
    const toilet = await newToilet();
    const [a, b] = await newUsers(2);
    await book(a!.uid, toilet);
    await book(b!.uid, toilet);
    const { id } = await myBooking(a!);

    const path = `/api/bookings/${id}/done`;
    const responses = [await post(actionRoute, path, a!.headers, { id, action: 'done' }), await post(actionRoute, path, a!.headers, { id, action: 'done' })];
    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    assert.deepEqual(await done(a!.uid, id), [], 'no second "your turn" notice');
    assert.equal(await statusOf(id), 'DONE');
    assert.equal((await myBooking(b!)).status, 'NOTIFIED');
  });

  test('an unclaimed turn expires and passes to the next person', async () => {
    const toilet = await newToilet();
    const [a, b, c] = await newUsers(3);
    for (const u of [a!, b!, c!]) await book(u.uid, toilet);
    const [ia, ib, ic] = await Promise.all([a!, b!, c!].map(async (u) => (await myBooking(u)).id));

    assert.deepEqual(await done(a!.uid, ia!), [turn(b!)]);
    assert.deepEqual(await processDueDeadlines(), [], 'claim window still open');

    await runOutTimer(ib!);
    await assert.rejects(claim(b!.uid, ib!), { status: 409 }, 'too late, even before the worker runs');
    assert.deepEqual(await processDueDeadlines(), [turn(c!)]);
    assert.equal(await statusOf(ib!), 'EXPIRED');
    assert.deepEqual(await processDueDeadlines(), [], 'reruns are harmless');
    await assert.rejects(claim(b!.uid, ib!), { status: 409 });

    await claim(c!.uid, ic!);
    assert.equal(await statusOf(ic!), 'ACTIVE');
  });

  test('a notified user who claims in time gets in', async () => {
    const toilet = await newToilet();
    const [a, b] = await newUsers(2);
    await book(a!.uid, toilet);
    await book(b!.uid, toilet);
    await done(a!.uid, (await myBooking(a!)).id);
    const { id, deadline } = await myBooking(b!);
    assert.ok(Date.parse(deadline!) > Date.now(), 'deadline is in the future');
    await claim(b!.uid, id);
    await claim(b!.uid, id); // repeated tap
    assert.equal(await statusOf(id), 'ACTIVE');
  });

  test('a forgotten sign-out is asked "Are you still there?", then released after the grace period', async () => {
    const toilet = await newToilet();
    const [a, b] = await newUsers(2);
    await book(a!.uid, toilet);
    await book(b!.uid, toilet);
    const { id } = await myBooking(a!);

    await runOutTimer(id);
    assert.deepEqual(await processDueDeadlines(), [turn(a!, 'still-there')]);
    assert.equal((await myBooking(a!)).stillThere, true);

    await runOutTimer(id);
    assert.deepEqual(await processDueDeadlines(), [turn(b!)]);
    assert.equal(await statusOf(id), 'AUTO_RELEASED');
  });

  test("answering “I'm still here” restarts the occupancy timer", async () => {
    const toilet = await newToilet();
    const [a] = await newUsers(1);
    await book(a!.uid, toilet);
    const { id } = await myBooking(a!);
    await runOutTimer(id);
    await processDueDeadlines();

    await stillHere(a!.uid, id);
    assert.equal((await myBooking(a!)).stillThere, false);
    assert.deepEqual(await processDueDeadlines(), []);
    assert.equal(await statusOf(id), 'ACTIVE');
  });

  test("“I'm still here” cannot hold a toilet past the maximum stay", async () => {
    const toilet = await newToilet();
    const [a, b] = await newUsers(2);
    await book(a!.uid, toilet);
    await book(b!.uid, toilet);
    const { id } = await myBooking(a!);
    await db().query(`UPDATE bookings SET started_at = now() - interval '31 minutes' WHERE id = $1`, [id]);
    await runOutTimer(id);
    await processDueDeadlines();

    await assert.rejects(stillHere(a!.uid, id), { status: 409 });
    await runOutTimer(id);
    assert.deepEqual(await processDueDeadlines(), [turn(b!)]);
    assert.equal(await statusOf(id), 'AUTO_RELEASED');
  });

  test('leaving the queue: waiting users just leave, a notified user hands the turn on', async () => {
    const toilet = await newToilet();
    const [a, b, c] = await newUsers(3);
    for (const u of [a!, b!, c!]) await book(u.uid, toilet);
    assert.deepEqual(await cancel(c!.uid, (await myBooking(c!)).id), []);
    await done(a!.uid, (await myBooking(a!)).id);
    const [d] = await newUsers(1);
    await book(d!.uid, toilet);
    assert.deepEqual(await cancel(b!.uid, (await myBooking(b!)).id), [turn(d!)]);
  });

  test('nobody can see who is inside or who is queued', async () => {
    const toilet = await newToilet();
    const [a, b] = await newUsers(2);
    await book(a!.uid, toilet);
    await book(b!.uid, toilet);
    const aBooking = (await myBooking(a!)).id;

    const view = await stateFor(b!.uid);
    const json = JSON.stringify(view);
    for (const secret of [a!.uid, aBooking, '@odoo.com']) assert.ok(!json.includes(secret), `leaked ${secret}`);
    assert.deepEqual(view.toilets, [{ id: toilet, name: 'Floor 1 / Toilet A', status: 'occupied', waiting: 1 }]);
    assert.equal(view.myBooking?.position, 1);
    assert.equal(view.myBooking?.estimatedWaitMin, 5);
  });

  test('API calls need a session, and changes need the CSRF token', async () => {
    const toilet = await newToilet();
    const [user] = await newUsers(1);
    assert.equal((await bookVia({ uid: '', headers: {} }, toilet)).status, 401);
    assert.equal((await bookVia({ ...user!, headers: { cookie: user!.headers.cookie! } }, toilet)).status, 403);
    assert.equal((await bookVia({ ...user!, headers: { ...user!.headers, 'x-csrf-token': 'forged' } }, toilet)).status, 403);
    assert.equal((await bookVia(user!, toilet)).status, 200);
  });

  test('booking actions are rate limited per user', async () => {
    const toilet = await newToilet();
    const [user, other] = await newUsers(2);
    await db().query(`INSERT INTO rate_limits VALUES ($1, date_trunc('minute', now()), 20)`, [user!.uid]);
    assert.equal((await bookVia(user!, toilet)).status, 429);
    assert.equal((await bookVia(other!, toilet)).status, 200);
  });

  test('closing a toilet cancels its queue and lets the person inside finish', async () => {
    const toilet = await newToilet();
    const [a, b, c] = await newUsers(3);
    await book(a!.uid, toilet);
    await book(b!.uid, toilet);
    const [ia, ib] = [(await myBooking(a!)).id, (await myBooking(b!)).id];

    await updateToilet(toilet, { disabled: true });
    assert.equal(await statusOf(ib), 'CANCELLED');
    assert.equal(await statusOf(ia), 'ACTIVE');
    await assert.rejects(book(c!.uid, toilet), { status: 409 });
    assert.deepEqual(await done(a!.uid, ia), []);
  });

  test('finished bookings are purged after 24 hours', async () => {
    const toilet = await newToilet();
    const [a, b] = await newUsers(2);
    await book(a!.uid, toilet);
    const ia = (await myBooking(a!)).id;
    await done(a!.uid, ia);
    await book(b!.uid, toilet);
    const ib = (await myBooking(b!)).id;
    await done(b!.uid, ib);

    await db().query(`UPDATE bookings SET ended_at = now() - interval '25 hours' WHERE id = $1`, [ia]);
    assert.equal(await purgeFinished(), 1);
    assert.equal(await statusOf(ia), undefined);
    assert.equal(await statusOf(ib), 'DONE');
  });
});
