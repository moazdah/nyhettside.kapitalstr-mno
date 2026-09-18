import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDraftDetail } from '../../../../lib/admin-db';
import { fullDate } from '../../../../lib/format';
import { approveFromDraftAction, rejectFromDraftAction } from '../../actions';

export const dynamic = 'force-dynamic';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export default async function DraftReviewPage({ params }) {
  const { id } = await params;
  const article = await getDraftDetail(Number(id));
  if (!article) notFound();

  const paragraphs = String(article.brodtekst || '').split(/\n\s*\n/).filter(Boolean);
  const facts = asArray(article.facts);
  const numbers = asArray(article.numbers);
  const unknowns = asArray(article.unknowns);
  const verification = article.verification_details || {};

  return (
    <main className="adminShell">
      <header className="adminHeader">
        <Link href="/redaksjon?tab=ko" className="adminBrand">
          <img src="/kapitalstrom-logo.png" alt="Kapitalstrøm"/>
          <span>Redaksjon</span>
        </Link>
        <div className="adminHeaderRight"><span>Utkast · ikke publisert</span></div>
      </header>

      <div className="adminContentGrid">
        <section className="adminMain">
          <div className="adminPageTitle">
            <div>
              <div className="eyebrow">{article.seksjon} · utkast</div>
              <h1>{article.tittel}</h1>
            </div>
            <Link href="/redaksjon?tab=ko" className="secondaryLink">← Til køen</Link>
          </div>

          {article.undertittel ? <p className="articleDek">{article.undertittel}</p> : null}

          <div className="sourceToolbar">
            <div>
              <b>Automatisk faktakontroll</b>
              <small>
                {article.tall_validert ? 'Tallkontroll bestått' : 'Tall krever kontroll'} · {article.verification_status === 'passed' ? `AI-kontroll ${article.verification_confidence ?? '—'}/100` : 'grundig AI-kontroll venter'} · faktapakke {article.fact_pack_version || '—'}.
              </small>
              {article.valideringsnotat ? <small>{article.valideringsnotat}</small> : null}
            </div>
            <div className="adminActions">
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

          <article className="articleBody" style={{ maxWidth: 820 }}>
            <div className="articleMeta">
              <div>
                <b>Av {article.forfatter || 'Kapitalstrøm'}</b><br/>
                <span>Utkast laget {fullDate(article.created_at)}</span>
              </div>
            </div>

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
            {article.credit_required ? <p><strong>Kreditering skal være tydelig i saken.</strong></p> : <p>Discovery-kilden kan være tipskilde eller støttekilde; kildejournalen viser rollen.</p>}
          </div>

          <div className="adminNote">
            <b>Visuelt forslag</b>
            <p>{article.visual_type || 'none'}</p>
            <p>{article.visual_brief || 'Ingen forslag ennå.'}</p>
          </div>

          <div className="adminNote">
            <b>Faktapakke · {article.fact_confidence ?? '—'}/100</b>
            <p>{article.headline_fact || '—'}</p>
            <p>{facts.length} fakta · {numbers.length} tall · {unknowns.length} interne kontrollpunkter</p>
          </div>

          <div className="adminNote">
            <b>Kontrollresultat</b>
            <p>{article.verification_status || '—'} · {article.verification_confidence ?? '—'}/100</p>
            {verification?.ai?.notes ? <p>{verification.ai.notes}</p> : null}
          </div>
        </aside>
      </div>
    </main>
  );
}
