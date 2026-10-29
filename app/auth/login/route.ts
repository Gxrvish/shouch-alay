import { startLogin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return startLogin();
}
