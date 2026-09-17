import { syncNorgesBankFx } from '../../../../lib/sources/norges-bank';
import { syncNorgesBankPolicyRate } from '../../../../lib/sources/norges-bank-policy-rate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const [fx, policyRate] = await Promise.all([
      syncNorgesBankFx(),
      syncNorgesBankPolicyRate(),
    ]);
    return Response.json({
      ok: true,
      source: 'Norges Bank',
      fx: fx.map((r) => ({ symbol: r.symbol, value: r.latest, changePct: r.changePct })),
      policyRate,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Norges Bank sync failed', error);
    return Response.json({ ok: false, error: error?.message || 'sync failed' }, { status: 500 });
  }
}
