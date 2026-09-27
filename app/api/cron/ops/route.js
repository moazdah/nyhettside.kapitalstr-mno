import { db } from '../../../../lib/db';
import { getEditorialSettings } from '../../../../lib/autopilot/editorial-settings';
import { evaluateOps, notifyAlerts, latencyReport } from '../../../../lib/ops/alerts.mjs';
export const dynamic='force-dynamic';
export const maxDuration=60;
// Watchdog: long outages, exhausted retries and a stalled scheduler.
// New alerts are delivered once (webhook if configured, and the GitHub
// watchdog workflow fails on them so GitHub e-mails the repository owner).
export async function GET(request) {
 if(!process.env.CRON_SECRET||request.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`) return Response.json({ok:false,error:'unauthorized'},{status:401});
 const notify=new URL(request.url).searchParams.get('notify')!=='0';
 try {
  const sql=db(),settings=await getEditorialSettings(sql);
  const evaluation=await evaluateOps(sql,{automationEnabled:settings.automationEnabled});
  const delivered=notify?await notifyAlerts(sql,{webhook:process.env.ALERT_WEBHOOK_URL||null}):{sent:[]};
  const open=await sql`SELECT alert_key,severity,title,first_seen_at,occurrences FROM ops_alerts WHERE resolved_at IS NULL ORDER BY severity DESC,first_seen_at`;
  return Response.json({ok:true,newAlerts:delivered.sent,notifyError:delivered.error||null,open,evaluation,latency:await latencyReport(sql)});
 } catch(error) {return Response.json({ok:false,error:String(error.message).slice(0,500)},{status:503});}
}
