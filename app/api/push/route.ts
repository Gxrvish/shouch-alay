import { handler, jsonBody } from '@/lib/http';
import { saveSubscription } from '@/lib/notify';

/** Registers this device for Web Push. The client calls it when the user first joins a queue. */
export const POST = handler({}, async ({ req, session }) => {
  await saveSubscription(session.uid, await jsonBody(req));
  return new Response(null, { status: 204 });
});
