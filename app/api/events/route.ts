import { subscribe } from '@/lib/hub';
import { handler } from '@/lib/http';
import { stateFor } from '@/lib/state';

export const dynamic = 'force-dynamic';
// Vercel stops a function after maxDuration (300 s is the Hobby ceiling). The stream ends a bit
// earlier and EventSource reconnects by itself, so clients never notice.
export const maxDuration = 300;
const STREAM_MS = (maxDuration - 20) * 1000;
const PING_MS = 25_000; // keeps proxies from closing a quiet connection

/** Server-Sent Events: the caller's view on connect, then again whenever it changes. */
export const GET = handler({}, async ({ req, session }) => {
  const first = JSON.stringify(await stateFor(session.uid));
  const encoder = new TextEncoder();
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop(); // the client is gone
        }
      };
      const unsubscribe = subscribe({ userId: session.uid, last: first, send: (json) => write(`data: ${json}\n\n`) });
      const ping = setInterval(() => write(': ping\n\n'), PING_MS);
      const end = setTimeout(() => {
        stop();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }, STREAM_MS);
      stop = () => {
        unsubscribe();
        clearInterval(ping);
        clearTimeout(end);
      };
      req.signal.addEventListener('abort', () => stop());
      write(`retry: 2000\ndata: ${first}\n\n`);
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' },
  });
});
