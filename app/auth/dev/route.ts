import { ALLOWED_DOMAIN, redirect, signIn } from '@/lib/auth';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/** Local development only (`next dev` with DEV_LOGIN=1): sign in as any company address, no Google. */
export async function GET(req: Request): Promise<Response> {
  if (!config.devLogin) return new Response('Not found', { status: 404 });
  const email = new URL(req.url).searchParams.get('email')?.trim().toLowerCase() ?? '';
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) return new Response(`Use an @${ALLOWED_DOMAIN} address`, { status: 400 });
  return redirect('/', [await signIn(`dev:${email}`, email)]);
}
