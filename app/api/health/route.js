import { db } from '../../../lib/db';
import { getEditorialSettings } from '../../../lib/autopilot/editorial-settings';
import { latencyReport } from '../../../lib/ops/alerts.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  const version = process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_COMMIT_SHA || null;
  try {
    const sql = db();
    const settings=await getEditorialSettings(sql);
    const [breaking]=await sql`SELECT breaking_publish_enabled AS enabled FROM editorial_settings WHERE id=1`;
    const [row] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM articles) AS articles,
        (SELECT COUNT(*)::int FROM feed) AS feed,
        (SELECT COUNT(*)::int FROM markets) AS markets
    `;
    const [editorial] = await sql`SELECT
      to_regclass('public.editorial_cases') IS NOT NULL AS schema_ready,
      to_regprocedure('public.editorial_assert_publication(bigint,uuid,jsonb,jsonb)') IS NOT NULL AS publication_guard_ready`;
    const [engine] = await sql`SELECT to_regclass('public.engine_jobs') IS NOT NULL AS schema_ready,
      to_regprocedure('public.engine_assert_lease(bigint,uuid)') IS NOT NULL AS lease_guard_ready`;
    const [desk] = await sql`SELECT to_regclass('public.ops_alerts') IS NOT NULL AS schema_ready`;
    let operations = { schema_ready: desk.schema_ready };
    if (desk.schema_ready) {
      const [alerts] = await sql`SELECT count(*) FILTER (WHERE severity='critical')::int AS critical, count(*)::int AS open FROM ops_alerts WHERE resolved_at IS NULL`;
      const sources = await sql`SELECT source, last_success_at, consecutive_failures FROM breaking_watch ORDER BY source`;
      operations = { ...operations, alerts, sources, latency: await latencyReport(sql) };
    }
    return Response.json({ ok: true, operations, engine:{...engine,scheduler:process.env.NEWS_SCHEDULER==='vercel'?'vercel':'github'}, version, database: 'connected', counts: row,
      breaking, editorial: { ...editorial, mode: settings.automationEnabled && settings.autoPublishEnabled ? 'automatic' : 'review' } });
  } catch (error) {
    return Response.json({ ok: false, version, database: 'error' }, { status: 500 });
  }
}
