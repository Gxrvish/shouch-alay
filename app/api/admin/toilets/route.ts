import { handler, jsonBody } from '@/lib/http';
import { createToilet } from '@/lib/queue';
import { stateFor } from '@/lib/state';

export const POST = handler({ admin: true }, async ({ req, session }) => {
  await createToilet((await jsonBody(req)).name);
  return stateFor(session.uid);
});
