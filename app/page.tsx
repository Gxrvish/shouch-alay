import { cookies } from 'next/headers';
import { ALLOWED_DOMAIN, emailOf, SESSION_COOKIE, sessionFromToken } from '@/lib/auth';
import { config } from '@/lib/config';
import LooApp from './LooApp';

const LOGIN_ERRORS: Record<string, string> = {
  domain: `Only verified @${ALLOWED_DOMAIN} Google accounts can use Loo Queue.`,
  login: 'Sign-in failed. Please try again.',
};

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await sessionFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  const email = session ? await emailOf(session.uid) : null;
  if (!session || !email) {
    const { error } = await searchParams;
    return <SignIn error={typeof error === 'string' ? (LOGIN_ERRORS[error] ?? LOGIN_ERRORS.login) : undefined} />;
  }
  return <LooApp email={email} isAdmin={session.admin} csrfToken={session.csrf} vapidPublicKey={process.env.VAPID_PUBLIC_KEY ?? null} />;
}

function SignIn({ error }: { error?: string }) {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-3xl font-bold">Loo Queue</h1>
      <p className="mt-2 text-slate-600">See whether a toilet is free, and queue for it.</p>
      {error && (
        <p role="alert" className="mt-6 rounded-xl bg-rose-100 px-4 py-3 text-rose-900">
          {error}
        </p>
      )}
      <a href="/auth/login" className="btn btn-primary mt-8">
        Sign in with Google
      </a>
      <p className="mt-3 text-sm text-slate-600">@{ALLOWED_DOMAIN} accounts only.</p>

      {config.devLogin && (
        <form action="/auth/dev" className="mt-12 border-t border-slate-300 pt-6 text-left">
          <label htmlFor="dev-email" className="text-sm font-medium">
            Developer sign-in (local only)
          </label>
          <div className="mt-2 flex gap-2">
            <input id="dev-email" name="email" type="email" required placeholder={`alice@${ALLOWED_DOMAIN}`} className="field" />
            <button className="btn btn-secondary">Sign in</button>
          </div>
        </form>
      )}
    </main>
  );
}
