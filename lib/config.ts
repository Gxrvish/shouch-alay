/**
 * Environment configuration. Tunables are read once; secrets are read where they are used
 * (`required`), so `next build` works without them.
 */

function seconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number of seconds`);
  return value;
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const maxOccupancySec = seconds('MAX_OCCUPANCY_SEC', 900);

export const config = {
  /** How long a notified user has to tap "I'm going in". */
  claimWindowSec: seconds('CLAIM_WINDOW_SEC', 120),
  /** Time inside after which we ask "Are you still there?". */
  maxOccupancySec,
  /** Hard limit: past this, "I'm still here" no longer extends the stay, so nobody can squat a toilet. */
  maxStaySec: Math.max(seconds('MAX_STAY_SEC', 1800), maxOccupancySec),
  /** Time to answer "Are you still there?" before the toilet is released. */
  graceSec: seconds('GRACE_SEC', 120),
  baseUrl: process.env.BASE_URL ?? (vercelUrl ? `https://${vercelUrl}` : 'http://localhost:3000'),
  adminEmails: (process.env.ADMIN_EMAILS ?? '').toLowerCase().split(',').map((e) => e.trim()).filter(Boolean),
  emailNotifications: process.env.EMAIL_NOTIFICATIONS === 'true',
  /** Password-less sign-in for local development. A production build can never enable it. */
  devLogin: process.env.NODE_ENV === 'development' && process.env.DEV_LOGIN === '1',
};
