import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDraftDetail } from '../../../../lib/admin-db';
import { fullDate } from '../../../../lib/format';
import {
  approveFromDraftAction,
  rejectFromDraftAction,
  regenerateDraftFromReviewAction,
  saveDraftEditAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export default async function DraftReviewPage({ params, searchParams }) {
  const { id } = await params;
  const qs = await searchParams;
  const article = await getDraftDetail(Number(id));
  if (!article) notFound();

  const paragraphs = String(article.brodtekst || '').split(/\n\s*\n/).filter(Boolean);
  const facts = asArray(article.facts);
  const numbers = asArray(article.numbers);
  const unknowns = asArray(article.unknowns);

  return (
    <main className="adminShell">
      <header className="adminHeader">
        <Link href="/redaksjon?tab=ko" className="adminBrand">
          <img src="/kapitalstrom-logo.png" alt="Kapitalstrøm"/>
          <span>Redaksjon</span>
        </Link>
        <div className="adminHeaderRight"><span>Utkast · kun redaksjonen</span></div>
      </header>

      <div className="adminContentGrid">
        <section className="adminMain">
          <div className="adminPageTitle">
            <div>
              <div className="eyebrow">{article.seksjon} · privat utkast</div>
              <h1>{article.tittel}</h1>
            </div>
            <Link href="/redaksjon?tab=ko" className="secondaryLink">← Til utkastskøen</Link>
          </div>

          {qs?.saved ? (
            <div className="sourceToolbar"><div><b>Endringene er lagret.</b><small>Utkastet er fortsatt privat og ikke publisert.</small></div></div>
          ) : null}
          {qs?.regenerated ? (
            <div className="sourceToolbar"><div><b>Nytt AI-utkast er laget.</b><small>Les og rediger før eventuell publisering.</small></div></div>
          ) : null}

          <div className="sourceToolbar">
            <div>
              <b>Redaksjonell status</b>
              <small>
                {article.tall_validert ? 'Automatisk tallkontroll bestått' : 'Manuell/redaksjonell kontroll kreves'} · faktapakke {article.fact_pack_version || '—'}.
              </small>
              {article.valideringsnotat ? <small>{article.valideringsnotat}</small> : null}
            </div>
            <div className="adminActions">
              {article.radar_item_id ? (
                <form action={regenerateDraftFromReviewAction}>
                  <input type="hidden" name="radar_id" value={article.radar_item_id}/>
                  <button className="secondary">Lag nytt AI-utkast</button>
                  <small style={{ display: 'block', maxWidth: 180, marginTop: 5 }}>Overskriver tittel, ingress og brødtekst i dette utkastet.</small>
                </form>
              ) : null}
              <form action={approveFromDraftAction}>
                <input type="hidden" name="id" value={article.id}/>
                <button>Godkjenn og publiser</button>
              </form>
              <form action={rejectFromDraftAction}>
                <input type="hidden" name="id" value={article.id}/>
                <button className="secondary">Avvis</button>
              </form>
            </div>
          </div>

          <div className="sectionKicker" style={{ marginTop: 24, marginBottom: 10 }}>Rediger utkast</div>
          <form action={saveDraftEditAction} className="adminEditForm">
            <input type="hidden" name="id" value={article.id}/>

            <label style={{ display: 'block', marginBottom: 14 }}>
              <b>Tittel</b>
              <input
                name="tittel"
                defaultValue={article.tittel || ''}
                required
                style={{ width: '100%', display: 'block', marginTop: 6, padding: 10, fontSize: 18 }}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 14 }}>
              <b>Undertittel / ingress</b>
              <textarea
                name="undertittel"
                defaultValue={article.undertittel || ''}
                rows={3}
                style={{ width: '100%', display: 'block', marginTop: 6, padding: 10 }}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <label>
                <b>Seksjon</b>
                <select name="seksjon" defaultValue={article.seksjon || 'Markeder'} style={{ width: '100%', display: 'block', marginTop: 6, padding: 10 }}>
                  <option>Markeder</option>
                  <option>Selskaper</option>
                  <option>Økonomi</option>
                  <option>Renter</option>
                  <option>Analyse</option>
                  <option>Kalender</option>
                </select>
              </label>
              <label>
                <b>Forfatter</b>
                <input name="forfatter" defaultValue={article.forfatter || 'Kapitalstrøm'} style={{ width: '100%', display: 'block', marginTop: 6, padding: 10 }}/>
              </label>
            </div>

            <label style={{ display: 'block', marginBottom: 14 }}>
              <b>Brødtekst</b>
              <textarea
                name="brodtekst"
                defaultValue={article.brodtekst || ''}
                required
                rows={24}
                style={{ width: '100%', display: 'block', marginTop: 6, padding: 12, lineHeight: 1.55, fontFamily: 'inherit' }}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
              <label>
                <b>Bilde-URL</b>
                <input
                  name="bilde_url"
                  type="url"
                  defaultValue={article.bilde_url || ''}
                  placeholder="https://..."
                  style={{ width: '100%', display: 'block', marginTop: 6, padding: 10 }}
                />
              </label>
              <label>
                <b>Bildekreditering</b>
                <input
                  name="bilde_kreditt"
                  defaultValue={article.bilde_kreditt || ''}
                  placeholder="Foto: ..."
                  style={{ width: '100%', display: 'block', marginTop: 6, padding: 10 }}
                />
              </label>
            </div>

            <button type="submit">Lagre endringer</button>
            <small style={{ display: 'block', marginTop: 8 }}>Lagring publiserer ikke saken.</small>
          </form>

          <div className="sectionKicker" style={{ marginTop: 32, marginBottom: 10 }}>Forhåndsvisning</div>
          <article className="articleBody" style={{ maxWidth: 820 }}>
            <div className="eyebrow">{article.seksjon}</div>
            <h1>{article.tittel}</h1>
            {article.undertittel ? <p className="articleDek">{article.undertittel}</p> : null}
            <div className="articleMeta">
              <div>
                <b>Av {article.forfatter || 'Kapitalstrøm'}</b><br/>
                <span>Utkast laget {fullDate(article.created_at)}</span>
              </div>
            </div>

            <figure>
              {article.bilde_url
                ? <img src={article.bilde_url} alt="" style={{ width: '100%', height: 'auto', display: 'block' }}/>
                : <div className="photoPlaceholder articlePhoto"><span>INGEN BILDE VALGT</span></div>}
              <figcaption>{article.bilde_kreditt || (article.bilde_url ? 'Bildekreditering mangler.' : 'Legg inn bilde-URL og kreditering over.')}</figcaption>
            </figure>

            <div className="prose">
              {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
            </div>
          </article>
        </section>

        <aside className="adminAside">
          <div className="adminNote">
            <b>Kildegrunnlag</b>
            <p>{article.primary_source_name || 'Ikke registrert'}{article.source_role === 'trusted_secondary' ? ' · etablert nyhetskilde' : article.source_role === 'primary' ? ' · offisiell/primærkilde' : ''}</p>
            {article.primary_source_url ? <a href={article.primary_source_url} target="_blank" rel="noreferrer">Åpne kilden ↗</a> : null}
          </div>

          <div className="adminNote">
            <b>Discovery-kilde</b>
            <p>{article.discovery_source_name || '—'}</p>
            {article.credit_required ? <p><strong>Kreditering skal være tydelig i saken.</strong></p> : <p>Discovery-kilden kan være tipskilde eller støttekilde.</p>}
          </div>

          <div className="adminNote">
            <b>Visuelt forslag fra AI</b>
            <p>{article.visual_type || 'none'}</p>
            <p>{article.visual_brief || 'Ingen forslag ennå.'}</p>
          </div>

          <div className="adminNote">
            <b>Faktapakke · {article.fact_confidence ?? '—'}/100</b>
            <p>{article.headline_fact || '—'}</p>
            <p>{facts.length} fakta · {numbers.length} tall · {unknowns.length} interne kontrollpunkter</p>
          </div>

          <div className="adminNote">
            <b>Publisering</b>
            <p>Denne siden er beskyttet av redaksjonsinnlogging. Artikkelen blir først offentlig når du trykker «Godkjenn og publiser».</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
