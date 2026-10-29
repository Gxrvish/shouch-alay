import { sendNotices } from './notify';
import { processDueDeadlines } from './queue';
import { snapshot, viewFor } from './state';

/** One open SSE stream. `last` is the JSON it was last sent, so unchanged views are skipped. */
export type Listener = { userId: string; last: string; send: (json: string) => void };
type Hub = { listeners: Set<Listener>; timer: NodeJS.Timeout | undefined; ticking: boolean };

// ponytail: per-instance 2 s DB poll; swap for pub/sub (Ably, Pusher) or LISTEN/NOTIFY on a long-lived host if instances or latency grow.
const TICK_MS = 2000;

// One hub per server instance. Serverless instances share nothing, and Neon's pooler does not
// support LISTEN/NOTIFY, so each instance polls Postgres while it has listeners. The same tick
// advances deadlines between cron runs, which keeps claim windows prompt while anyone is online.
const cache = globalThis as typeof globalThis & { looHub?: Hub };
const hub = (cache.looHub ??= { listeners: new Set(), timer: undefined, ticking: false });

export function subscribe(listener: Listener): () => void {
  hub.listeners.add(listener);
  hub.timer ??= setInterval(tick, TICK_MS);
  return () => {
    hub.listeners.delete(listener);
    if (hub.listeners.size > 0) return;
    clearInterval(hub.timer);
    hub.timer = undefined;
  };
}

async function tick(): Promise<void> {
  if (hub.ticking) return; // a slow round trip must not stack ticks
  hub.ticking = true;
  try {
    await sendNotices(await processDueDeadlines());
    const snap = await snapshot();
    for (const listener of hub.listeners) {
      const json = JSON.stringify(viewFor(snap, listener.userId));
      if (json === listener.last) continue;
      listener.last = json;
      listener.send(json);
    }
  } catch (err) {
    console.error('Live update failed:', (err as Error).message);
  } finally {
    hub.ticking = false;
  }
}
