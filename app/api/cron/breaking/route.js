import { watchNorgesBank } from '../../../../lib/breaking/watch';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(request) {
 if(!process.env.CRON_SECRET||request.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`) return Response.json({ok:false,error:'unauthorized'},{status:401});
 try {return Response.json({ok:true,...await watchNorgesBank()});}
 catch(error) {return Response.json({ok:false,error:String(error.message).slice(0,500)},{status:503});}
}
