import Link from 'next/link';
import { getAdminData } from '../../lib/admin-db';
import { clockTime, fullDate } from '../../lib/format';
import { approveAction, archiveAction, logoutAction, pinAction, rejectAction } from './actions';

export const dynamic = 'force-dynamic';

const tabs = [
  ['ko', 'Kø til godkjenning'],
  ['forside', 'Forsideprioritering'],
  ['publisert', 'Publisert'],
  ['siste', 'Siste nytt'],
  ['kilder', 'Kilder & automatikk'],
];

function TabNav({ active }) {
  return (
    <nav className="adminTabs">
      {tabs.map(([key, label]) => <Link className={active === key ? 'active' : ''} href={`/redaksjon?tab=${key}`} key={key}>{label}</Link>)}
    </nav>
  );
}

function Empty({ children }) {
  return <div className="adminEmpty">{children}</div>;
}

function Queue({ items }) {
  if (!items.length) return <Empty>Ingen utkast i køen akkurat nå.</Empty>;
  return <div className="adminTableWrap"><table className="adminTable"><thead><tr><th>Score</th><th>Sak</th><th>Kilde</th><th>Tall</th><th>Tid</th><th></th></tr></thead><tbody>{items.map((a) => <tr key={a.id}>
    <td><span className="scoreBadge">{a.ai_score ?? '—'}</span></td>
    <td><b>{a.tittel}</b><small>{a.seksjon}{a.ai_begrunnelse ? ` · ${a.ai_begrunnelse}` : ''}</small></td>
    <td>{a.kilde_navn || (a.kilde_url ? 'Ekstern kilde' : '—')}</td>
    <td><span className={a.tall_validert ? 'validation ok' : 'validation warn'}>{a.tall_validert ? 'TALL VALIDERT' : 'IKKE VALIDERT'}</span></td>
    <td>{clockTime(a.created_at)}</td>
    <td className="adminActions"><form action={approveAction}><input type="hidden" name="id" value={a.id}/><button>Godkjenn</button></form><form action={rejectAction}><input type="hidden" name="id" value={a.id}/><button className="secondary">Avvis</button></form></td>
  </tr>)}</tbody></table></div>;
}

function FrontPage({ items }) {
  if (!items.length) return <Empty>Ingen publiserte saker.</Empty>;
  return <div className="priorityList">{items.map((a, i) => <div className="priorityRow" key={a.id}><div className="priorityPos">{String(i + 1).padStart(2, '0')}</div><div className="priorityMain"><span className="eyebrow">{a.seksjon}</span><b>{a.tittel}</b><small>Score {a.ai_score ?? '—'} {a.pinned ? '· LÅST' : ''}</small></div><form action={pinAction}><input type="hidden" name="id" value={a.id}/><input type="hidden" name="pinned" value={a.pinned ? 'false' : 'true'}/><button className="secondary">{a.pinned ? 'Frigi' : 'Lås som hovedsak'}</button></form></div>)}</div>;
}

function Published({ items }) {
  if (!items.length) return <Empty>Ingen publiserte saker.</Empty>;
  return <div className="adminTableWrap"><table className="adminTable"><thead><tr><th>Sak</th><th>Seksjon</th><th>Publisert</th><th></th></tr></thead><tbody>{items.map((a) => <tr key={a.id}><td><Link href={`/artikkel/${a.slug}`}><b>{a.tittel}</b></Link></td><td>{a.seksjon}</td><td>{fullDate(a.publisert_at)}</td><td><form action={archiveAction}><input type="hidden" name="id" value={a.id}/><button className="secondary">Arkiver</button></form></td></tr>)}</tbody></table></div>;
}

function Feed({ items }) {
  if (!items.length) return <Empty>Ingen siste nytt-meldinger.</Empty>;
  return <div className="adminTableWrap"><table className="adminTable"><thead><tr><th>Tid</th><th>Melding</th><th>Seksjon</th><th>Status</th></tr></thead><tbody>{items.map((i) => <tr key={i.id}><td>{clockTime(i.tidspunkt)}</td><td><b>{i.tekst}</b></td><td>{i.seksjon || '—'}</td><td>{i.status}</td></tr>)}</tbody></table></div>;
}

function Sources({ items }) {
  if (!items.length) return <Empty>Ingen kilder er lagt inn ennå. Norges Bank blir første adapter.</Empty>;
  return <div className="adminTableWrap"><table className="adminTable"><thead><tr><th>Kilde</th><th>Type</th><th>Intervall</th><th>Status</th><th>Sist hentet</th></tr></thead><tbody>{items.map((s) => <tr key={s.id}><td><b>{s.navn}</b><small>{s.url}</small></td><td>{s.type}</td><td>{s.intervall_min} min</td><td>{s.aktiv ? 'Aktiv' : 'Av'}</td><td>{s.sist_hentet ? fullDate(s.sist_hentet) : 'Aldri'}</td></tr>)}</tbody></table></div>;
}

export default async function RedaksjonPage({ searchParams }) {
  const params = await searchParams;
  const active = tabs.some(([key]) => key === params?.tab) ? params.tab : 'ko';
  const data = await getAdminData();
  const usageCost = data.usage.reduce((sum, row) => sum + Number(row.kostnad_usd || 0), 0);

  return (
    <main className="adminShell">
      <header className="adminHeader">
        <Link href="/" className="adminBrand"><img src="/kapitalstrom-logo.png" alt="Kapitalstrøm"/><span>Redaksjon</span></Link>
        <div className="adminHeaderRight"><span>Produksjon</span><form action={logoutAction}><button className="secondary">Logg ut</button></form></div>
      </header>
      <TabNav active={active}/>
      <div className="adminContentGrid">
        <section className="adminMain">
          <div className="adminPageTitle"><div><div className="eyebrow">Redaksjonspanel</div><h1>{tabs.find(([key]) => key === active)?.[1]}</h1></div><Link href="/" className="secondaryLink">Åpne forsiden →</Link></div>
          {active === 'ko' && <Queue items={data.queue}/>} 
          {active === 'forside' && <FrontPage items={data.liveOrder}/>} 
          {active === 'publisert' && <Published items={data.published}/>} 
          {active === 'siste' && <Feed items={data.feed}/>} 
          {active === 'kilder' && <Sources items={data.sources}/>} 
        </section>
        <aside className="adminAside">
          <div className="adminStat"><span>Utkast i kø</span><strong>{data.queue.length}</strong></div>
          <div className="adminStat"><span>Publisert</span><strong>{data.published.length}</strong></div>
          <div className="adminStat"><span>Aktive kilder</span><strong>{data.sources.filter((s) => s.aktiv).length}</strong></div>
          <div className="adminUsage"><div className="sectionKicker">AI-forbruk i dag</div><strong>${usageCost.toFixed(4)}</strong>{data.usage.length ? data.usage.map((row) => <p key={`${row.steg}-${row.modell}`}><span>{row.steg}</span><span>{row.tokens_inn + row.tokens_ut} tokens</span></p>) : <p>Ingen AI-kall ennå.</p>}</div>
          <div className="adminNote"><b>Neste milepæl</b><p>Norges Bank-adapter og ekte markedsdata. AI forblir avslått til redaksjonsflyten er testet.</p></div>
        </aside>
      </div>
    </main>
  );
}
