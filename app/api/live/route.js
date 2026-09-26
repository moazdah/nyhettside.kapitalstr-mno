import { getLiveFeed } from '../../../lib/db';
export const dynamic='force-dynamic';
export async function GET() {
  const headers={'Cache-Control':'no-store, max-age=0'};
  try { return Response.json({items:await getLiveFeed()},{headers}); }
  catch { return Response.json({error:'live_unavailable'},{status:503,headers}); }
}
