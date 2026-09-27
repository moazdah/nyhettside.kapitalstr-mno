import { db } from '../db';
import { runNewsRadar } from '../radar/news-radar';
import { prepareRadarCandidates } from '../radar/local-triage';
import { scorePendingRadarItems } from '../ai/score-radar-items';
import { syncLiveUpdatesFromRecentRadar } from '../live-updates';
import { syncNorgesBankFx } from '../sources/norges-bank';
import { syncGlobalMarkets } from '../sources/global-markets';
import { getLivePulse, startLivePulse } from '../live-pulse-state';
import { enqueue, claim, checkpoint, fail, nextJob } from './jobs.mjs';

const stages = ['discover','score','publish','markets','done'];
export async function runLiveStep({ pulseId = null, requestedStage = null, settings, resume = false } = {}) {
  const sql = db();
  let pending = resume ? await nextJob(sql,'live') : null;
  let pulse = pending ? await getLivePulse(sql,pending.payload.pulseId) : pulseId ? await getLivePulse(sql,pulseId) : (await startLivePulse(sql)).run;
  if (!pulse) throw new Error('LIVE_PULSE_NOT_FOUND');
  if (pulse.status === 'done') return {ok:true,skipped:true,reason:'already_done',pulseId:Number(pulse.id),stage:'done'};
  const job = await claim(sql,(pending || await enqueue(sql,'live',pulse.scheduled_slot,{pulseId:Number(pulse.id)})).id);
  if (!job) return {ok:true,skipped:true,reason:'busy_or_retry_wait',pulseId:Number(pulse.id),stage:pulse.stage};
  pulse = await getLivePulse(sql,pulse.id);
  const stage = stages.includes(pulse.stage) ? pulse.stage : 'discover';
  if (requestedStage && requestedStage !== stage) {
    await checkpoint(sql,job,{pulseId:Number(pulse.id)});
    return {ok:true,pulseId:Number(pulse.id),stage,reason:'stage_already_committed_or_not_ready'};
  }
  try {
    let details = {}, writes = [], next = stages[stages.indexOf(stage)+1];
    if (stage === 'discover') {
      const radar = await runNewsRadar({liveOnly:true});
      details = {radar,triage:await prepareRadarCandidates(sql,{maxCandidates:30})};
      if (radar.errors?.length && !radar.seen) throw new Error(radar.errors.join(' | '));
      writes.push(sql`UPDATE live_pulse_runs SET discovered=${Number(radar.seen||0)},inserted=${Number(radar.inserted||0)} WHERE id=${Number(pulse.id)}`);
    } else if (stage === 'score') {
      details.scoring = await scorePendingRadarItems(15);
      if (details.scoring.errors?.length) throw new Error(details.scoring.errors.join(' | '));
      writes.push(sql`UPDATE live_pulse_runs SET scored=scored+${Number(details.scoring.scored||0)} WHERE id=${Number(pulse.id)}`);
    } else if (stage === 'publish') {
      details.updates = await syncLiveUpdatesFromRecentRadar({autoPublish:settings.livePublishEnabled === true,minScore:60,maxNew:4,job});
      if (details.updates.failed) throw new Error(details.updates.errors.join(' | '));
      writes.push(sql`UPDATE live_pulse_runs SET updates_created=updates_created+${Number(details.updates.created||0)},error=${details.updates.errors?.join(' | ').slice(0,1000)||null} WHERE id=${Number(pulse.id)}`);
    } else if (stage === 'markets') {
      const results = await Promise.allSettled([syncNorgesBankFx(),syncGlobalMarkets()]);
      const errors = results.flatMap(r=>r.status==='rejected' ? [String(r.reason?.message||r.reason)] : r.value?.errors||[]);
      if (errors.length) throw new Error(errors.join(' | '));
      const count = results.reduce((sum,r)=>sum+Number(r.value?.updated ?? r.value?.length ?? 0),0);
      writes.push(sql`UPDATE live_pulse_runs SET markets_updated=${count} WHERE id=${Number(pulse.id)}`);
    }
    writes.push(sql`UPDATE live_pulse_runs SET stage=${next},status=${next==='done'?'done':'running'},
      error=CASE WHEN ${next==='done'} THEN NULL ELSE error END,
      finished_at=CASE WHEN ${next==='done'} THEN now() ELSE NULL END WHERE id=${Number(pulse.id)}`);
    await checkpoint(sql,job,{pulseId:Number(pulse.id)},{done:next==='done',writes});
    return {ok:true,pulseId:Number(pulse.id),stage:next,...details};
  } catch (error) {
    await fail(sql,job,error,[sql`UPDATE live_pulse_runs SET status='error',error=${String(error.message).slice(0,1000)} WHERE id=${Number(pulse.id)}`]);
    throw error;
  }
}
