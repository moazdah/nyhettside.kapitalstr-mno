'use client';

import { useState } from 'react';
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

export default function EditorialAutomationControls({ initialSettings }) {
  const [settings, setSettings] = useState({
    automationEnabled: initialSettings?.automationEnabled !== false,
    autoPublishEnabled: initialSettings?.autoPublishEnabled !== false,
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

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
