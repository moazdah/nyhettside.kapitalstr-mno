// Read-only fallback while the Neon connector is unavailable. Credentials stay
// in this runner's memory and are never written to logs, artifacts or the repo.
import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const project = process.env.VERCEL_PROJECT_ID;
const team = process.env.VERCEL_TEAM_ID;
const token = process.env.VERCEL_TOKEN;
const branch = process.env.EDITORIAL_BRANCH;
let stage = 'configuration';

async function vercel(path, params = {}) {
  const url = new URL(path, 'https://api.vercel.com');
  url.searchParams.set('teamId', team);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const error = new Error('Vercel request failed');
    error.code = `VERCEL_HTTP_${response.status}`;
    throw error;
  }
  return response.json();
}

async function environment(target) {
  stage = `environment_metadata_${target}`;
  const result = await vercel(`/v10/projects/${project}/env`, { decrypt: 'false', ...(target === 'preview' ? { gitBranch: branch } : {}) });
  const rows = (result.envs || []).filter(row => (Array.isArray(row.target) ? row.target : [row.target]).includes(target)
    && (target !== 'preview' || !row.gitBranch || row.gitBranch === branch));
  const choose = key => rows.filter(row => row.key === key)
    .sort((a, b) => Number(b.gitBranch === branch) - Number(a.gitBranch === branch))[0];
  const selected = choose('DATABASE_URL');
  const metadata = { target, databaseConfigured: Boolean(selected),
    directConnectionConfigured: Boolean(choose('DATABASE_URL_UNPOOLED')),
    deepseekConfigured: Boolean(choose('DEEPSEEK_API_KEY')),
    databaseBranchOverride: Boolean(selected?.gitBranch) };
  if (!selected) return { metadata, connection: null };
  stage = `database_credential_${target}`;
  const secret = await vercel(`/v1/projects/${project}/env/${selected.id}`);
  // Whitelist diagnostic fields; never log values, hints, URLs or provider errors.
  console.log(JSON.stringify({ target, credentialMetadata: {
    type: ['encrypted', 'plain', 'secret', 'sensitive', 'system'].includes(secret.type) ? secret.type : 'unknown',
    visibility: ['config', 'secret'].includes(secret.visibility) ? secret.visibility : 'unspecified',
    decrypted: secret.decrypted === true,
    hasValue: typeof secret.value === 'string',
    hasNestedValue: typeof secret.env?.value === 'string',
    hasLegacyValue: typeof secret.legacyValue === 'string',
  } }));
  const connection = secret.value;
  if (typeof connection !== 'string' || !/^postgres(?:ql)?:\/\//.test(connection)) {
    const error = new Error('Database connection could not be retrieved');
    error.code = 'DATABASE_CREDENTIAL_NOT_RETRIEVABLE';
    throw error;
  }
  return { metadata, connection };
}

async function inspect(target, connection) {
  stage = `database_read_${target}`;
  const sql = neon(connection);
  const result = await sql.transaction([
    sql`SELECT current_setting('transaction_read_only') AS read_only,
      to_regclass('public.editorial_cases') IS NOT NULL AS case_table_exists,
      to_regclass('public.kapitalstrom_migrations') IS NOT NULL AS migration_journal_exists`,
    sql`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('articles','radar_items','fact_packs','editorial_runs','editorial_cases')
      ORDER BY table_name,ordinal_position`,
  ], { readOnly: true });
  const key = new URL(connection).hostname.replace('-pooler.', '.');
  return { connected: true, endpointFingerprint: createHash('sha256').update(key).digest('hex').slice(0,16),
    ...result[0][0], columns: result[1] };
}

try {
  if (!token || !project || !team || !branch) throw Object.assign(new Error('Required configuration missing'), { code: 'CONFIGURATION_MISSING' });
  const report = {};
  for (const target of ['production','preview']) {
    const env = await environment(target);
    report[target] = { ...env.metadata, ...(env.connection ? await inspect(target, env.connection) : {}) };
  }
  report.separatePreviewEndpoint = Boolean(report.production.endpointFingerprint && report.preview.endpointFingerprint
    && report.production.endpointFingerprint !== report.preview.endpointFingerprint);
  console.log(JSON.stringify({ ok: true, readOnly: true, ...report }, null, 2));
} catch (error) {
  // Provider exceptions can embed URLs. Emit only controlled stage and code.
  const code = /^[A-Z0-9_]{1,64}$/.test(String(error.code || '')) ? error.code : 'REQUEST_FAILED';
  console.error(JSON.stringify({ ok: false, readOnly: true, stage, code }));
  process.exitCode = 1;
}
