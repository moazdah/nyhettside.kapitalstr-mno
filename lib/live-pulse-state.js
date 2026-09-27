import { db } from './db';

let schemaReady = false;

export async function ensureLivePulseSchema(sql = db()) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS live_pulse_runs (
      id BIGSERIAL PRIMARY KEY,
      scheduled_slot TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      stage TEXT NOT NULL DEFAULT 'discover',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      discovered INT NOT NULL DEFAULT 0,
      inserted INT NOT NULL DEFAULT 0,
      scored INT NOT NULL DEFAULT 0,
      updates_created INT NOT NULL DEFAULT 0,
      markets_updated INT NOT NULL DEFAULT 0,
      error TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_live_pulse_runs_started ON live_pulse_runs (started_at DESC)`;
  schemaReady = true;
}

function osloParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

export function osloHour(date = new Date()) {
  return Number(osloParts(date).hour);
}

export function livePulseSlot(date = new Date()) {
  return new Date(Math.floor(date.getTime() / 300000) * 300000).toISOString();
}

export async function startLivePulse(sql = db()) {
  await ensureLivePulseSchema(sql);
  const slot = livePulseSlot();
  const inserted = await sql`
    INSERT INTO live_pulse_runs (scheduled_slot, status, stage)
    VALUES (${slot}, 'running', 'discover')
    ON CONFLICT (scheduled_slot) DO NOTHING
    RETURNING *
  `;
  if (inserted[0]) return { run: inserted[0], created: true };

  const [existing] = await sql`
    SELECT *
    FROM live_pulse_runs
    WHERE scheduled_slot = ${slot}
    LIMIT 1
  `;
  return { run: existing || null, created: false };
}

export async function getLivePulse(sql = db(), id) {
  await ensureLivePulseSchema(sql);
  const [run] = await sql`SELECT * FROM live_pulse_runs WHERE id = ${Number(id)} LIMIT 1`;
  return run || null;
}

export async function getLatestLivePulse(sql = db()) {
  await ensureLivePulseSchema(sql);
  const [run] = await sql`
    SELECT *
    FROM live_pulse_runs
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return run || null;
}
