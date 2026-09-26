import { runEditorialJob } from '../../../../lib/engine/editorial';
import { slot } from '../../../../lib/engine/clock.mjs';
import { getEditorialSettings } from '../../../../lib/autopilot/editorial-settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

function osloContext(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  const hour = Number(value('hour') || -1);
  const slot = `${value('year')}-${value('month')}-${value('day')}T${String(hour).padStart(2, '0')}`;

  return { hour, slot };
}

export async function GET(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  if (process.env.NEWS_SCHEDULER === 'vercel') return Response.json({ok:true,skipped:true,stage:'done',reason:'scheduler_replaced'});

  const url = new URL(request.url);
  const runId = Number(url.searchParams.get('runId') || 0) || null;
  const discovery = url.searchParams.get('discovery') === '1';

  try {
    const settings = await getEditorialSettings();
    const oslo = osloContext();

    // Main kill switch: stop both new scheduled rounds and an already-running
    // scheduled round at the next step. Manual controls in /redaksjon still work.
    if (!settings.automationEnabled) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'automation_disabled',
        stage: 'done',
        runId,
        osloHour: oslo.hour,
        settings,
        checkedAt: new Date().toISOString(),
      });
    }

    // Only start a brand-new scheduled editorial round from 06:00 through 23:59 Oslo time.
    // Existing runs may finish even if the clock crosses the boundary.
    if (!runId && (oslo.hour < 6 || oslo.hour > 23)) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'outside_editorial_hours',
        stage: 'done',
        osloHour: oslo.hour,
        settings,
        checkedAt: new Date().toISOString(),
      });
    }

    const result = await runEditorialJob({
      discovery,
      runId,
      mode: 'scheduled',
      scheduledSlot: runId ? null : slot(new Date(),60),
    });

    return Response.json({
      ...result,
      scheduled: true,
      scheduledSlot: runId ? null : slot(new Date(),60),
      settings,
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
