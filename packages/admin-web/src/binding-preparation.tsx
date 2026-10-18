import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { selectBindingGroup } from './binding-preparation-state.js';
import { Button, collectionOf, CredentialBackupWarning, DeviceWsCandidatePicker, Field, Select } from './ui.js';
import type { DeviceWsCandidate, Translate } from './ui.js';

type Group = { id: string; name: string };

function BindingOwnership({ value, onChange, locked, t }: { value: string; onChange: (value: string) => void; locked: boolean; t: Translate }) {
  const [groups, setGroups] = useState<readonly Group[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const selection = useRef({ value, locked });
  selection.current = { value, locked };
  useEffect(() => {
    let active = true;
    setState('loading');
    void api('/user-groups').then((data) => {
      if (!active) return;
      const loaded = collectionOf(data).map((group) => ({ id: String(group.id), name: String(group.name) }));
      setGroups(loaded); setState('ready');
      const current = selection.current;
      if (!current.locked && !current.value) {
        const next = selectBindingGroup(loaded, '');
        if (next) onChange(next);
      }
    }, () => { if (active) setState('error'); });
    return () => { active = false; };
  }, [attempt, onChange]);
  if (state === 'loading') return <p className="binding-helper" role="status">{t('Preparing device ownership…')}</p>;
  if (state === 'error') return <div className="inline-alert inline-alert-error" role="alert"><p>{t('Could not load device ownership. Try again.')}</p><Button kind="secondary" onClick={() => setAttempt((current) => current + 1)}>{t('Try again')}</Button></div>;
  if (groups.length === 0) return <p className="inline-alert" role="status">{t('Create a group in Organization before connecting a device.')}</p>;
  const selected = groups.find((group) => group.id === value);
  if (groups.length === 1 && selected) return null;
  return <Field id="provision-group" label={t('Who should own this device?')} hint={t('Only members of the selected group can access its recordings.')} required>
    <Select id="provision-group" value={value} options={groups.map((group) => ({ value: group.id, label: group.name }))} onChange={onChange} disabled={locked} ariaLabel={t('Who should own this device?')} placeholder={t('Choose a group')}/>
  </Field>;
}

export function BindingPreparation({ onNavigateDevice, t, appPath, localBluetooth, pathLocked, locked, groupId, setGroupId, serial, setSerial, deviceWsUrl, setDeviceWsUrl, candidates, preparedIntent, expired, canExportBackup, networkMode, setNetworkMode, ready, busy, settingsError, onRetrySettings, onChoosePath, onStart }: {
  onNavigateDevice: (id: string) => void; t: Translate; appPath: boolean; localBluetooth: boolean; pathLocked: boolean; locked: boolean;
  groupId: string; setGroupId: (value: string) => void; serial: string; setSerial: (value: string) => void;
  deviceWsUrl: string; setDeviceWsUrl: (value: string) => void; candidates: readonly DeviceWsCandidate[];
  preparedIntent: boolean; expired: boolean; canExportBackup: boolean; networkMode: 'ask' | 'existing'; setNetworkMode: (value: 'ask' | 'existing') => void;
  ready: boolean; busy: boolean; settingsError: boolean; onRetrySettings: () => void;
  onChoosePath: (path: 'web' | 'app') => void; onStart: () => void;
}) {
  return <section className="flow-stage binding-preparation">
    <header className="binding-intro"><h2>{t('Add a new device')}</h2><p>{t('Turn on your device and keep it nearby. We will guide you through the network setup.')}</p></header>
    <form className="provision-form binding-form" onSubmit={(event) => event.preventDefault()}>
      <BindingOwnership value={groupId} onChange={setGroupId} locked={locked} t={t}/>
      {expired ? <p className="inline-alert" role="status">{t('This task authorization has expired. Start a new task to continue. The saved device credential and recordings are preserved.')}</p> : null}
      {settingsError ? <div className="inline-alert inline-alert-error" role="alert"><p>{t('Could not prepare the server connection. Try again.')}</p><Button kind="secondary" onClick={onRetrySettings}>{t('Try again')}</Button></div> : null}
      <details className="binding-options"><summary>{t('Advanced options and diagnostics')}</summary>
      {!pathLocked ? <details className="binding-options"><summary>{t('Use another connection method')}</summary><div className="binding-paths"><button type="button" className={`binding-path ${!appPath ? 'is-selected' : ''}`} aria-pressed={!appPath} onClick={() => onChoosePath('web')}><strong>{t('Bind in browser')}</strong><span>{t('Select the device and configure its network in the browser.')}</span></button><button type="button" className={`binding-path ${appPath ? 'is-selected' : ''}`} aria-pressed={appPath} onClick={() => onChoosePath('app')}><strong>{t('Bind in native app')}</strong><span>{t('Use an installed Voicecan Connect app on your phone.')}</span></button></div></details> : null}
      <details className="binding-options" open={!settingsError && !deviceWsUrl && ready ? true : undefined}>
        <summary>{t('Advanced settings')}</summary>
        <div className="binding-advanced">
          <Field id="provision-sn" label={t('Expected serial (optional)')} hint={t('Use the serial printed on the device to reduce nearby-device mistakes.')} value={serial} onChange={setSerial} disabled={locked}/>
          {!preparedIntent ? <DeviceWsCandidatePicker candidates={candidates} value={deviceWsUrl} onChange={setDeviceWsUrl} t={t} canExportBackup={canExportBackup} showBackupWarning={false}/> : null}
          <Field id="provision-device-ws-url" label={t('Device WebSocket URL')} hint={t('Use an address reachable from the device network, for example a LAN IP or public domain.')} type="url" value={deviceWsUrl} onChange={setDeviceWsUrl} required disabled={locked}/>
          {appPath && !preparedIntent ? <Field id="app-network-mode" label={t('Network setup in app')}><Select id="app-network-mode" value={networkMode} ariaLabel={t('Network setup in app')} options={[{ value: 'ask', label: t('Configure Wi-Fi in app') }, { value: 'existing', label: t('Use the device existing network') }]} onChange={(value) => setNetworkMode(value === 'existing' ? 'existing' : 'ask')}/></Field> : null}
        </div>
      </details>
      <CredentialBackupWarning t={t} canExport={canExportBackup}/>
      </details>
      <div className="binding-start-actions"><Button id={appPath ? 'prepare-native-binding' : 'create-provision'} icon={appPath ? 'device' : 'provision'} disabled={busy || !groupId || !deviceWsUrl.trim() || !ready} onClick={onStart}>{t(busy ? 'Preparing connection…' : expired ? 'Start a new binding task' : appPath ? 'Continue on phone' : localBluetooth ? 'Connect Bluetooth' : 'Open connection page')}</Button><p>{t('Backup and server setup run automatically. Keep this page open until connected.')}</p></div>
    </form>
  </section>;
}
