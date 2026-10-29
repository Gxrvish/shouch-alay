import { clearLoginCookie, finishLogin, NotCompanyAccount, redirect } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    return await finishLogin(req);
  } catch (err) {
    const wrongAccount = err instanceof NotCompanyAccount;
    if (!wrongAccount) console.error('Sign-in failed:', (err as Error).message);
    return redirect(`/?error=${wrongAccount ? 'domain' : 'login'}`, [clearLoginCookie]);
  }
}
