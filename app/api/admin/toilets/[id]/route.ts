import { handler, jsonBody } from '@/lib/http';
import { updateToilet } from '@/lib/queue';
import { stateFor } from '@/lib/state';

/** Rename (`{ name }`) and/or close or reopen (`{ disabled }`) a toilet. */
export const PATCH = handler<{ id: string }>({ admin: true }, async ({ req, session, params }) => {
  await updateToilet(params.id, await jsonBody(req));
  return stateFor(session.uid);
});
