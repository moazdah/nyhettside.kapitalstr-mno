import { db } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const version = process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_COMMIT_SHA || null;
  try {
    const sql = db();
    const [row] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM articles) AS articles,
        (SELECT COUNT(*)::int FROM feed) AS feed,
        (SELECT COUNT(*)::int FROM markets) AS markets
    `;
    const [editorial] = await sql`SELECT
      to_regclass('public.editorial_cases') IS NOT NULL AS schema_ready,
      to_regprocedure('public.editorial_assert_publication(bigint,uuid,jsonb,jsonb)') IS NOT NULL AS publication_guard_ready`;
    return Response.json({ ok: true, version, database: 'connected', counts: row,
      editorial: { ...editorial, mode: process.env.EDITORIAL_AUTOPUBLISH_V1 === 'true' ? 'autopublish_enabled_by_environment' : 'review' } });
  } catch (error) {
    return Response.json({ ok: false, version, database: 'error' }, { status: 500 });
  }
}
