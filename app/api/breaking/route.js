import { getBreakingStory } from '../../../lib/db';
export const dynamic='force-dynamic';
export async function GET() {
 const headers={'Cache-Control':'no-store, max-age=0'};
 try {return Response.json({story:await getBreakingStory()},{headers});}
 catch {return Response.json({error:'breaking_unavailable'},{status:503,headers});}
}
