import { db } from '../../../../lib/db';
import { getEditorialSettings } from '../../../../lib/autopilot/editorial-settings';
import { runLiveStep } from '../../../../lib/engine/live';
import { runEditorialJob } from '../../../../lib/engine/editorial';
import { activeHours } from '../../../../lib/engine/clock.mjs';
import { watchFastTrack } from '../../../../lib/breaking/watch';
import { enrichNext } from '../../../../lib/breaking/enrich';
import { evaluateOps, recordTick } from '../../../../lib/ops/alerts.mjs';
export const dynamic='force-dynamic';
export const maxDuration=300;
// Minute wake-up on Vercel (requires a plan with per-minute cron). One call runs
// the official fast track first, then one stored step of each other engine.
export async function GET(request) {
  if (!process.env.CRON_SECRET || request.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`) return Response.json({ok:false,error:'unauthorized'},{status:401});
  if (process.env.NEWS_SCHEDULER!=='vercel') return Response.json({ok:true,skipped:true,reason:'not_activated'});
  try {
    const sql=db();
    const settings=await getEditorialSettings(sql);
    if (!settings.automationEnabled) return Response.json({ok:true,skipped:true,reason:'automation_disabled'});
    const fastTrack=await recordTick(sql,'fast-track','vercel',()=>watchFastTrack({sql})).catch(error=>({error:String(error.message).slice(0,500)}));
    const results=await Promise.allSettled([
      enrichNext(sql),
      activeHours()?runLiveStep({settings,resume:true}):Promise.resolve({skipped:true,reason:'outside_active_hours'}),
      runEditorialJob(),
      evaluateOps(sql,{automationEnabled:true}),
    ]);
    const ok=!fastTrack.error&&results.every(r=>r.status==='fulfilled');
    return Response.json({ok,fastTrack,results:results.map(r=>r.status==='fulfilled'?r.value:{error:String(r.reason?.message||r.reason).slice(0,500)})},{status:ok?200:500});
  } catch(error) { return Response.json({ok:false,error:String(error.message).slice(0,500)},{status:500}); }
}
