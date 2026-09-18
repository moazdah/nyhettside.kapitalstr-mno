import { runAutopilotStep } from '../../../../lib/autopilot/autopilot';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

function osloHour() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || -1);
}

export async function GET(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const runId = Number(url.searchParams.get('runId') || 0) || null;
  const discovery = url.searchParams.get('discovery') === '1';

  // Only start a brand-new scheduled editorial round from 06:00 through 23:59 Oslo time.
  // Existing runs may finish even if the clock crosses the boundary.
  if (!runId) {
    const hour = osloHour();
    if (hour < 6 || hour > 23) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'outside_editorial_hours',
        osloHour: hour,
      });
    }
  }

  try {
    const result = await runAutopilotStep({
      discovery,
      runId,
      mode: 'scheduled',
    });

    return Response.json({
      ...result,
      scheduled: true,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Editorial autopilot cron failed', error);
    return Response.json({
      ok: false,
      error: String(error?.message || 'editorial autopilot failed').slice(0, 500),
    }, { status: 500 });
  }
}
