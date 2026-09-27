import { getEditorialSettings } from '../../../../lib/autopilot/editorial-settings';
import { runLiveStep } from '../../../../lib/engine/live';
import { runEditorialJob } from '../../../../lib/engine/editorial';
import { activeHours } from '../../../../lib/engine/clock.mjs';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(request) {
  if (!process.env.CRON_SECRET || request.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`) return Response.json({ok:false,error:'unauthorized'},{status:401});
  if (process.env.NEWS_SCHEDULER!=='vercel') return Response.json({ok:true,skipped:true,reason:'not_activated'});
  try {
    const settings=await getEditorialSettings();
    if (!settings.automationEnabled) return Response.json({ok:true,skipped:true,reason:'automation_disabled'});
    const results=await Promise.allSettled([
      activeHours()?runLiveStep({settings,resume:true}):Promise.resolve({skipped:true,reason:'outside_active_hours'}),
      runEditorialJob(),
    ]);
    const ok=results.every(r=>r.status==='fulfilled');
    return Response.json({ok,results:results.map(r=>r.status==='fulfilled'?r.value:{error:String(r.reason?.message||r.reason).slice(0,500)})},{status:ok?200:500});
  } catch(error) { return Response.json({ok:false,error:String(error.message).slice(0,500)},{status:500}); }
}
