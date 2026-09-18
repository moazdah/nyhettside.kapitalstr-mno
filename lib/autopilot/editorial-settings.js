import { db } from '../db';

export const DEFAULT_EDITORIAL_SETTINGS = {
  automationEnabled: true,
  autoPublishEnabled: true,
};

export async function ensureEditorialSettingsSchema(sql = db()) {
  await sql`
    CREATE TABLE IF NOT EXISTS editorial_settings (
      id SMALLINT PRIMARY KEY,
      automation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      auto_publish_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    INSERT INTO editorial_settings (id, automation_enabled, auto_publish_enabled)
    VALUES (1, TRUE, TRUE)
    ON CONFLICT (id) DO NOTHING
  `;
}

export async function getEditorialSettings(sql = db()) {
  await ensureEditorialSettingsSchema(sql);
  const [row] = await sql`
    SELECT automation_enabled, auto_publish_enabled, updated_at
    FROM editorial_settings
    WHERE id = 1
    LIMIT 1
  `;

  return {
    automationEnabled: row?.automation_enabled !== false,
    autoPublishEnabled: row?.auto_publish_enabled !== false,
    updatedAt: row?.updated_at || null,
  };
}

export async function setAutomationEnabled(enabled, sql = db()) {
  await ensureEditorialSettingsSchema(sql);
  await sql`
    UPDATE editorial_settings
    SET automation_enabled = ${Boolean(enabled)}, updated_at = NOW()
    WHERE id = 1
  `;
  return getEditorialSettings(sql);
}

export async function setAutoPublishEnabled(enabled, sql = db()) {
  await ensureEditorialSettingsSchema(sql);
  await sql`
    UPDATE editorial_settings
    SET auto_publish_enabled = ${Boolean(enabled)}, updated_at = NOW()
    WHERE id = 1
  `;
  return getEditorialSettings(sql);
}
