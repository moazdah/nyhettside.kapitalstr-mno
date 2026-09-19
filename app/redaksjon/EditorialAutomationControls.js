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

export default function EditorialAutomationControls({ initialSettings, initialRunStatus }) {
  const router = useRouter();
  const [settings, setSettings] = useState({
    automationEnabled: initialSettings?.automationEnabled !== false,
    autoPublishEnabled: initialSettings?.autoPublishEnabled !== false,
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = initialRunStatus || null;
  const running = run?.status === 'running';

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(timer);
  }, [running, router]);

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

      <div className={`editorialRunStatus ${running ? 'running' : 'idle'}`}>
        <div className="editorialRunStatusTop">
          <span className="editorialRunDot" aria-hidden="true" />
          <div>
            <b>{running ? 'JOBBER NÅ' : 'STATUS'}</b>
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
      </div>

      <SwitchRow
        title="Nyhetsmotor"
        description="Planlagt redaksjonsrunde én gang i timen fra 06:00 til 23:00 norsk tid. AV er hovedbryteren og stopper nye automatiske steg."
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
