let schemaReady = false;

export async function ensureLiveUpdateSchema(sql) {
  if (schemaReady) return;

  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS headline TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS summary TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS source_url TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS source_name TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS radar_item_id BIGINT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS article_id BIGINT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS priority NUMERIC`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS event_key TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS generated_by TEXT`;
  await sql`ALTER TABLE feed ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ`;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_radar_item
    ON feed (radar_item_id)
    WHERE radar_item_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_feed_live_time
    ON feed (status, tidspunkt DESC)
  `;

  schemaReady = true;
}
