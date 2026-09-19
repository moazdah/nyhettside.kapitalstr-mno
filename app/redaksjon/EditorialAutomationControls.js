'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { setAutomationEnabledAction, setAutoPublishEnabledAction } from './actions';

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

function nextClock(minutes) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const nextMinute = minutes.find((m) => m > minute);
  const targetHour = nextMinute == null ? (hour + 1) % 24 : hour;
  const targetMinute = nextMinute == null ? minutes[0] : nextMinute;
  return `${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}`;
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
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = initialRunStatus || null;
  const pulse = initialLivePulseStatus || null;
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
          <h3>To uavhengige brytere</h3>
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
          <div className="automationNext">Neste motor-sjekk ca. <b>{nextClock([7,22,37,52])}</b></div>
        </div>

        <div className={`editorialRunStatus ${pulseRunning ? 'running' : (pulse?.status === 'error' ? 'error' : 'idle')}`}>
          <div className="editorialRunStatusTop">
            <span className="editorialRunDot" aria-hidden="true" />
            <div>
              <b>LIVE-PULS · 5 MIN</b>
              <strong>{pulseStage(pulse)}</strong>
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
          <div className="automationNext">Neste live-sjekk ca. <b>{nextClock([2,7,12,17,22,27,32,37,42,47,52,57])}</b></div>
          {pulse?.error ? <div className="automationPulseError">{pulse.error}</div> : null}
        </div>
      </div>

      <SwitchRow
        title="Nyhetsmotor"
        description="Hovedmotoren arbeider fra 06:00 til 23:00 norsk tid. Fullartikler behandles én gang per time, med flere redundante wake-ups. Live-strøm og markedsdata kontrolleres omtrent hvert 5. minutt. AV stopper begge."
        checked={settings.automationEnabled}
        busy={busy === 'automation'}
        onToggle={toggleAutomation}
      />

      <SwitchRow
        title="Automatisk publisering"
        description="PÅ publiserer ferdigskrevne og maskinvaliderte saker automatisk. AV skriver fortsatt sakene ferdig, men sender dem til køen for din godkjenning."
        checked={settings.autoPublishEnabled}
        busy={busy === 'publish'}
        onToggle={toggleAutoPublish}
      />

      {error ? <div className="automationError">{error}</div> : null}
    </div>
  );
}
