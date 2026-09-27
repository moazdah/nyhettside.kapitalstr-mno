import { db } from '../../../../lib/db';
import { watchFastTrack } from '../../../../lib/breaking/watch';
import { recordTick } from '../../../../lib/ops/alerts.mjs';
export const dynamic='force-dynamic';
export const maxDuration=60;
// All official fast-track sources. One failing source is reported per source
// (and escalated by /api/cron/ops) instead of failing the whole run.
export async function GET(request) {
 if(!process.env.CRON_SECRET||request.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`) return Response.json({ok:false,error:'unauthorized'},{status:401});
 const scheduler=new URL(request.url).searchParams.get('scheduler')||'github';
 if(scheduler==='github'&&process.env.NEWS_SCHEDULER==='vercel') return Response.json({ok:true,skipped:true,reason:'scheduler_replaced'});
 try {
  const sql=db();
  return Response.json({ok:true,...await recordTick(sql,'fast-track',scheduler,()=>watchFastTrack({sql}))});
 } catch(error) {return Response.json({ok:false,error:String(error.message).slice(0,500)},{status:503});}
}
