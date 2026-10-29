import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { config, required } from './config';
import { db } from './db';

export const ALLOWED_DOMAIN = 'odoo.com';
export const SESSION_COOKIE = 'loo_session';
const LOGIN_COOKIE = 'loo_login';
const SESSION_TTL_SEC = 14 * 24 * 3600;
const LOGIN_TTL_SEC = 600;

/** What the session cookie carries: an opaque user id, never the email. */
export type Session = { uid: string; csrf: string; admin: boolean };

// --- Signed cookies --------------------------------------------------------------------------

function key(): Uint8Array {
  const secret = required('SESSION_SECRET');
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return new TextEncoder().encode(secret);
}

function sign(payload: JWTPayload, purpose: string, ttlSec: number): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(purpose)
    .setExpirationTime(`${ttlSec}s`)
    .sign(key());
}

async function verify(token: string | undefined, purpose: string): Promise<JWTPayload | null> {
  if (!token) return null;
  try {
    return (await jwtVerify(token, key(), { algorithms: ['HS256'], audience: purpose })).payload;
  } catch {
    return null;
  }
}

function cookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const pair of req.headers.get('cookie')?.split(';') ?? []) {
    const [k, ...v] = pair.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

// --- Sessions --------------------------------------------------------------------------------

export async function createSessionCookie(session: Session): Promise<string> {
  const token = await sign({ sub: session.uid, csrf: session.csrf, admin: session.admin }, 'session', SESSION_TTL_SEC);
  return cookie(SESSION_COOKIE, token, SESSION_TTL_SEC);
}

export const clearSessionCookie = cookie(SESSION_COOKIE, '', 0);

/** Session from the raw cookie value (server components read it with next/headers). */
export async function sessionFromToken(token: string | undefined): Promise<Session | null> {
  const payload = await verify(token, 'session');
  if (typeof payload?.sub !== 'string' || typeof payload.csrf !== 'string') return null;
  return { uid: payload.sub, csrf: payload.csrf, admin: payload.admin === true };
}

export const readSession = (req: Request) => sessionFromToken(readCookie(req, SESSION_COOKIE));

/** Synchronizer token: the page gets it from the session; mutating calls echo it in a header. */
export const csrfOk = (req: Request, session: Session) => safeEqual(req.headers.get('x-csrf-token') ?? '', session.csrf);

/** The caller's own email, for their profile. Never used in booking queries. */
export async function emailOf(uid: string): Promise<string | null> {
  const { rows } = await db().query<{ email: string }>('SELECT email FROM users WHERE id = $1', [uid]);
  return rows[0]?.email ?? null;
}

/** Creates or updates the user and returns their session cookie. */
export async function signIn(googleSub: string, email: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO users (google_sub, email) VALUES ($1, $2)
     ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [googleSub, email],
  );
  const uid = rows[0]!.id; // an upsert with RETURNING always yields the row
  return createSessionCookie({ uid, csrf: randomBytes(32).toString('base64url'), admin: config.adminEmails.includes(email) });
}

// --- Google OpenID Connect -------------------------------------------------------------------

// From https://accounts.google.com/.well-known/openid-configuration
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const redirectUri = () => `${config.baseUrl}/auth/callback`;
const randomToken = () => randomBytes(32).toString('base64url');

export class NotCompanyAccount extends Error {}

export const clearLoginCookie = cookie(LOGIN_COOKIE, '', 0);

/** Sends the browser to Google; state, nonce and PKCE verifier wait in a short-lived signed cookie. */
export async function startLogin(): Promise<Response> {
  const login = { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: required('GOOGLE_CLIENT_ID'),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email',
    state: login.state,
    nonce: login.nonce,
    code_challenge: createHash('sha256').update(login.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    hd: ALLOWED_DOMAIN, // only pre-filters Google's account picker; assertCompanyAccount enforces it
    prompt: 'select_account',
  }).toString();
  return redirect(url.href, [cookie(LOGIN_COOKIE, await sign(login, 'login', LOGIN_TTL_SEC), LOGIN_TTL_SEC)]);
}

/** Handles Google's redirect back. Throws unless every check passes. */
export async function finishLogin(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const login = await verify(readCookie(req, LOGIN_COOKIE), 'login');
  const code = params.get('code');
  if (!login || !code || params.get('state') !== login.state) throw new Error('Login state mismatch');

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: required('GOOGLE_CLIENT_ID'),
      client_secret: required('GOOGLE_CLIENT_SECRET'),
      code_verifier: String(login.verifier),
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const { id_token: idToken } = (await res.json()) as { id_token?: string };
  if (!idToken) throw new Error('Google returned no ID token');

  // Signature against Google's published keys, issuer, audience and expiry...
  const { payload } = await jwtVerify(idToken, GOOGLE_KEYS, {
    issuer: GOOGLE_ISSUERS,
    audience: required('GOOGLE_CLIENT_ID'),
  });
  // ...that it answers this login attempt...
  if (payload.nonce !== login.nonce || typeof payload.sub !== 'string') throw new Error('ID token does not match this login');
  // ...and that it is a company account.
  const email = assertCompanyAccount(payload);
  return redirect('/', [await signIn(payload.sub, email), clearLoginCookie]);
}

/** The domain rule, applied to verified ID token claims. Returns the normalized email. */
export function assertCompanyAccount(claims: JWTPayload): string {
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (claims.email_verified !== true || claims.hd !== ALLOWED_DOMAIN || !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    throw new NotCompanyAccount();
  }
  return email;
}
