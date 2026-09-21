import { createHash } from 'node:crypto';

const literal = value => `'${String(value).replaceAll("'", "''")}'`;

export async function applyMigration(sql, name, contents) {
  const checksum = createHash('sha256').update(contents).digest('hex');
  const statements = contents.split('-- statement-breakpoint').map(s => s.trim()).filter(Boolean);
  // One PostgreSQL command, including the ledger check, under one transaction
  // lock. This also works with Neon's non-interactive HTTP transaction model.
  const body = `DECLARE applied_checksum TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(7419215);
  CREATE TABLE IF NOT EXISTS kapitalstrom_migrations (
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  SELECT checksum INTO applied_checksum FROM kapitalstrom_migrations WHERE name = ${literal(name)};
  IF FOUND THEN
    IF applied_checksum <> ${literal(checksum)} THEN
      RAISE EXCEPTION 'MIGRATION_CHECKSUM_CHANGED';
    END IF;
  ELSE
    ${statements.map(statement => `EXECUTE ${literal(statement)};`).join('\n    ')}
    INSERT INTO kapitalstrom_migrations(name, checksum) VALUES (${literal(name)}, ${literal(checksum)});
  END IF;
END;`;
  await sql.query(`DO ${literal(body)}`);
  return checksum;
}
