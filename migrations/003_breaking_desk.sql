CREATE TABLE IF NOT EXISTS breaking_events (
 id BIGSERIAL PRIMARY KEY, source_url TEXT UNIQUE NOT NULL, source_name TEXT NOT NULL,
 kind TEXT NOT NULL, headline TEXT NOT NULL, source_published_at TIMESTAMPTZ NOT NULL,
 discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(), first_published_at TIMESTAMPTZ,
 enriched_at TIMESTAMPTZ, article_id BIGINT REFERENCES articles(id),
 evidence JSONB NOT NULL, source_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'detected', last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS breaking_revisions (
 id BIGSERIAL PRIMARY KEY,event_id BIGINT NOT NULL REFERENCES breaking_events(id),
 stage TEXT NOT NULL, body TEXT NOT NULL, source_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(event_id,stage,source_hash)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS breaking_watch (
 source TEXT PRIMARY KEY,checked_at TIMESTAMPTZ NOT NULL, last_success_at TIMESTAMPTZ,last_error TEXT
);
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS breaking_event_id BIGINT REFERENCES breaking_events(id);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS articles_breaking_event ON articles(breaking_event_id) WHERE breaking_event_id IS NOT NULL;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS breaking_until TIMESTAMPTZ;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_points JSONB NOT NULL DEFAULT '[]';
-- statement-breakpoint
ALTER TABLE editorial_settings ADD COLUMN IF NOT EXISTS breaking_publish_enabled BOOLEAN NOT NULL DEFAULT FALSE;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION breaking_assert_enabled() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM editorial_settings WHERE id=1 AND automation_enabled AND auto_publish_enabled AND breaking_publish_enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BREAKING_PUBLICATION_DISABLED'; END IF;
END $$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION editorial_assert_automatic_enabled() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM editorial_settings WHERE id=1 AND automation_enabled AND auto_publish_enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATIC_PUBLICATION_DISABLED'; END IF;
END $$;
-- statement-breakpoint
ALTER TABLE breaking_revisions ADD COLUMN IF NOT EXISTS verification JSONB;
