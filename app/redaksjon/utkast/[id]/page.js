import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDraftDetail } from '../../../../lib/admin-db';
import {
  approveFromDraftAction,
  rejectFromDraftAction,
  regenerateDraftFromReviewAction,
  saveDraftEditAction,
} from '../../actions';
import DraftEditor from '../DraftEditor';

export const dynamic = 'force-dynamic';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export default async function DraftReviewPage({ params, searchParams }) {
  const { id } = await params;
  const qs = await searchParams;
  const article = await getDraftDetail(Number(id));
  if (!article) notFound();

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
          {qs?.created ? (
            <div className="sourceToolbar"><div><b>Ny privat artikkel er opprettet.</b><small>Skriv, legg inn lenker og bilde, og publiser først når du er klar.</small></div></div>
          ) : null}

          <div className="sourceToolbar">
            <div>
              <b>Redaksjonell status</b>
              {article.radar_item_id ? (
                <small>
                  {article.tall_validert ? 'Automatisk tallkontroll bestått' : 'Manuell/redaksjonell kontroll kreves'} · faktapakke {article.fact_pack_version || '—'}.
                </small>
              ) : (
                <small>Egen artikkel · ingen AI-faktapakke er koblet til.</small>
              )}
              {article.valideringsnotat ? <small>{article.valideringsnotat}</small> : null}
            </div>
            <div className="adminActions">
              {article.radar_item_id ? (
                <form action={regenerateDraftFromReviewAction}>
                  <input type="hidden" name="radar_id" value={article.radar_item_id}/>
                  <button className="secondary">Lag nytt AI-utkast</button>
                  <small className="regenerateWarning">Overskriver tittel, ingress og brødtekst i dette utkastet.</small>
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

          <div className="sectionKicker draftEditTitle">Rediger utkast</div>
          <DraftEditor
            article={{
              id: article.id,
              tittel: article.tittel,
              undertittel: article.undertittel,
              brodtekst: article.brodtekst,
              seksjon: article.seksjon,
              forfatter: article.forfatter,
              bilde_url: article.bilde_url,
              bilde_kreditt: article.bilde_kreditt,
            }}
            action={saveDraftEditAction}
          />
        </section>

        <aside className="adminAside">
          {article.radar_item_id ? (
            <>
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
                <b>Faktapakke · {article.fact_confidence ?? '—'}/100</b>
                <p>{article.headline_fact || '—'}</p>
                <p>{facts.length} fakta · {numbers.length} tall · {unknowns.length} interne kontrollpunkter</p>
              </div>
            </>
          ) : (
            <div className="adminNote">
              <b>Egen artikkel</b>
              <p>Denne saken er opprettet manuelt. Du styrer selv tittel, tekst, kilder, lenker, bilde og publisering.</p>
            </div>
          )}

          <div className="adminNote">
            <b>Kildelenker</b>
            <p>Når et annet medium faktisk må krediteres, kan du gjøre kilden klikkbar direkte i brødteksten. Lenken vises blå og understreket for leseren.</p>
          </div>

          <div className="adminNote">
            <b>Visuelt forslag fra AI</b>
            <p>{article.visual_type || 'none'}</p>
            <p>{article.visual_brief || 'Ingen forslag ennå.'}</p>
          </div>

          <div className="adminNote">
            <b>Publisering</b>
            <p>Utkastet er privat. Det blir først offentlig når du trykker «Godkjenn og publiser».</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
