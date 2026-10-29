import { handler } from '@/lib/http';
import { book } from '@/lib/queue';
import { stateFor } from '@/lib/state';

export const POST = handler<{ id: string }>({ rateLimit: true }, async ({ session, params }) => {
  await book(session.uid, params.id);
  return stateFor(session.uid);
});
