CREATE TABLE IF NOT EXISTS engine_jobs (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, slot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','retry','done','failed')),
  payload JSONB NOT NULL DEFAULT '{}', attempts INT NOT NULL DEFAULT 0,
  lease_token UUID, lease_until TIMESTAMPTZ, retry_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ, last_error TEXT, UNIQUE(kind,slot)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS engine_jobs_pending ON engine_jobs(kind,created_at) WHERE status <> 'done';
-- statement-breakpoint
CREATE OR REPLACE FUNCTION engine_claim(job_id bigint, token uuid) RETURNS SETOF engine_jobs LANGUAGE plpgsql AS $$
DECLARE job_kind text;
BEGIN
  SELECT kind INTO job_kind FROM engine_jobs WHERE id=job_id;
  PERFORM pg_advisory_xact_lock(hashtext('engine:' || job_kind));
  IF EXISTS (SELECT 1 FROM engine_jobs WHERE kind=job_kind AND status='running' AND lease_until>now()) THEN RETURN; END IF;
  UPDATE engine_jobs SET status='failed', last_error=COALESCE(last_error,'Worker interrupted; retry limit reached'),
    lease_token=NULL, lease_until=NULL, updated_at=now()
    WHERE id=job_id AND status='running' AND lease_until<=now() AND attempts>=5;
  RETURN QUERY UPDATE engine_jobs SET status='running', lease_token=token,
    lease_until=now()+interval '330 seconds', retry_after=NULL, attempts=attempts+1, updated_at=now()
    WHERE id=job_id AND status IN ('pending','retry','running') AND attempts<5
      AND (lease_until IS NULL OR lease_until<=now()) AND (retry_after IS NULL OR retry_after<=now()) RETURNING *;
END $$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION engine_assert_lease(job_id bigint, token uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM engine_jobs WHERE id=job_id AND status='running' AND lease_token=token AND lease_until>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENGINE_LEASE_LOST'; END IF;
END $$;
-- statement-breakpoint
ALTER TABLE editorial_settings ADD COLUMN IF NOT EXISTS live_publish_enabled BOOLEAN NOT NULL DEFAULT TRUE;
-- statement-breakpoint
ALTER TABLE feed ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ;
