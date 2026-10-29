import { clearSessionCookie } from '@/lib/auth';
import { handler } from '@/lib/http';
import { deleteSubscription } from '@/lib/notify';

/** Ends the session; the client sends this device's push endpoint so it stops receiving pushes. */
export const POST = handler({}, async ({ req, session }) => {
  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: unknown };
  await deleteSubscription(session.uid, endpoint);
  return new Response(null, { status: 204, headers: { 'set-cookie': clearSessionCookie } });
});
