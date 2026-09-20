import { randomUUID } from 'node:crypto';
import { newDossier } from './contract.mjs';

const schemaChecks = new WeakMap();

export class EditorialStateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Read-only readiness check, not a migration on a page view or cron request.
export async function requireEditorialSchema(sql) {
  if (!schemaChecks.has(sql)) {
    const pending = (async () => {
      const [row] = await sql`SELECT to_regclass('public.editorial_cases') AS cases,
        to_regprocedure('public.editorial_assert_lease(bigint,uuid)') AS guard`;
      if (!row?.cases || !row?.guard) throw new EditorialStateError('MIGRATION_REQUIRED', 'Saksflyten mangler databasemigrasjon. Kjør npm run db:migrate mot riktig database før motoren startes.');
    })().catch(error => { schemaChecks.delete(sql); throw error; });
    schemaChecks.set(sql, pending);
  }
  return schemaChecks.get(sql);
}

export async function registerCase(sql, item, runId = null) {
  await requireEditorialSchema(sql);
  const [existing] = await sql`SELECT * FROM editorial_cases WHERE radar_item_id = ${Number(item.id)}`;
  if (existing) {
    if (runId && Number(existing.run_id) !== Number(runId)) throw new EditorialStateError('CASE_RUN_MISMATCH', 'Saken tilhører en annen redaksjonsrunde.');
    return existing; // Later clustering must not replace this case's identity.
  }
  const dossier = newDossier(item);
  const [row] = await sql`
    INSERT INTO editorial_cases (event_key, radar_item_id, run_id, dossier)
    VALUES (${dossier.identity.eventKey}, ${Number(item.id)}, ${runId ? Number(runId) : null}, ${JSON.stringify(dossier)}::jsonb)
    ON CONFLICT (event_key) DO UPDATE SET event_key = EXCLUDED.event_key
    RETURNING *
  `;
  if (Number(row.radar_item_id) !== Number(item.id)) {
    throw new EditorialStateError('EVENT_ALREADY_ASSIGNED', `Hendelsen tilhører allerede sak ${row.id} / radar ${row.radar_item_id}.`);
  }
  if (runId && row.run_id && Number(runId) !== Number(row.run_id)) {
    throw new EditorialStateError('CASE_RUN_MISMATCH', 'Saken tilhører en annen redaksjonsrunde.');
  }
  return row;
}

export async function getCase(sql, radarId) {
  await requireEditorialSchema(sql);
  const [row] = await sql`SELECT * FROM editorial_cases WHERE radar_item_id = ${Number(radarId)}`;
  return row || null;
}

const STEP_STATE = { research: 'researching', write: 'writing', verify: 'verifying', publish: 'publishing' };
const START_STATES = { research: ['selected'], write: ['ready'], verify: ['review'], publish: ['review'] };

export async function claimCase(sql, editorialCase, step, { force = false } = {}) {
  if (!STEP_STATE[step]) throw new Error('Ukjent redaksjonssteg.');
  const token = randomUUID();
  const states = [...START_STATES[step], STEP_STATE[step]];
  if (force && step === 'research') states.push('blocked','ready','review','failed');
  if (force && step === 'write') states.push('review');
  const [row] = await sql`
    UPDATE editorial_cases
    SET state = ${STEP_STATE[step]}, step = ${step}, lease_token = ${token}::uuid,
        lease_until = now() + interval '4 minutes', retry_after = NULL, last_error = NULL,
        attempts = jsonb_set(attempts, ARRAY[${step}]::text[], to_jsonb(COALESCE((attempts ->> ${step})::int, 0) + 1)),
        updated_at = now()
    WHERE id = ${Number(editorialCase.id)}
      AND (state = ANY(${states}::text[]) OR (state = 'failed' AND step = ${step}))
      AND (lease_until IS NULL OR lease_until < now())
      AND (retry_after IS NULL OR retry_after <= now() OR ${force})
      AND (COALESCE((attempts ->> ${step})::int, 0) < 3 OR ${force})
    RETURNING *
  `;
  if (!row) throw new EditorialStateError('CASE_NOT_CLAIMABLE', 'Saken behandles allerede, er avsluttet eller har nådd grensen for nye forsøk.');
  return { ...row, token, claimedStep: step };
}

export async function finishCase(sql, claim, writes, { state, dossier, articleId = null, details = {} }) {
  const results = await sql.transaction([
    sql`SELECT editorial_assert_lease(${Number(claim.id)}, ${claim.token}::uuid)`,
    ...writes,
    sql`UPDATE editorial_cases SET state = ${state}, dossier = ${JSON.stringify(dossier)}::jsonb,
        revision = revision + 1, lease_token = NULL, lease_until = NULL, retry_after = NULL, last_error = NULL,
        fact_pack_id = COALESCE((SELECT id FROM fact_packs WHERE radar_item_id = ${Number(claim.radar_item_id)}), fact_pack_id),
        article_id = COALESCE(${articleId ? Number(articleId) : null}::bigint, article_id), updated_at = now()
      WHERE id = ${Number(claim.id)}`,
    sql`INSERT INTO editorial_case_events (case_id, revision, step, status, details)
      SELECT id, revision, ${claim.claimedStep}, ${state}, ${JSON.stringify(details)}::jsonb FROM editorial_cases WHERE id = ${Number(claim.id)}`,
    sql`SELECT * FROM editorial_cases WHERE id = ${Number(claim.id)}`,
  ]);
  return results.at(-1)[0];
}

export async function failCase(sql, claim, error) {
  const message = String(error?.message || error).slice(0, 800);
  // Do not overwrite the new owner or a committed result after a lost response.
  await sql`
    WITH failed AS (
      UPDATE editorial_cases SET state = 'failed', lease_token = NULL, lease_until = NULL,
        retry_after = now() + interval '2 minutes', last_error = ${message}, updated_at = now()
      WHERE id = ${Number(claim.id)} AND lease_token = ${claim.token}::uuid
      RETURNING id, revision
    )
    INSERT INTO editorial_case_events (case_id, revision, step, status, details)
    SELECT id, revision, ${claim.claimedStep}, 'failed', jsonb_build_object('error', ${message}::text) FROM failed
  `;
}

export function sourceJournalWrites(sql, radarId, sources) {
  return sources.filter(s => s?.url).map(source => sql`
    INSERT INTO source_journal (radar_item_id, role, source_name, url, note)
    SELECT ${Number(radarId)}, ${source.role}, ${source.name}, ${source.url},
      ${`Saksgrunnlag: ${source.fetched ? 'dokument hentet' : 'bare discovery'}; originaldato ${source.publication?.at || 'ikke verifisert'}.`}
    WHERE NOT EXISTS (SELECT 1 FROM source_journal WHERE radar_item_id = ${Number(radarId)} AND url = ${source.url} AND role = ${source.role})
  `);
}

export function usageWrite(sql, step, model, usage, cost = 0) {
  return sql`INSERT INTO ai_usage (steg, modell, tokens_inn, tokens_ut, kostnad_usd)
    VALUES (${step}, ${model}, ${Number(usage?.prompt_tokens || 0)}, ${Number(usage?.completion_tokens || 0)}, ${cost})`;
}
