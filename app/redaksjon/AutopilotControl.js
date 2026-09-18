'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { runAutopilotStepAction } from './actions';

const STAGE_LABELS = {
  discovery: 'Henter nye saker',
  triage: 'Filtrerer og samler hendelser',
  scoring: 'AI-rangerer kandidater',
  selection: 'Velger toppsakene',
  research: 'Bygger kilde- og faktapakker',
  drafting: 'Skriver private utkast',
  done: 'Ferdig',
};

function queueSummary(state) {
  if (!state) return '';
  return `Lokal filter: ${state.triagePending ? 'venter' : 'ferdig'} · AI-kandidater: ${state.scoring} · AI-retry: ${state.deferredScoring ?? 0} · Utvalg: ${state.selectionPending ? 'venter' : (state.selected ?? 0) + ' valgt'} · Research: ${state.research} (+${state.deferredResearch ?? 0} senere) · Utkast: ${state.drafting} (+${state.deferredDrafting ?? 0} senere)`;
}

export default function AutopilotControl() {
  const router = useRouter();
  const stopRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState('');
  const [message, setMessage] = useState('Klar. Autopiloten publiserer ingenting; ferdige saker havner privat i utkastskøen.');
  const [state, setState] = useState(null);
  const [processed, setProcessed] = useState(0);
  const [errors, setErrors] = useState([]);

  async function run() {
    if (running) return;

    stopRef.current = false;
    setRunning(true);
    setErrors([]);
    setProcessed(0);
    setStage('discovery');
    setMessage('Starter autopilot og henter nye radartreff …');

    let first = true;
    let activeRunId = null;
    let totalProcessed = 0;
    let stalled = 0;
    let lastProgressKey = '';
    let loops = 0;
    const collectedErrors = [];

    try {
      while (!stopRef.current && loops < 160) {
        loops += 1;
        const result = await runAutopilotStepAction({ discovery: first, runId: activeRunId });
        first = false;
        if (result?.runId) activeRunId = Number(result.runId);

        if (!result?.ok) {
          const newErrors = Array.isArray(result?.errors) ? result.errors : ['Ukjent autopilot-feil'];
          collectedErrors.push(...newErrors);
          setErrors([...collectedErrors]);
          setMessage(`Autopiloten stoppet: ${newErrors[0] || 'ukjent feil'}`);
          break;
        }

        const currentState = result.state || null;
        const amount = Number(result.processed || 0);
        totalProcessed += amount;
        setProcessed(totalProcessed);
        setState(currentState);
        setStage(result.stage || '');

        if (Array.isArray(result.errors) && result.errors.length) {
          collectedErrors.push(...result.errors);
          setErrors([...collectedErrors]);
        }

        const progressKey = currentState
          ? [result.stage, currentState.triagePending, currentState.scoring, currentState.deferredScoring, currentState.selectionPending, currentState.selected, currentState.research, currentState.deferredResearch, currentState.drafting, currentState.deferredDrafting].join(':')
          : result.stage;

        if (result.stage === 'discovery') {
          const inserted = Number(result.discovery?.inserted || 0);
          const seen = Number(result.discovery?.seen || 0);
          setMessage(`Discovery ferdig: ${seen} treff sjekket, ${inserted} nye lagret. Lokal filtrering starter …`);
          stalled = 0;
        } else if (result.stage === 'triage') {
          const t = result.triage || {};
          setMessage(`Lokal trakt ferdig: ${Number(t.scanned || 0)} råtreff → ${Number(t.relevant || 0)} finansrelevante → ${Number(t.clusters || 0)} unike hendelser → ${Number(t.candidates || 0)} sendt videre til AI. ${Number(t.duplicates || 0)} duplikater og ${Number(t.noise || 0)} støytreff ble stoppet før AI.`);
          stalled = 0;
        } else if (result.stage === 'selection') {
          const selected = Array.isArray(result.selected) ? result.selected : [];
          const titles = selected.map((x) => '#' + x.rank + ' ' + x.title).join(' · ');
          setMessage(`Redaksjonelt utvalg ferdig: ${selected.length} unike saker valgt av maks 3.${titles ? ' ' + titles : ''}`);
          stalled = 0;
        } else {
          setMessage(`${STAGE_LABELS[result.stage] || 'Jobber'} · ${queueSummary(currentState)} · ${totalProcessed} arbeidssteg ferdig`);
          stalled = progressKey === lastProgressKey ? stalled + 1 : 0;
        }
        lastProgressKey = progressKey;

        if (currentState?.done || result.stage === 'done') {
          const deferred = Number(currentState?.deferredScoring || 0)
            + Number(currentState?.deferredResearch || 0)
            + Number(currentState?.deferredDrafting || 0);
          setMessage(deferred > 0
            ? `Autopilot ferdig · ${totalProcessed} arbeidssteg behandlet · ${deferred} deljobber er utsatt til automatisk retry senere.`
            : `Autopilot ferdig · ${totalProcessed} arbeidssteg behandlet · denne redaksjonsrunden er ferdig.`);
          break;
        }

        if (stalled >= 3) {
          setMessage(`Autopiloten stoppet kontrollert fordi samme arbeid feilet flere ganger. ${queueSummary(currentState)}.`);
          break;
        }
      }

      if (stopRef.current) {
        setMessage(`Stoppet av deg. Alt som allerede er behandlet er lagret. ${queueSummary(state)}.`);
      } else if (loops >= 160) {
        setMessage('Autopiloten nådde sikkerhetsgrensen for denne kjøringen. Kjør den igjen for å fortsette resten.');
      }
    } catch (error) {
      const msg = error?.message || 'Ukjent feil';
      collectedErrors.push(msg);
      setErrors([...collectedErrors]);
      setMessage(`Autopiloten stoppet: ${msg}`);
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  function stop() {
    stopRef.current = true;
    setMessage('Stopper etter den deljobben som kjører nå …');
  }

  return (
    <div className="autopilotBox">
      <div className="autopilotTop">
        <div>
          <b>Autopilot · steg 1</b>
          <small>
            Ett klikk: discovery → gratis lokal støyfiltrering og hendelsesklynger → maks ca. 45 unike kandidater AI-rangeres → opptil 3 toppsaker → research → private utkast.
          </small>
        </div>
        <div className="autopilotActions">
          <button
            type="button"
            className="adminLoadingButton"
            onClick={run}
            disabled={running}
            aria-busy={running}
          >
            {running ? <span className="adminSpinner" aria-hidden="true"/> : null}
            <span>{running ? (STAGE_LABELS[stage] || 'Autopilot jobber …') : 'Kjør hele autopiloten'}</span>
          </button>
          {running ? (
            <button type="button" className="secondary" onClick={stop}>Stopp</button>
          ) : null}
        </div>
      </div>

      <div className="autopilotStatus" aria-live="polite">
        <span>{message}</span>
        {state ? <b>{queueSummary(state)}</b> : null}
        {processed > 0 ? <small>{processed} arbeidssteg fullført i denne kjøringen.</small> : null}
        {errors.length ? <small className="autopilotWarning">{errors.length} del-feil logget · siste: {errors[errors.length - 1]}</small> : null}
      </div>

      {state ? (
        <div className="autopilotProgressWrap">
          <div className="autopilotProgressMeta">
            <span>Fremdrift</span>
            <b>{Math.max(0, Math.min(100, Number(state.progressPct || 0)))}%</b>
          </div>
          <div className="autopilotProgress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.max(0, Math.min(100, Number(state.progressPct || 0)))}>
            <span style={{ width: `${Math.max(0, Math.min(100, Number(state.progressPct || 0)))}%` }}/>
          </div>
        </div>
      ) : null}
    </div>
  );
}
