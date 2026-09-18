import Link from 'next/link';
import { getAdminData } from '../../lib/admin-db';
import { clockTime, fullDate, marketValue } from '../../lib/format';
import { approveAction, archiveAction, logoutAction, pinAction, rejectAction, scoreRawItemsAction, syncEuronextOsloAction, syncNorgesBankAction, syncPolicyRateAction } from './actions';
import RadarActionControl from './RadarActionControl';
import FactPackButton from './FactPackButton';

export const dynamic = 'force-dynamic';

const tabs = [
  ['ko', 'Kø til godkjenning'],
  ['radar', 'Nyhetsradar'],
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

function NewsRadar({ items }) {
  const radarModelTag = 'deepseek-flash/radar-v2';
  const waiting = items.filter((i) => i.ai_score == null || i.ai_model !== radarModelTag).length;
  const candidates = items.filter((i) => i.ai_model === radarModelTag && Number(i.ai_score) >= 60).length;
  return <>
    <div className="sourceToolbar">
      <div><b>Nyhetsradar – discovery</b><small>Henter overskrifter og metadata fra åpne RSS-feeder og GDELTs globale nyhetsindeks. Andre medier brukes som tipsradar, ikke som tekstgrunnlag. Hvert nytt treff får en kildejournal.</small></div>
      <RadarActionControl mode="run"/>
    </div>
    <div className="sourceToolbar">
      <div><b>AI-triage av radaren</b><small>DeepSeek vurderer nyhetsverdi, seksjon, hendelsestype og neste kildegrep med streng kilde-/faktadisiplin. Den skriver ingen artikkel. {waiting} av de viste treffene trenger ny v2-vurdering · {candidates} scorer 60+ etter nye regler.</small></div>
      <RadarActionControl mode="score"/>
    </div>
    {!items.length ? <Empty>Ingen radartreff ennå. Trykk «Kjør radar nå» for første manuelle test.</Empty> : <div className="adminTableWrap"><table className="adminTable"><thead><tr><th>Score</th><th>Tid</th><th>Treff</th><th>Kilde</th><th>Type</th><th>Neste steg</th><th>Faktapakke</th></tr></thead><tbody>{items.map((i) => <tr key={i.id}>
      <td>{i.ai_score == null ? '—' : <span className="scoreBadge">{i.ai_score}</span>}</td>
      <td>{i.published_at ? fullDate(i.published_at) : fullDate(i.discovered_at)}</td>
      <td><a href={i.url} target="_blank" rel="noreferrer"><b>{i.title}</b></a>{i.ai_reason ? <small>{i.ai_section || '—'} · {i.ai_reason}</small> : (i.summary ? <small>{i.summary}</small> : null)}</td>
      <td>{i.source_domain || i.source_name}<small>{i.source_kind}</small></td>
      <td>{i.candidate_type || 'Ikke vurdert'}</td>
      <td>
        {i.credit_required ? <span className="validation warn">KREDITER TYDELIG</span> : (i.next_step || 'Venter AI')}
        {i.primary_source_status === 'verified' ? <small>Primærkilde verifisert</small> : <small>Primærkilde ikke verifisert</small>}
      </td>
      <td>
        {i.fact_pack_status === 'ready' ? <span className="validation ok">KLAR · {i.fact_confidence}/100</span> : null}
        {i.fact_pack_status === 'needs_review' ? <span className="validation warn">TRENGER KONTROLL · {i.fact_confidence}/100</span> : null}
        {i.fact_pack_status === 'needs_source' ? <span className="validation warn">TRENGER KILDE</span> : null}
        {i.fact_pack_status === 'insufficient_source' ? <span className="validation warn">KILDE FOR TYNN</span> : null}
        {i.fact_pack_version && i.fact_pack_version !== 'fact-pack-v2' ? <small>Gammel faktapakke · bygg på nytt</small> : null}
        {i.fact_pack_status && i.headline_fact ? <small>{i.headline_fact}</small> : null}
        {i.primary_source_name ? <small>Primærkilde: {i.primary_source_name}</small> : null}
        {i.ai_model === radarModelTag && Number(i.ai_score) >= 60 ? <FactPackButton id={i.id} currentStatus={i.fact_pack_status || ''}/> : <small>Bygges bare for v2-score 60+</small>}
      </td>
    </tr>)}</tbody></table></div>}
  </>;
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

function RawItems({ items }) {
  if (!items.length) return <Empty>Ingen råmeldinger er hentet ennå.</Empty>;
  return <div className="adminTableWrap"><table className="adminTable"><thead><tr><th>Tid</th><th>Score</th><th>Melding</th><th>Seksjon</th><th>Status</th></tr></thead><tbody>{items.map((i) => <tr key={i.id}>
    <td>{i.publisert ? fullDate(i.publisert) : '—'}</td>
    <td>{i.ai_score == null ? '—' : <span className="scoreBadge">{i.ai_score}</span>}</td>
    <td><a href={i.url || '#'} target="_blank" rel="noreferrer"><b>{i.tittel}</b></a>{i.ai_begrunnelse ? <small>{i.ai_begrunnelse}</small> : null}</td>
    <td>{i.ai_seksjon || '—'}</td>
    <td>{i.behandlet ? `Scoret · ${i.ai_modell || 'AI'}` : 'Venter scoring'}</td>
  </tr>)}</tbody></table></div>;
}

function Sources({ items, policyRate, rawItems }) {
  const pendingCount = rawItems.filter((i) => !i.behandlet).length;
  return <>
    <div className="sourceToolbar">
      <div><b>Norges Bank – markeder og styringsrente</b><small>Henter offisielle valutakurser og overvåker styringsrenten. Ved en faktisk renteendring lages et utkast med score 100 i redaksjonskøen – ingenting autopubliseres ennå.</small></div>
      <form action={syncNorgesBankAction}><button>Oppdater alt nå</button></form>
    </div>
    <div className="sourceToolbar">
      <div><b>Styringsrente</b><small>{policyRate ? `Sist registrert: ${marketValue('NOKPOLICY', policyRate.verdi)} · oppdatert ${fullDate(policyRate.oppdatert)}` : 'Ikke registrert ennå. Første sjekk oppretter bare referanseverdien.'}</small></div>
      <form action={syncPolicyRateAction}><button className="secondary">Sjekk renten nå</button></form>
    </div>
    <div className="sourceToolbar">
      <div><b>Oslo Børs – selskapsmeldinger</b><small>Testadapter mot Euronexts offentlige Oslo Børs-side. Henter de nyeste meldingene til raw_items. Kjøring er manuell inntil stabilitet og vilkår er verifisert.</small></div>
      <form action={syncEuronextOsloAction}><button>Hent børsmeldinger nå</button></form>
    </div>
    <div className="sourceToolbar">
      <div><b>AI-scoring – DeepSeek</b><small>Sender maks 20 ventende råmeldinger i én billig batch. Kun score, seksjon og kort begrunnelse returneres; ingen artikkel skrives eller publiseres. {pendingCount} av de viste meldingene venter scoring.</small></div>
      <form action={scoreRawItemsAction}><button>Score ventende nå</button></form>
    </div>
    {!items.length ? <Empty>Ingen kilder er registrert ennå.</Empty> : <div className="adminTableWrap"><table className="adminTable"><thead><tr><th>Kilde</th><th>Type</th><th>Intervall</th><th>Status</th><th>Sist hentet</th></tr></thead><tbody>{items.map((s) => <tr key={s.id}><td><b>{s.navn}</b><small>{s.url}</small></td><td>{s.type}</td><td>{s.intervall_min} min</td><td>{s.aktiv ? 'Aktiv' : 'Av'}</td><td>{s.sist_hentet ? fullDate(s.sist_hentet) : 'Aldri'}</td></tr>)}</tbody></table></div>}
    <div className="sectionKicker" style={{ marginTop: 24, marginBottom: 10 }}>Siste råmeldinger</div>
    <RawItems items={rawItems}/>
  </>;
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
          {active === 'radar' && <NewsRadar items={data.radarItems}/>} 
          {active === 'forside' && <FrontPage items={data.liveOrder}/>} 
          {active === 'publisert' && <Published items={data.published}/>} 
          {active === 'siste' && <Feed items={data.feed}/>} 
          {active === 'kilder' && <Sources items={data.sources} policyRate={data.policyRate} rawItems={data.rawItems}/>} 
        </section>
        <aside className="adminAside">
          <div className="adminStat"><span>Utkast i kø</span><strong>{data.queue.length}</strong></div>
          <div className="adminStat"><span>Radar-treff</span><strong>{data.radarItems.length}</strong></div>
          <div className="adminStat"><span>Publisert</span><strong>{data.published.length}</strong></div>
          <div className="adminStat"><span>Aktive kilder</span><strong>{data.sources.filter((s) => s.aktiv).length}</strong></div>
          <div className="adminUsage"><div className="sectionKicker">AI-forbruk i dag</div><strong>${usageCost.toFixed(4)}</strong>{data.usage.length ? data.usage.map((row) => <p key={`${row.steg}-${row.modell}`}><span>{row.steg}</span><span>{row.tokens_inn + row.tokens_ut} tokens</span></p>) : <p>Ingen AI-kall ennå.</p>}</div>
          <div className="adminNote"><b>Kildejournal</b><p>Nyhetsradaren lagrer hvor et tips først ble oppdaget. Før artikkelskriving skal systemet skille oppdagelseskilde, primærkilde og eventuelle kilder som må krediteres tydelig.</p></div>
          <div className="adminNote"><b>AI-flyt</b><p>Radaren oppdager og prioriterer. Børsmeldinger scores separat. Artikkelmotoren kobles først på etter at kilde- og faktapakken er testet.</p></div>
          <div className="adminNote"><b>Rentevakt</b><p>Styringsrenten overvåkes mot Norges Banks offisielle publisering og API. En endring lager et kontrollert utkast i køen. Den automatiske rentevakten kjører via GitHub Actions.</p></div>
        </aside>
      </div>
    </main>
  );
}
