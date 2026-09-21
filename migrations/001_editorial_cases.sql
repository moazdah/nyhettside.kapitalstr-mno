-- Additive migration. Existing articles, URLs and fact packs are preserved.
CREATE TABLE editorial_cases (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  radar_item_id BIGINT NOT NULL UNIQUE REFERENCES radar_items(id),
  run_id BIGINT REFERENCES editorial_runs(id),
  state TEXT NOT NULL DEFAULT 'selected' CHECK (state IN
    ('selected','researching','ready','writing','verifying','review','publishing','published','blocked','failed')),
  dossier JSONB NOT NULL,
  fact_pack_id BIGINT REFERENCES fact_packs(id),
  article_id BIGINT UNIQUE REFERENCES articles(id),
  revision INT NOT NULL DEFAULT 0,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  step TEXT,
  attempts JSONB NOT NULL DEFAULT '{}'::jsonb,
  retry_after TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
-- statement-breakpoint
CREATE INDEX idx_editorial_cases_run_state ON editorial_cases (run_id, state, updated_at);
-- statement-breakpoint
CREATE TABLE editorial_case_events (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES editorial_cases(id),
  revision INT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE INDEX idx_editorial_case_events_case ON editorial_case_events (case_id, id DESC);
-- statement-breakpoint
-- Fence every group of writes. A stale worker must not commit even if its AI
-- request finishes after another worker has reclaimed an expired lease.
CREATE FUNCTION editorial_assert_lease(p_case BIGINT, p_token UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM editorial_cases
  WHERE id = p_case AND lease_token = p_token AND lease_until > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EDITORIAL_LEASE_LOST' USING ERRCODE = '55000';
  END IF;
END;
$$;
-- statement-breakpoint
-- Recheck the exact article and fact snapshot while their rows are locked.
-- A manual edit between the application check and this transaction must stop it.
CREATE FUNCTION editorial_assert_draft(p_id BIGINT, p_snapshot JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE a articles%ROWTYPE;
BEGIN
  SELECT * INTO a FROM articles WHERE id = p_id FOR UPDATE;
  IF a.id IS NULL OR a.status <> 'draft' THEN
    RAISE EXCEPTION 'EDITORIAL_ARTICLE_NOT_READY' USING ERRCODE = '55000';
  END IF;
  IF jsonb_build_object('title', a.tittel, 'dek', COALESCE(a.undertittel, ''), 'body', a.brodtekst, 'section', a.seksjon) IS DISTINCT FROM p_snapshot THEN
    RAISE EXCEPTION 'EDITORIAL_DRAFT_CHANGED' USING ERRCODE = '55000';
  END IF;
END;
$$;
-- statement-breakpoint
CREATE FUNCTION editorial_assert_publication(p_case BIGINT, p_token UUID, p_article JSONB, p_fact JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  c editorial_cases%ROWTYPE;
  a articles%ROWTYPE;
  f fact_packs%ROWTYPE;
  field RECORD;
BEGIN
  PERFORM editorial_assert_lease(p_case, p_token);
  SELECT * INTO c FROM editorial_cases WHERE id = p_case;
  IF c.state <> 'publishing' OR c.dossier ->> 'version' IS DISTINCT FROM 'editorial-case-v1'
    OR c.dossier -> 'factPack' IS DISTINCT FROM p_fact
    OR (c.dossier -> 'draft' -> 'title') IS DISTINCT FROM (p_article -> 'title')
    OR (c.dossier -> 'draft' -> 'dek') IS DISTINCT FROM (p_article -> 'dek')
    OR (c.dossier -> 'draft' -> 'body') IS DISTINCT FROM (p_article -> 'body')
    OR (c.dossier -> 'draft' -> 'section') IS DISTINCT FROM (p_article -> 'section') THEN
    RAISE EXCEPTION 'EDITORIAL_PROOF_CHANGED' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO a FROM articles WHERE id = c.article_id FOR UPDATE;
  SELECT * INTO f FROM fact_packs WHERE id = c.fact_pack_id FOR SHARE;
  IF a.id IS NULL OR f.id IS NULL OR a.status <> 'draft' OR a.tall_validert IS DISTINCT FROM TRUE
    OR a.fact_pack_id IS DISTINCT FROM c.fact_pack_id OR a.radar_item_id IS DISTINCT FROM c.radar_item_id THEN
    RAISE EXCEPTION 'EDITORIAL_ARTICLE_NOT_READY' USING ERRCODE = '55000';
  END IF;
  IF jsonb_build_object('title', a.tittel, 'dek', COALESCE(a.undertittel, ''), 'body', a.brodtekst, 'section', a.seksjon) <> p_article THEN
    RAISE EXCEPTION 'EDITORIAL_DRAFT_CHANGED' USING ERRCODE = '55000';
  END IF;
  FOR field IN SELECT key, value FROM jsonb_each(p_fact) LOOP
    IF (to_jsonb(f) -> field.key) IS DISTINCT FROM field.value THEN
      RAISE EXCEPTION 'EDITORIAL_FACT_PACK_CHANGED' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF (c.dossier #>> '{research,passed}') IS DISTINCT FROM 'true'
    OR (c.dossier #>> '{selection,eligible}') IS DISTINCT FROM 'true'
    OR (c.dossier #>> '{verification,passed}') IS DISTINCT FROM 'true'
    OR (c.dossier #>> '{sources,0,publication,at}') IS NULL
    OR (c.dossier #>> '{sources,0,publication,at}')::timestamptz < clock_timestamp() - interval '36 hours'
    OR (c.dossier #>> '{sources,0,publication,at}')::timestamptz > clock_timestamp() + interval '15 minutes' THEN
    RAISE EXCEPTION 'EDITORIAL_PUBLICATION_BLOCKED' USING ERRCODE = '55000';
  END IF;
END;
$$;
