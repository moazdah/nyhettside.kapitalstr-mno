import { db } from '../../../../lib/db';
import { enrichNext } from '../../../../lib/breaking/enrich';
export const dynamic='force-dynamic';
export const maxDuration=180;
export async function GET(request) {
 if(!process.env.CRON_SECRET||request.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`) return Response.json({ok:false,error:'unauthorized'},{status:401});
 const sql=db();
 try {
  const [settings]=await sql`SELECT automation_enabled,auto_publish_enabled,breaking_publish_enabled FROM editorial_settings WHERE id=1`;
  if(!settings?.automation_enabled||!settings.auto_publish_enabled||!settings.breaking_publish_enabled) return Response.json({ok:true,skipped:true});
  return Response.json({ok:true,...await enrichNext(sql)});
 } catch(error) {return Response.json({ok:false,error:String(error.message).slice(0,500)},{status:503});}
}
