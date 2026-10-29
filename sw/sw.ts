// Service worker: shows "It's your turn" / "Are you still there?" while the tab is in the
// background. Compiled to public/sw.js by `npm run sw`.

const sw = self as unknown as ServiceWorkerGlobalScope;

type PushMessage = { title: string; body: string; tag: string };

sw.addEventListener('push', (event) => {
  const msg = event.data?.json() as PushMessage | undefined;
  if (!msg) return;
  // requireInteraction: a turn is time-bound, so the notification stays until the user acts.
  event.waitUntil(sw.registration.showNotification(msg.title, { body: msg.body, tag: msg.tag, icon: '/icon.svg', requireInteraction: true }));
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const [open] = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (open) await open.focus();
      else await sw.clients.openWindow('/');
    })(),
  );
});
