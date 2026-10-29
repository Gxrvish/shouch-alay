import { waitUntil } from '@vercel/functions';
import nodemailer, { type Transporter } from 'nodemailer';
import webpush from 'web-push';
import { config, required } from './config';
import { db } from './db';
import { AppError } from './http';
import type { Notice } from './queue';

type Message = { title: string; body: string; tag: string };

const minutes = (sec: number) => `${Math.ceil(sec / 60)} min`;

// Only the recipient's own situation, never anyone else's.
function message(n: Notice): Message {
  return n.kind === 'your-turn'
    ? { title: "It's your turn", body: `${n.toiletName} is yours. Tap “I'm going in” within ${minutes(config.claimWindowSec)}.`, tag: 'loo-turn' }
    : { title: 'Are you still there?', body: `Tap “I'm still here”, or you'll be signed out of ${n.toiletName} in ${minutes(config.graceSec)}.`, tag: 'loo-still-there' };
}

/**
 * Sends after the response is out; on Vercel, waitUntil keeps the function alive until done.
 * ponytail: best effort, no retry; add an outbox table if missed pushes ever matter.
 */
export function dispatch(notices: Notice[]): void {
  if (notices.length) waitUntil(sendNotices(notices));
}

/** Web Push to all of the recipient's devices; email only if that fails and email is enabled. Never throws. */
export async function sendNotices(notices: Notice[]): Promise<void> {
  for (const n of notices) {
    try {
      const msg = message(n);
      const ttlSec = n.kind === 'your-turn' ? config.claimWindowSec : config.graceSec;
      if (!(await push(n.userId, msg, ttlSec)) && config.emailNotifications) await email(n.userId, msg);
    } catch (err) {
      // Deliberately terse: addresses must never end up in logs next to booking events.
      console.error(`Could not deliver a ${n.kind} notification (${(err as Error).name})`);
    }
  }
}

async function push(userId: string, msg: Message, ttlSec: number): Promise<boolean> {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  const vapidDetails = { subject: required('VAPID_SUBJECT'), publicKey, privateKey };

  const { rows } = await db().query<{ endpoint: string; p256dh: string; auth: string }>(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId],
  );
  const results = await Promise.allSettled(
    rows.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), {
        TTL: ttlSec, // a "your turn" that arrives after the window is useless
        urgency: 'high',
        vapidDetails,
      }),
    ),
  );
  // Push services answer 404/410 for subscriptions the browser has dropped; forget those.
  const gone = rows.filter((_, i) => {
    const result = results[i];
    return result?.status === 'rejected' && [404, 410].includes((result.reason as { statusCode?: number }).statusCode ?? 0);
  });
  if (gone.length) await db().query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1)', [gone.map((s) => s.endpoint)]);
  return results.some((r) => r.status === 'fulfilled');
}

let mailer: Transporter | undefined;

async function email(userId: string, msg: Message): Promise<void> {
  const { rows } = await db().query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
  if (!rows[0]) return;
  mailer ??= nodemailer.createTransport(required('SMTP_URL'));
  await mailer.sendMail({ from: required('EMAIL_FROM'), to: rows[0].email, subject: msg.title, text: msg.body });
}

// We POST to whatever endpoint is stored, so only accept real browser push services.
const PUSH_SERVICE = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

function isPushService(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_SERVICE.test(url.hostname);
  } catch {
    return false;
  }
}

/** Forgets the caller's subscription for this device (on sign-out). */
export async function deleteSubscription(userId: string, endpoint: unknown): Promise<void> {
  if (typeof endpoint === 'string') await db().query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, userId]);
}

/** Stores a browser's PushSubscription (its toJSON() form) for the caller. */
export async function saveSubscription(userId: string, body: Record<string, unknown>): Promise<void> {
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const { endpoint } = body;
  const { p256dh, auth } = keys;
  if (
    typeof endpoint !== 'string' || endpoint.length > 1000 || !isPushService(endpoint) ||
    typeof p256dh !== 'string' || p256dh.length > 200 ||
    typeof auth !== 'string' || auth.length > 100
  ) {
    throw new AppError(400, 'Invalid push subscription.');
  }
  await db().query(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [endpoint, userId, p256dh, auth],
  );
}
