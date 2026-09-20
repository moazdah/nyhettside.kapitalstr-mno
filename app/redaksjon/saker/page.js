import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireEditorialSchema } from '../../../lib/editorial/store.mjs';

export const dynamic = 'force-dynamic';
const labels = { selected: 'Valgt', researching: 'Henter fakta', ready: 'Klar for utkast', writing: 'Skriver',
  verifying: 'Kontrollerer', review: 'Til gjennomgang', publishing: 'Publiserer', published: 'Publisert', blocked: 'Stoppet', failed: 'Feilet' };

export default async function EditorialCasesPage() {
  const sql = db();
  try { await requireEditorialSchema(sql); }
  catch (error) {
    if (error.code !== 'MIGRATION_REQUIRED') throw error;
    return <main className="adminShell"><div className="adminNote"><h1>Saksflyten er ikke aktivert</h1><p>{error.message}</p><Link href="/redaksjon">Til redaksjonen</Link></div></main>;
  }
  const rows = await sql`SELECT c.id, c.state, c.revision, c.article_id, c.updated_at, c.last_error,
    c.dossier #>> '{discovery,title}' AS title, c.dossier #>> '{selection,reason}' AS selection_reason,
    c.dossier #> '{research,reasons}' AS research_reasons, c.dossier #> '{verification,reasons}' AS verification_reasons,
    c.dossier #>> '{sources,0,publication,at}' AS original_published_at,
    a.status AS article_status
    FROM editorial_cases c LEFT JOIN articles a ON a.id = c.article_id ORDER BY c.updated_at DESC LIMIT 50`;
  return <main className="adminShell">
    <header className="adminHeader"><Link href="/redaksjon" className="adminBrand">Kapitalstrøm · Redaksjon</Link></header>
    <div className="adminNote">
      <h1>Saker gjennom redaksjonen</h1>
      <p>Samme saksgrunnlag følger utvelgelse, research, utkast og publisering. Viser de 50 sist oppdaterte sakene.</p>
      <p>{process.env.EDITORIAL_AUTOPUBLISH_V1 === 'true' ? 'Ny publiseringskontroll er aktiv. Autopublisering krever også at bryteren i redaksjonen er på.' : 'Gjennomgangsmodus: den nye motoren lager utkast. Automatisk publisering er slått av for denne løypen.'}</p>
    </div>
    {rows.map(row => <article className="adminNote" key={row.id}>
      <p>Sak {row.id} · {labels[row.state]} · versjon {row.revision}</p>
      <h2>{row.title}</h2><p>{row.selection_reason}</p>
      <p>Original publisering: {row.original_published_at || 'Ikke verifisert'}</p>
      {row.last_error ? <p role="alert">{row.last_error}</p> : null}
      {[...(row.research_reasons || []), ...(row.verification_reasons || [])].map((reason, i) => <p key={`${reason}-${i}`}>Stoppårsak: {reason}</p>)}
      {row.article_status === 'draft' ? <Link href={`/redaksjon/utkast/${row.article_id}`}>Les og kontroller utkast →</Link> : null}
    </article>)}
    {!rows.length ? <div className="adminNote"><p>Ingen saker er behandlet i den nye løypen ennå.</p></div> : null}
  </main>;
}
