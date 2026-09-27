-- Additive migration: unified desk priority, story merging, more fast-track sources,
-- fact summaries, rights-cleared images, long-outage handling and latency measurement.
-- No article, URL or publication time is deleted or rewritten.
ALTER TABLE breaking_watch ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0;
-- statement-breakpoint
ALTER TABLE breaking_watch ADD COLUMN IF NOT EXISTS first_failure_at TIMESTAMPTZ;
-- statement-breakpoint
ALTER TABLE breaking_watch ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
-- statement-breakpoint
ALTER TABLE breaking_watch ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}'::jsonb;
-- statement-breakpoint
ALTER TABLE breaking_events ADD COLUMN IF NOT EXISTS story_key TEXT;
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS breaking_events_story_key ON breaking_events(story_key) WHERE story_key IS NOT NULL;
-- statement-breakpoint
ALTER TABLE breaking_events ADD COLUMN IF NOT EXISTS visible_verified_at TIMESTAMPTZ;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS story_key TEXT;
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS articles_story_key ON articles(story_key) WHERE story_key IS NOT NULL;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS priority_score NUMERIC;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS placement TEXT;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS desk_assessment JSONB;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_license TEXT;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_source_url TEXT;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_alt TEXT;
-- statement-breakpoint
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_status TEXT;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS article_sources (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  source_name TEXT,
  title TEXT,
  role TEXT NOT NULL DEFAULT 'supporting',
  published_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(article_id, url)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS image_library (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  credit TEXT NOT NULL,
  license TEXT NOT NULL,
  license_url TEXT,
  source_url TEXT,
  alt TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  origin TEXT NOT NULL DEFAULT 'editor',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(credit) > 0 AND length(license) > 0)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS ops_alerts (
  id BIGSERIAL PRIMARY KEY,
  alert_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  title TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrences INT NOT NULL DEFAULT 1,
  resolved_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  notify_error TEXT
);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ops_alerts_open ON ops_alerts(alert_key) WHERE resolved_at IS NULL;
-- statement-breakpoint
ALTER TABLE IF EXISTS engine_jobs ADD COLUMN IF NOT EXISTS revivals INT NOT NULL DEFAULT 0;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS scheduler_ticks (
  id BIGSERIAL PRIMARY KEY,
  scheduler TEXT NOT NULL,
  route TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  ok BOOLEAN,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS scheduler_ticks_started ON scheduler_ticks(route, started_at DESC);
-- statement-breakpoint
-- Regular AI articles get short fact points from their verified fact pack.
-- Only confirmed facts are used; the separate AI assessment is never copied here.
DO $$
BEGIN
  IF to_regclass('public.fact_packs') IS NOT NULL THEN
    UPDATE articles a SET summary_points = s.points
    FROM (
      SELECT fp.id, COALESCE((
        SELECT jsonb_agg(jsonb_build_object('text', left(f->>'fact', 300), 'kind', 'fact',
          'source_url', f->>'source_url', 'fact_id', f->>'id') ORDER BY n)
        FROM jsonb_array_elements(fp.facts) WITH ORDINALITY AS x(f, n)
        WHERE n <= 4 AND length(COALESCE(f->>'fact', '')) >= 12
      ), '[]'::jsonb) AS points
      FROM fact_packs fp WHERE jsonb_typeof(fp.facts) = 'array'
    ) s
    WHERE s.id = a.fact_pack_id AND a.breaking_event_id IS NULL AND a.tall_validert IS TRUE
      AND a.summary_points = '[]'::jsonb;
  END IF;
END $$;
