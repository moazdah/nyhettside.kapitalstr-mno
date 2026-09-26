'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { setAutomationEnabledAction, setAutoPublishEnabledAction, setLivePublishEnabledAction } from './actions';

function SwitchRow({ title, description, checked, busy, onToggle }) {
  return (
    <div className="editorialSwitchRow">
      <div>
        <b>{title}</b>
        <small>{description}</small>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`editorialSwitch ${checked ? 'on' : 'off'}`}
        disabled={busy}
        onClick={onToggle}
      >
        <span className="editorialSwitchKnob" />
        <strong>{checked ? 'PÅ' : 'AV'}</strong>
      </button>
    </div>
  );
}


function osloTime(value) {
  if (!value) return '–';
  try {
    return new Intl.DateTimeFormat('nb-NO', {
      timeZone: 'Europe/Oslo',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return '–';
  }
}

function runStage(run) {
  if (!run) return 'Venter på første automatiske runde';
  if (run.status === 'done') return 'Siste runde ferdig';
  if (!run.discovery_done) return 'Søker etter nye saker';
  if (!run.triage_done) return 'Filtrerer og samler treff';
  if (!run.selection_done) return 'AI vurderer og velger saker';

  const articles = Number(run.articles_created || 0);
  const ready = Number(run.factpacks_ready || 0);
  if (ready > articles) return 'Skriver / publiserer neste sak';
  return 'Researcher valgte saker';
}

function pulseStage(pulse) {
  if (!pulse) return 'Ingen live-puls registrert ennå';
  if (pulse.status === 'error') return 'Siste live-puls feilet';
  if (pulse.status === 'done') return 'Live-puls ferdig';
  if (pulse.stage === 'discover') return 'Henter ferske nyheter';
  if (pulse.stage === 'score') return 'AI vurderer nye kandidater';
  if (pulse.stage === 'publish') return 'Oppdaterer nyhetsstripen';
  if (pulse.stage === 'markets') return 'Oppdaterer markedstall';
  return 'Live-puls jobber';
}

export default function EditorialAutomationControls({ initialSettings, initialRunStatus, initialLivePulseStatus }) {
  const router = useRouter();
  const [settings, setSettings] = useState({
    automationEnabled: initialSettings?.automationEnabled !== false,
    autoPublishEnabled: initialSettings?.autoPublishEnabled !== false,
    livePublishEnabled: initialSettings?.livePublishEnabled === true,
    articleReviewOnly: initialSettings?.articleReviewOnly !== false,
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = initialRunStatus || null;
  const pulse = initialLivePulseStatus || null;
  useEffect(()=>{setSettings(initialSettings);},[initialSettings]);
  async function toggleLivePublish() {
    if (busy) return;
    setBusy('live'); setError('');
    try { const result=await setLivePublishEnabledAction(!settings.livePublishEnabled); setSettings(result.settings); }
    catch(err) { setError(err.message); }
    finally { setBusy(''); }
  }
  const running = run?.status === 'running';
  const pulseRunning = pulse?.status === 'running';

  useEffect(() => {
    if (!settings.automationEnabled) return undefined;
    const timer = setInterval(() => router.refresh(), running || pulseRunning ? 10000 : 20000);
    return () => clearInterval(timer);
  }, [settings.automationEnabled, running, pulseRunning, router]);

  async function toggleAutomation() {
    if (busy) return;
    const next = !settings.automationEnabled;
    setBusy('automation');
    setError('');
    try {
      const result = await setAutomationEnabledAction(next);
      if (!result?.ok) throw new Error('Kunne ikke lagre innstillingen.');
      setSettings(result.settings);
    } catch (err) {
      setError(err?.message || 'Kunne ikke lagre innstillingen.');
    } finally {
      setBusy('');
    }
  }

  async function toggleAutoPublish() {
    if (busy) return;
    const next = !settings.autoPublishEnabled;
    setBusy('publish');
    setError('');
    try {
      const result = await setAutoPublishEnabledAction(next);
      if (!result?.ok) throw new Error('Kunne ikke lagre innstillingen.');
      setSettings(result.settings);
    } catch (err) {
      setError(err?.message || 'Kunne ikke lagre innstillingen.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="editorialAutomationPanel">
      <div className="editorialAutomationHead">
        <div>
          <div className="sectionKicker">Automatisk redaksjon</div>
          <h3>Nyhetsmotor og publisering</h3>
        </div>
        <span className={settings.automationEnabled ? 'automationStatus on' : 'automationStatus off'}>
          {settings.automationEnabled ? 'TIMEKJØRING AKTIV' : 'TIMEKJØRING STOPPET'}
        </span>
      </div>

      <div className="automationHealthGrid">
        <div className={`editorialRunStatus ${running ? 'running' : 'idle'}`}>
          <div className="editorialRunStatusTop">
            <span className="editorialRunDot" aria-hidden="true" />
            <div>
              <b>FULL REDAKSJONSRUNDE</b>
              <strong>{runStage(run)}</strong>
            </div>
            <small>
              {running
                ? `Startet ${osloTime(run?.started_at)}`
                : (run?.finished_at ? `Ferdig ${osloTime(run.finished_at)}` : 'Ingen ferdig runde ennå')}
            </small>
          </div>
          {run ? (
            <div className="editorialRunMetrics">
              <span>Valgt <b>{Number(run.selected_items || run.selected_count || 0)}</b></span>
              <span>Faktapakker <b>{Number(run.factpacks_ready || 0)}</b></span>
              <span>Artikler <b>{Number(run.articles_created || 0)}</b></span>
              <span>Publisert <b>{Number(run.published_count || 0)}</b></span>
            </div>
          ) : null}
          <div className="automationNext">Siste fullførte runde: <b>{osloTime(run?.lastSuccess)}</b></div>
        </div>

        <div className={`editorialRunStatus ${pulse?.health?.status === 'error' || pulse?.status === 'error' ? 'error' : pulseRunning ? 'running' : 'idle'}`}>
          <div className="editorialRunStatusTop">
            <span className="editorialRunDot" aria-hidden="true" />
            <div>
              <b>LIVE-PULS · 5 MIN</b>
              <strong>{pulse?.health?.status==='error' ? 'VARSEL: Live-puls mangler i minst 15 minutter' : pulseStage(pulse)}</strong>
            </div>
            <small>
              {pulseRunning
                ? `Startet ${osloTime(pulse?.started_at)}`
                : (pulse?.finished_at ? `Ferdig ${osloTime(pulse.finished_at)}` : 'Ikke kjørt ennå')}
            </small>
          </div>
          {pulse ? (
            <div className="editorialRunMetrics">
              <span>Nye treff <b>{Number(pulse.inserted || 0)}</b></span>
              <span>Scoret <b>{Number(pulse.scored || 0)}</b></span>
              <span>Nyhetsstripe <b>{Number(pulse.updates_created || 0)}</b></span>
              <span>Marked <b>{Number(pulse.markets_updated || 0)}</b></span>
            </div>
          ) : null}
          <div className="automationNext" role={pulse?.health?.status==='error'?'alert':undefined}>
            Siste vellykkede puls: <b>{osloTime(pulse?.lastSuccess)}</b><br/>
            {pulse?.health?.status==='paused' ? 'Motoren er stoppet' : pulse?.health?.status==='closed' ? 'Utenfor åpningstid' : `Forsinkelse utover 5-minuttersmålet: ${pulse?.health?.delayMinutes ?? 0} min`}
          </div>
          {pulse?.lastJobError ? <div className="automationPulseError">Siste jobbfeil ({pulse.lastJobError.kind}): {pulse.lastJobError.last_error}</div> : null}
          <div className="editorialRunMetrics">{pulse?.jobs?.map(job=><span key={`${job.kind}-${job.status}`}>{job.kind} · {job.status}: <b>{job.count}</b></span>)}</div>
          {pulse?.error ? <div className="automationPulseError">{pulse.error}</div> : null}
        </div>
      </div>

      <SwitchRow
        title="Nyhetsmotor"
        description="Hovedmotoren arbeider fra 06:00 til 23:59 norsk tid. Fullartikler behandles én gang per time, med flere redundante wake-ups. Live-strøm og markedsdata kontrolleres omtrent hvert 5. minutt. AV stopper begge."
        checked={settings.automationEnabled}
        busy={busy === 'automation'}
        onToggle={toggleAutomation}
      />

      <SwitchRow
        title="Automatisk publisering av fullartikler"
        description={settings.articleReviewOnly ? "Gjennomgangsmodus: Fullartikler krever din godkjenning." : "Publiserer maskinvaliderte fullartikler. AV sender dem til gjennomgang."}
        checked={!settings.articleReviewOnly && settings.autoPublishEnabled}
        busy={settings.articleReviewOnly || busy === 'publish'}
        onToggle={toggleAutoPublish}
      />

      <SwitchRow title="Publisering av live-meldinger"
        description="Korte live-meldinger publiseres uavhengig av fullartikler. AV legger nye meldinger som utkast."
        checked={settings.livePublishEnabled} busy={busy==='live'} onToggle={toggleLivePublish}/>
      {error ? <div className="automationError">{error}</div> : null}
    </div>
  );
}
