# Loo Queue

See whether an office toilet is free, and queue for it. Sign in with your @odoo.com Google
account, tap **Book**, and get an "It's your turn" notification when the toilet frees up.
Nobody can see who is inside or who is waiting.

Next.js on Vercel, Postgres on Neon. Design notes and trade-offs: [ARCHITECTURE.md](ARCHITECTURE.md).

## Run locally

Needs Node 20.9+ and a Postgres 13+ database (a local one, or a Neon branch).

1. `npm install`
2. `cp .env.example .env.local`, then set at least `DATABASE_URL` and `SESSION_SECRET`.
   Keep `DEV_LOGIN=1` to sign in without Google.
3. `npm run migrate && npm run seed` (creates the tables and four toilets)
4. `npm run dev`, open http://localhost:3000 and use **Developer sign-in** with any
   `@odoo.com` address. Use a second browser profile to be a second person.

Add your address to `ADMIN_EMAILS` to see **Manage toilets** (sign out and back in after
changing it).

Deadlines are applied every 2 s while the app is open. With the app closed, the cron job does it;
to imitate it locally: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/tick`.

## Tests

```sh
createdb loo_queue_test
TEST_DATABASE_URL='postgresql:///loo_queue_test?host=/var/run/postgresql' npm test
```

The database is wiped before each test, so never point `TEST_DATABASE_URL` at real data. Without
it, only the unit tests run. Coverage: every pair of the state machine, the account checks, the
concurrent-booking race (through the real route handlers), claim-window expiry, forgotten
sign-outs, idempotent retries, anonymity of responses, CSRF, rate limiting and the 24 h purge.

## Deploy on Vercel with Neon

1. **Database.** This repo is linked to the Neon project `shouch-alay` (`.neon`, `neon.ts`).
   `neon env pull` writes `DATABASE_URL` (pooled, for the app) and `DATABASE_URL_UNPOOLED`
   (direct, used by `npm run migrate`) into `.env.local`; copy both into the Vercel project.
2. **Google sign-in.** In Google Cloud Console, create an OAuth client of type *Web application*
   with the redirect URI `https://<your-domain>/auth/callback`. Set the OAuth consent screen to
   *Internal*, so Google itself only admits odoo.com accounts; the server checks again anyway.
3. **Push keys.** `npx web-push generate-vapid-keys`.
4. **Environment.** Set the variables below in the Vercel project.
5. **Schema.** `npm run migrate && npm run seed` (reads `.env.local`). Run `migrate` again whenever
   `migrations/` changes; try it on a Neon branch first (`neon checkout <name>`).
6. **Deploy.** `vercel deploy --prod`, or push to the connected Git repository.

**Cron and plan.** `vercel.json` runs `/api/cron/tick` every minute, which needs the **Pro** plan.
On Hobby, cron jobs may run at most once a day and a deployment with this schedule fails. On Hobby,
change the schedule to `0 3 * * *` (daily purge) and have an external scheduler such as
cron-job.org call `https://<your-domain>/api/cron/tick` every minute with the header
`Authorization: Bearer <CRON_SECRET>`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string (Neon: pooled) |
| `SESSION_SECRET` | required | Signs session cookies, 32+ characters |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | required | Google OAuth client |
| `CRON_SECRET` | required | Bearer token for `/api/cron/tick` |
| `BASE_URL` | Vercel production domain, else `http://localhost:3000` | Public URL, used for the OAuth redirect |
| `ADMIN_EMAILS` | none | Comma-separated admins (toilet management only) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | push off | Web Push key pair |
| `VAPID_SUBJECT` | required with VAPID keys | `mailto:` contact for push services |
| `CLAIM_WINDOW_SEC` | `120` | Time to tap "I'm going in" once notified |
| `MAX_OCCUPANCY_SEC` | `900` | Time inside before "Are you still there?" |
| `GRACE_SEC` | `120` | Time to answer before the toilet is released |
| `MAX_STAY_SEC` | `1800` | Hard limit on one visit; "I'm still here" cannot extend past it |
| `EMAIL_NOTIFICATIONS` | `false` | Email when push cannot be delivered |
| `SMTP_URL`, `EMAIL_FROM` | none | SMTP server and sender, if email is on |
| `DEV_LOGIN` | off | `1` enables password-less sign-in under `npm run dev` only |

## What "anonymous" means here

**Other users cannot see who is in a toilet or in a queue.** Every API response and every live
update contains only each toilet's status and queue length, plus the caller's own booking and
position. Notifications describe only the recipient's own turn. Admins can add, rename, close and
reopen toilets; there is no screen or endpoint that shows who booked what.

**The server is not anonymous, and does not claim to be.** Bookings reference an opaque random user
id, never the email, but the `users` table maps that id to the Google account and email, and the
session cookie carries the id. So whoever operates the database (admins of the Vercel project and
Neon account, the providers themselves, or anyone they are compelled to hand data to) can link a
booking to a person:

- for as long as the booking row exists: up to 24 h after it ends (purged by the cron job; on
  Hobby with a daily purge, up to 48 h);
- through `rate_limits`, which records a user id per minute of activity and is cleared every minute;
- through `push_subscriptions`, which links a device's push endpoint to a user until they sign out
  on that device.

After the purge, all that remains is each toilet's average visit length. The app never logs emails
or user ids with booking events, but Vercel's own request logs record request paths (which contain
booking ids) and may record client IPs. If email fallback is on, the recipient's address goes to
your SMTP provider.

And the obvious one: colleagues can see who walks to the toilet. In a small office, queue counts
and timing can hint at who is waiting; the app cannot hide that.

## Abuse limits

- One booking per person across all toilets, enforced by the database.
- A turn not claimed within `CLAIM_WINDOW_SEC` passes to the next person.
- A forgotten "I'm done" is caught by "Are you still there?" after `MAX_OCCUPANCY_SEC` and released
  after `GRACE_SEC`; answering "I'm still here" cannot hold a toilet beyond `MAX_STAY_SEC`.
- 20 booking actions per person per minute.
- The app only informs, it locks no doors: if a toilet shown as occupied is clearly empty, walk in.

## Notes

- **iPhone**: iOS delivers Web Push only to web apps added to the Home Screen (Share → Add to Home
  Screen), iOS 16.4 or later. Android and desktop browsers work from the tab.
- Notification permission is requested the first time you have to wait in a queue, not before.
- `npm run typecheck` checks the app and the service worker; `npm run build` runs on Vercel.

## Layout

```
lib/queue.ts     state machine, actions, deadline worker (the core)
lib/state.ts     per-caller views (what the API is allowed to show)
lib/hub.ts       live updates for SSE streams
lib/auth.ts      Google OIDC, sessions, CSRF
lib/notify.ts    Web Push and email fallback
app/api/…        route handlers; app/LooApp.tsx is the whole UI
sw/sw.ts         service worker, compiled to public/sw.js
migrations/      SQL schema
```
