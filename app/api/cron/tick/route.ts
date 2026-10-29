import { safeEqual } from '@/lib/auth';
import { required } from '@/lib/config';
import { purgeRateLimits } from '@/lib/http';
import { sendNotices } from '@/lib/notify';
import { processDueDeadlines, purgeFinished } from '@/lib/queue';

export const dynamic = 'force-dynamic';

/**
 * The scheduled worker. Vercel Cron (vercel.json) calls it every minute with
 * `Authorization: Bearer $CRON_SECRET`; deadlines live in the database, so nothing is lost
 * between runs or deployments.
 */
export async function GET(req: Request): Promise<Response> {
  if (!safeEqual(req.headers.get('authorization') ?? '', `Bearer ${required('CRON_SECRET')}`)) {
    return new Response('Unauthorized', { status: 401 });
  }
  await sendNotices(await processDueDeadlines());
  const purged = await purgeFinished();
  await purgeRateLimits();
  return Response.json({ purged });
}
