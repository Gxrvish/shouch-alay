/**
 * The only shapes the API sends. Every response is built for one caller: anonymous toilet
 * summaries plus that caller's own booking. No user ids, names or emails.
 */

export type ToiletView = {
  id: string;
  name: string;
  status: 'free' | 'occupied' | 'closed';
  waiting: number;
};

export type MyBooking = {
  id: string;
  toiletId: string;
  status: 'WAITING' | 'NOTIFIED' | 'ACTIVE';
  /** 1 = next in line. WAITING only. */
  position: number | null;
  /** WAITING only. */
  estimatedWaitMin: number | null;
  /** NOTIFIED: end of the claim window. ACTIVE: occupancy check, or auto sign-out once asked. */
  deadline: string | null;
  /** "Are you still there?" has been asked. */
  stillThere: boolean;
};

export type StateView = { toilets: ToiletView[]; myBooking: MyBooking | null };
