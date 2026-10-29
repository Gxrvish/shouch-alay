# Architecture

Loo Queue runs on **Vercel** (Next.js App Router, Fluid compute) with **Neon** Postgres. That
platform choice drives most decisions below: there are no long-running processes, every
function stops after at most 300 s (Hobby) or 800 s (Pro), and Neon's connection pooler does not
support `LISTEN/NOTIFY`.

```
 phone / laptop                       Vercel                                 Neon Postgres
┌──────────────┐  POST actions   ┌──────────────────────┐   tx + row lock   ┌─────────────────┐
│  Next.js UI  │ ──────────────▶ │ route handlers       │ ────────────────▶ │ toilets         │
│              │                 │  └ lib/queue.ts      │                   │ bookings        │
│ EventSource  │ ◀── SSE ─────── │ /api/events          │ ◀─ poll every 2 s │ users           │
│              │                 │  └ lib/hub.ts (tick) │                   │ push_subscript. │
│ service      │ ◀── Web Push ── │ lib/notify.ts        │                   │ rate_limits     │
│ worker       │                 │ /api/cron/tick ◀──── Vercel Cron, every minute           │
└──────────────┘                 └──────────────────────┘                   └─────────────────┘
```

## Decisions and trade-offs

### Real time: Server-Sent Events, not WebSocket

Updates only flow server → client; every action is a normal `POST` that gets the session check,
CSRF token, rate limit and idempotency like any other request. SSE gives us that one-way stream
over plain HTTP with cookies, and `EventSource` reconnects by itself. A WebSocket would need its
own auth and origin checks, its own reconnect logic, and it hits the same function time limits.

On Vercel a stream cannot outlive the function, so `/api/events` ends after ~280 s and the
browser reconnects within 2 s. Closing the tab or losing the network only closes the stream;
bookings are untouched. Only the claim window, the occupancy check and an explicit cancel remove
anyone from a queue.

**Fan-out.** Instances share no memory and `LISTEN/NOTIFY` is unavailable through Neon's pooler,
so each instance with open streams polls Postgres every 2 s (`lib/hub.ts`) and sends each
listener its view only when it changed. Measured locally: an action shows up on other screens
within 0.3–1.6 s. The acting user gets the new state immediately in the response. If the number
of instances or the latency budget grows, replace the poll with a pub/sub service (Ably, Pusher)
or move to a long-lived host where `LISTEN/NOTIFY` works.

### Deadlines: stored in the database, applied by a polling worker, no queue library

Every timer is a `deadline` column. `processDueDeadlines()` applies whatever is overdue: an
unclaimed turn becomes `EXPIRED` and passes to the next person, an occupancy past
`MAX_OCCUPANCY_SEC` gets "Are you still there?", an unanswered check becomes `AUTO_RELEASED`.
Nothing lives in memory, so restarts and deployments lose nothing.

It runs from two places, both safe to run concurrently because each toilet is re-checked under
its row lock:

1. **Vercel Cron** calls `/api/cron/tick` every minute. This is the guaranteed scheduler and also
   purges old data.
2. **Each SSE instance's 2 s tick.** While anyone has the app open, deadlines are applied within
   seconds instead of within a minute.

A queue library such as pg-boss needs a long-running worker (Vercel has none) and would duplicate
the deadline into a second job table that must be kept in sync with the booking. Polling one
indexed column (`bookings_due`) is simpler and cannot drift. Actions also check deadlines
themselves: "I'm going in" after the window is refused even if the worker has not run yet.

### Locking: one row lock per toilet, unique indexes as backstops

Every write to a toilet's queue runs in a transaction that first takes
`SELECT ... FROM toilets WHERE id = $1 FOR UPDATE` (`onToilet` in `lib/queue.ts`). All changes to
one queue are therefore serialized: of two simultaneous "Book" taps on a free toilet, the first
becomes `ACTIVE` and the second sees an occupied toilet and becomes `WAITING`. Different toilets
never block each other. The integration test fires concurrent requests through the real route
handlers, and fails if the lock is removed.

Two partial unique indexes make the invariants hold even if code is wrong:

- `bookings_one_open_per_user`: one open booking per user across all toilets. Two toilets lock
  different rows, so this index is what stops one user booking both at the same instant.
- `bookings_one_holder_per_toilet`: at most one `NOTIFIED` or `ACTIVE` booking per toilet.

Row locks over advisory locks: the lock is tied to the row it protects, needs no key scheme, and
works through a transaction-mode pooler. Row locks over `SERIALIZABLE`: no retry loop on
serialization failures, and a waiting request simply queues for a few milliseconds.

### State machine

`TRANSITIONS` in `lib/queue.ts` is the single table of allowed status changes; `NEW` is the
pseudo-state of a booking being created (`WAITING`, or `ACTIVE` when the toilet is free and nobody
waits). Only `insert()` and `move()` write a status, and both consult the table. `CHECK`
constraints tie timestamps to statuses (only `NOTIFIED`/`ACTIVE` have a deadline, only final
statuses have `ended_at`).

"I'm still here" is not a status change: it restarts the occupancy timer, capped at
`MAX_STAY_SEC` after going in so nobody can hold a toilet indefinitely.

**Idempotency** is natural, no idempotency keys needed: an action whose target status is already
reached is a no-op (a second "I'm done" returns 200 and notifies nobody), and "Book" on the toilet
you already booked returns that booking.

### Auth and request safety

- **Google OpenID Connect**, implemented in ~80 lines with `jose` instead of Auth.js: authorization
  code flow with PKCE, `state` and `nonce`. The ID token is verified against Google's published
  keys (signature, issuer, audience, expiry), then the server requires `email_verified === true`,
  `hd === "odoo.com"` and an `@odoo.com` email. The `hd` parameter sent to Google only pre-filters
  the account picker.
- **Session**: an HS256-signed cookie (`HttpOnly; Secure; SameSite=Lax`, 14 days) carrying only
  the opaque user id, a CSRF token and the admin flag.
- **CSRF**: synchronizer token. The page receives it from the session; every non-GET request must
  echo it in `x-csrf-token`, compared in constant time.
- **Rate limit**: 20 booking actions per user per minute, counted in Postgres, because per-instance
  memory is useless on serverless.

### Notifications

Push and email are sent after the transaction commits; on Vercel `waitUntil` keeps the function
alive for it without delaying the response. Payloads contain only the recipient's own situation
and the toilet name. Push endpoints are restricted to the browsers' push services, so stored
subscriptions cannot make the server call arbitrary URLs. Delivery is best effort: a push that
fails is not retried (the in-app view still shows the turn); add an outbox table if that matters.

### Swaps from the suggested stack

| Suggested | Used | Why |
|---|---|---|
| Drizzle / Prisma | `pg` + SQL migrations | The interesting code is locking and partial indexes, which read best as SQL. Neon works with plain `pg` over its pooled URL. |
| Auth.js | Small OIDC flow with `jose` | Full control over the domain checks and over what the session holds (an opaque id, never the email). |
| pg-boss / worker process | Vercel Cron + SSE ticks | No long-running processes on Vercel. |
| Docker Compose | Removed | Not needed: local Postgres or a Neon branch. |
