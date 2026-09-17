import { db } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sql = db();
    const [row] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM articles) AS articles,
        (SELECT COUNT(*)::int FROM feed) AS feed,
        (SELECT COUNT(*)::int FROM markets) AS markets
    `;
    return Response.json({ ok: true, database: 'connected', counts: row });
  } catch (error) {
    return Response.json({ ok: false, database: 'error', message: error.message }, { status: 500 });
  }
}
