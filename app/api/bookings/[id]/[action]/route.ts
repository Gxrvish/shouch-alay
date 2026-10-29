import { AppError, handler } from '@/lib/http';
import { dispatch } from '@/lib/notify';
import { cancel, claim, done, stillHere } from '@/lib/queue';
import { stateFor } from '@/lib/state';

const ACTIONS = { cancel, claim, done, 'still-here': stillHere };

export const POST = handler<{ id: string; action: string }>({ rateLimit: true }, async ({ session, params }) => {
  if (!Object.hasOwn(ACTIONS, params.action)) throw new AppError(404, 'Unknown action.');
  dispatch(await ACTIONS[params.action as keyof typeof ACTIONS](session.uid, params.id));
  return stateFor(session.uid);
});
