import { getEditorialSettings } from '../../../../lib/autopilot/editorial-settings';
import { activeHours } from '../../../../lib/engine/clock.mjs';
import { runLiveStep } from '../../../../lib/engine/live';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request) {
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ok:false,error:'unauthorized'},{status:401});
  // Explicit cutover prevents two schedulers from owning production simultaneously.
  if (process.env.NEWS_SCHEDULER === 'vercel') return Response.json({ok:true,skipped:true,reason:'scheduler_replaced'});
  try {
    const settings = await getEditorialSettings();
    if (!settings.automationEnabled) return Response.json({ok:true,skipped:true,reason:'automation_disabled'});
    const url = new URL(request.url), pulseId = Number(url.searchParams.get('pulseId')) || null;
    if (!pulseId && !activeHours()) return Response.json({ok:true,skipped:true,reason:'outside_active_hours'});
    const stage = url.searchParams.get('stage') || 'start';
    if (!['start','score','publish','markets'].includes(stage)) return Response.json({ok:false,error:'unknown_stage'},{status:400});
    if (stage !== 'start' && !pulseId) return Response.json({ok:false,error:'pulseId_required'},{status:400});
    return Response.json(await runLiveStep({pulseId,requestedStage:stage==='start'?null:stage,settings,resume:stage==='start'}));
  } catch (error) {
    console.error('Live pulse failed',error);
    return Response.json({ok:false,error:String(error.message).slice(0,500)},{status:500});
  }
}
