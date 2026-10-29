import { db } from './db';
import type { MyBooking, StateView, ToiletView } from './types';

/** Everything needed to build any caller's view, computed once and shared by all listeners. */
export type Snapshot = { toilets: ToiletView[]; bookings: Map<string, MyBooking> };

type BookingRow = { id: string; user_id: string; toilet_id: string; status: MyBooking['status']; deadline: Date | null; still_there: boolean };
type ToiletRow = { id: string; name: string; disabled: boolean; avg_occupancy_sec: number };

export async function snapshot(): Promise<Snapshot> {
  // Bookings first: toilets are never deleted, so every booking's toilet is in the second result.
  const { rows: open } = await db().query<BookingRow>(
    `SELECT id, user_id, toilet_id, status, deadline, nudged_at IS NOT NULL AS still_there
     FROM bookings WHERE status IN ('WAITING', 'NOTIFIED', 'ACTIVE') ORDER BY queued_at, id`,
  );
  const { rows: toiletRows } = await db().query<ToiletRow>('SELECT id, name, disabled, avg_occupancy_sec FROM toilets ORDER BY name');

  const queues = new Map(toiletRows.map((t) => [t.id, { held: false, waiting: 0, avgSec: t.avg_occupancy_sec }]));
  const bookings = new Map<string, MyBooking>();
  for (const b of open) {
    const queue = queues.get(b.toilet_id)!;
    const position = b.status === 'WAITING' ? ++queue.waiting : null;
    if (b.status !== 'WAITING') queue.held = true;
    bookings.set(b.user_id, {
      id: b.id,
      toiletId: b.toilet_id,
      status: b.status,
      position,
      // Everyone ahead (the holder plus those queued earlier) takes about one average visit.
      estimatedWaitMin: position === null ? null : Math.ceil((position * queue.avgSec) / 60),
      deadline: b.deadline?.toISOString() ?? null,
      stillThere: b.still_there,
    });
  }

  const toilets = toiletRows.map((t): ToiletView => {
    const queue = queues.get(t.id)!;
    return { id: t.id, name: t.name, status: t.disabled ? 'closed' : queue.held ? 'occupied' : 'free', waiting: queue.waiting };
  });
  return { toilets, bookings };
}

/** The caller's view: anonymous toilet summaries plus their own booking, nothing else. */
export function viewFor(snap: Snapshot, userId: string): StateView {
  return { toilets: snap.toilets, myBooking: snap.bookings.get(userId) ?? null };
}

export async function stateFor(userId: string): Promise<StateView> {
  return viewFor(await snapshot(), userId);
}
