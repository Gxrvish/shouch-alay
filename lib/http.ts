import { csrfOk, readSession, type Session } from './auth';
import { db } from './db';

/** An error whose message is safe to show the user, with the HTTP status to answer. */
export class AppError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Options = { admin?: boolean; rateLimit?: boolean };
type Context<P> = { req: Request; session: Session; params: P };

/**
 * Wraps an API route with what every call needs: a valid session, the CSRF token on anything but
 * GET, optional admin and per-user rate limit checks, and JSON errors.
 */
export function handler<P extends Record<string, string> = Record<string, never>>(
  options: Options,
  fn: (ctx: Context<P>) => Promise<unknown>,
) {
  return async (req: Request, route: { params: Promise<P> }): Promise<Response> => {
    try {
      const session = await readSession(req);
      if (!session) throw new AppError(401, 'Please sign in.');
      if (req.method !== 'GET' && !csrfOk(req, session)) throw new AppError(403, 'Invalid CSRF token.');
      if (options.admin && !session.admin) throw new AppError(403, 'Admins only.');
      if (options.rateLimit) await rateLimit(session.uid);
      const result = await fn({ req, session, params: await route.params });
      return result instanceof Response ? result : Response.json(result);
    } catch (err) {
      if (err instanceof AppError) return Response.json({ error: err.message }, { status: err.status });
      console.error(err);
      return Response.json({ error: 'Something went wrong.' }, { status: 500 });
    }
  };
}

export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Expected a JSON object.');
  return body as Record<string, unknown>;
}

const RATE_LIMIT_PER_MINUTE = 20;

/** Fixed one-minute window per user. Lives in Postgres because serverless instances share no memory. */
async function rateLimit(userId: string): Promise<void> {
  const { rows } = await db().query<{ hits: number }>(
    `INSERT INTO rate_limits (user_id, window_start, hits) VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (user_id, window_start) DO UPDATE SET hits = rate_limits.hits + 1
     RETURNING hits`,
    [userId],
  );
  if ((rows[0]?.hits ?? 0) > RATE_LIMIT_PER_MINUTE) throw new AppError(429, 'Too many requests, please slow down.');
}

export async function purgeRateLimits(): Promise<void> {
  await db().query(`DELETE FROM rate_limits WHERE window_start < date_trunc('minute', now())`);
}
