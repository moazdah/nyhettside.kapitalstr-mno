import { db } from '../../../../lib/db';
import { runNewsRadar } from '../../../../lib/radar/news-radar';
import { prepareRadarCandidates } from '../../../../lib/radar/local-triage';
import { scorePendingRadarItems } from '../../../../lib/ai/score-radar-items';
import { syncLiveUpdatesFromRecentRadar } from '../../../../lib/live-updates';
import { syncNorgesBankFx } from '../../../../lib/sources/norges-bank';
import { syncGlobalMarkets } from '../../../../lib/sources/global-markets';
import { getEditorialSettings } from '../../../../lib/autopilot/editorial-settings';
import {
  ensureLivePulseSchema,
  getLivePulse,
  osloHour,
  startLivePulse,
} from '../../../../lib/live-pulse-state';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

async function failPulse(sql, pulseId, error) {
  const message = String(error?.message || 'Ukjent live-pulsfeil').slice(0, 1000);
  if (pulseId) {
    await sql`
      UPDATE live_pulse_runs
      SET status = 'error', stage = 'error', finished_at = NOW(), error = ${message}
      WHERE id = ${Number(pulseId)}
    `;
  }
  return message;
}

export async function GET(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const sql = db();
  await ensureLivePulseSchema(sql);
  const settings = await getEditorialSettings(sql);
  if (settings?.automationEnabled !== true) {
    return Response.json({ ok: true, skipped: true, reason: 'automation_disabled' });
  }

  const hour = osloHour();
  if (hour < 6 || hour > 23) {
    return Response.json({ ok: true, skipped: true, reason: 'outside_active_hours', osloHour: hour });
  }

  const url = new URL(request.url);
  const stage = url.searchParams.get('stage') || 'start';
  const pulseId = Number(url.searchParams.get('pulseId') || 0);

  try {
    if (stage === 'start') {
      const started = await startLivePulse(sql);
      if (!started.run) throw new Error('Kunne ikke opprette live-puls.');

      if (!started.created) {
        if (started.run.status === 'done') {
          return Response.json({
            ok: true,
            skipped: true,
            reason: 'slot_already_done',
            pulseId: Number(started.run.id),
            slot: started.run.scheduled_slot,
          });
        }
        return Response.json({
          ok: true,
          skipped: true,
          reason: 'slot_in_progress',
          pulseId: Number(started.run.id),
          slot: started.run.scheduled_slot,
        });
      }

      const radar = await runNewsRadar();
      const triage = await prepareRadarCandidates(sql, { maxCandidates: 30 });
      await sql`
        UPDATE live_pulse_runs
        SET stage = 'score',
            discovered = ${Number(radar.seen || 0)},
            inserted = ${Number(radar.inserted || 0)}
        WHERE id = ${Number(started.run.id)}
      `;

      return Response.json({
        ok: true,
        pulseId: Number(started.run.id),
        slot: started.run.scheduled_slot,
        stage: 'score',
        radar: {
          seen: radar.seen,
          inserted: radar.inserted,
          errors: radar.errors,
        },
        triage,
      });
    }

    if (!pulseId) {
      return Response.json({ ok: false, error: 'pulseId_required' }, { status: 400 });
    }

    const pulse = await getLivePulse(sql, pulseId);
    if (!pulse) return Response.json({ ok: false, error: 'pulse_not_found' }, { status: 404 });
    if (pulse.status === 'done') {
      return Response.json({ ok: true, skipped: true, reason: 'already_done', pulseId });
    }

    if (stage === 'score') {
      const scoring = await scorePendingRadarItems(15);
      await sql`
        UPDATE live_pulse_runs
        SET stage = 'publish',
            scored = scored + ${Number(scoring.scored || 0)}
        WHERE id = ${pulseId}
      `;

      return Response.json({ ok: true, pulseId, stage: 'publish', scoring });
    }

    if (stage === 'publish') {
      const [updatesResult, fxResult, globalResult] = await Promise.allSettled([
        syncLiveUpdatesFromRecentRadar({
          autoPublish: settings?.autoPublishEnabled === true,
          minScore: 60,
          maxNew: 4,
        }),
        syncNorgesBankFx(),
        syncGlobalMarkets(),
      ]);

      const updates = updatesResult.status === 'fulfilled'
        ? updatesResult.value
        : { created: 0, errors: [String(updatesResult.reason?.message || 'Nyhetsstrøm feilet')] };
      const fx = fxResult.status === 'fulfilled'
        ? { updated: fxResult.value.length, errors: [] }
        : { updated: 0, errors: [String(fxResult.reason?.message || 'Valutaoppdatering feilet')] };
      const globalMarkets = globalResult.status === 'fulfilled'
        ? globalResult.value
        : { updated: 0, errors: [String(globalResult.reason?.message || 'Markedsoppdatering feilet')] };

      const errors = [
        ...(updates.errors || []),
        ...(fx.errors || []),
        ...(globalMarkets.errors || []),
      ].slice(0, 12);

      await sql`
        UPDATE live_pulse_runs
        SET status = 'done',
            stage = 'done',
            finished_at = NOW(),
            updates_created = ${Number(updates.created || 0)},
            markets_updated = ${Number(fx.updated || 0) + Number(globalMarkets.updated || 0)},
            error = ${errors.length ? errors.join(' | ').slice(0, 1000) : null}
        WHERE id = ${pulseId}
      `;

      return Response.json({
        ok: true,
        pulseId,
        stage: 'done',
        updates,
        fx,
        globalMarkets,
        errors,
      });
    }

    return Response.json({ ok: false, error: 'unknown_stage' }, { status: 400 });
  } catch (error) {
    const message = await failPulse(sql, pulseId, error);
    console.error('Live pulse failed', error);
    return Response.json({ ok: false, pulseId: pulseId || null, error: message }, { status: 500 });
  }
}
