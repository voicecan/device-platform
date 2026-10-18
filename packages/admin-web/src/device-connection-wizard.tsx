import type { ReactNode } from 'react';
import type { ConnectionReading } from './connection-reading.js';
import { Button, Field, Icon, Select, type Translate } from './ui.js';
import { connectionAdvice, connectionChecks, checkLabels, stageLabels, type ConnectionEvent } from './connection-diagnostics.js';

type Props = {
  t: Translate; name: string; networkStep: boolean; bluetooth: boolean; busy: boolean;
  ssid: string; password: string; encryption: 'open' | 'wpa2' | 'wpa3';
  onSsid(value: string): void; onPassword(value: string): void; onEncryption(value: 'open' | 'wpa2' | 'wpa3'): void;
  reading?: ConnectionReading | undefined; networkNotice?: string; currentNetworkConnected?: boolean; onUseCurrentNetwork?(): void; onCheckNetwork?(): void;
  onBluetooth(): void; onConnect(): void; events: ConnectionEvent[]; error: string; disconnectNotice: string;
  advanced: ReactNode; devicePicker: ReactNode;
};

export function DeviceConnectionWizard(p: Props) {
  const { t } = p;
  const keepNetwork = p.bluetooth && p.currentNetworkConnected === true && Boolean(p.onUseCurrentNetwork);
  const checks = connectionChecks(p.events);
  const wifiCheck = checks.wifi === 'waiting' && p.bluetooth && !p.busy && p.reading?.wifiConnected === false ? 'disconnected' : checks.wifi;
  const failed = p.events.findLast((event) => event.state === 'failed');
  const progress = p.events.findLast((event) => event.state === 'running');
  const message = p.error || (failed?.code ? t(connectionAdvice(failed.code)) : p.disconnectNotice);
  return <section className="device-setup" aria-label={t('Connect your device')}>
    <header><h2>{t('Connect your device')}</h2><p>{t('Just Bluetooth, then Wi-Fi. Device details open when connection is complete.')}</p></header>
    <ol className="device-setup-steps" aria-label={t('Connection steps')}>
      <li aria-current={!p.networkStep ? 'step' : undefined} data-complete={p.bluetooth}><span>{p.bluetooth ? '✓' : '1'}</span>{t('Connect Bluetooth')}</li>
      <li aria-current={p.networkStep ? 'step' : undefined}><span>2</span>{t('Connect Wi-Fi')}</li>
    </ol>
    <div className="device-setup-body">
      <div className="device-setup-identity"><Icon name="device"/><strong>{p.name}</strong>{p.bluetooth ? <small>{t('Bluetooth connected')}</small> : null}</div>
      {!p.networkStep ? <><h3>{t('Keep your device nearby')}</h3><p>{t('Turn on Bluetooth, then select your device in the window that opens.')}</p>{p.devicePicker}</> : <><h3>{t(keepNetwork ? 'Device Wi-Fi is connected' : 'Which Wi-Fi should the device use?')}</h3><p className={keepNetwork ? 'device-setup-observation' : undefined}>{t(keepNetwork ? 'The device confirmed an existing network. Its Wi-Fi name cannot be read. Continue using that network without rewriting settings.' : 'Choose a Wi-Fi that can reach the server. Wi-Fi names do not have to match.')}</p></>}
      {p.networkStep && p.bluetooth && p.reading ? <div className="device-setup-reading" role="status">
        <span>{p.reading.batteryPercent === null ? t('Battery reading unavailable') : t('Battery {percent}%', { percent: p.reading.batteryPercent })} · {t({ normal: 'Battery normal', low: 'Battery low', charging: 'Battery charging', full: 'Battery full', unknown: 'Battery state unknown' }[p.reading.batteryState])}</span>
        <time dateTime={p.reading.at}>{t('Read at {time}', { time: new Date(p.reading.at).toLocaleTimeString(undefined, { hour12: false }) })}</time>
        {p.reading.batteryState === 'low' ? <p>{t('The device reports low charge. Connect power before retrying. The failure cause has not been established.')}</p> : null}
      </div> : null}
      {p.networkStep && p.networkNotice ? <p className="device-setup-progress device-setup-observation" role="status">{p.networkNotice}</p> : null}
      {message ? <div className="inline-alert inline-alert-error" role="alert"><strong>{t(failed ? 'Connection did not complete' : 'Connection needs attention')}</strong><p>{message}</p></div> : null}
      {p.networkStep ? <form onSubmit={(event) => { event.preventDefault(); if (keepNetwork) p.onUseCurrentNetwork?.(); else p.onConnect(); }}>
        {!keepNetwork ? <><Field id="setup-wifi-ssid" label={t('Wi-Fi name')} value={p.ssid} onChange={p.onSsid} disabled={p.busy} required/>
        <Field id="setup-wifi-password" label={t('Wi-Fi password')} value={p.password} onChange={p.onPassword} type="password" disabled={p.busy}/></> : null}
        <div className="device-setup-action"><Button type={p.bluetooth ? 'submit' : 'button'} disabled={p.busy || (p.bluetooth && !keepNetwork && !p.ssid.trim())} onClick={p.bluetooth ? undefined : p.onBluetooth}>{t(p.busy ? 'Connecting…' : p.bluetooth ? keepNetwork ? 'Use current Wi-Fi and finish' : 'Connect and finish' : 'Reconnect Bluetooth')}</Button></div>
      </form> : <div className="device-setup-action"><Button disabled={p.busy} onClick={p.onBluetooth}>{t(p.busy ? 'Connecting…' : 'Connect Bluetooth')}</Button></div>}
      {p.busy && progress ? <p className="device-setup-progress" role="status">{t(stageLabels[progress.stage])}{progress.stage === 'select_device' ? ` · ${t('Select your device in the browser Bluetooth chooser.')}` : '…'}</p> : null}
      {p.networkStep ? <><dl className="device-setup-checks" aria-label={t('Automatic connection checks')} aria-live="polite">
        <div data-state={wifiCheck}><dt>{t('Device Wi-Fi connection')}</dt><dd>{t(checkLabels[wifiCheck])}</dd></div>
        <div data-state={checks.server}><dt>{t('Device connection to server')}</dt><dd>{t(checkLabels[checks.server])}</dd></div>
      </dl><p className="device-setup-footnote">{t('These checks confirm Wi-Fi and this service, not general Internet access.')}</p></> : null}
      <p className="device-setup-footnote">{t('Backup and server setup run automatically. Keep this page open until connected.')}</p>
    </div>
    <details className="device-setup-advanced"><summary>{t('Advanced options and diagnostics')}</summary>
      {p.networkStep && p.onCheckNetwork ? <Button kind="secondary" disabled={!p.bluetooth || p.busy} onClick={p.onCheckNetwork}>{t('Check device Wi-Fi')}</Button> : null}
      {keepNetwork ? <><Field id="setup-wifi-ssid" label={t('Wi-Fi name')} value={p.ssid} onChange={p.onSsid} disabled={p.busy} required/>
        <Field id="setup-wifi-password" label={t('Wi-Fi password')} value={p.password} onChange={p.onPassword} type="password" disabled={p.busy}/><Button kind="secondary" disabled={p.busy || !p.ssid.trim()} onClick={p.onConnect}>{t('Apply new Wi-Fi settings')}</Button></> : null}
      {p.networkStep ? <Field label={t('Security')}><Select ariaLabel={t('Security')} value={p.encryption} disabled={p.busy} options={[{value:'wpa2',label:'WPA2'},{value:'wpa3',label:'WPA3'},{value:'open',label:t('Open')}]} onChange={(value) => p.onEncryption(value as Props['encryption'])}/></Field> : null}
      <p>{t('For a server running on this computer, use the same router. Different Wi-Fi bands or Ethernet can work; guest-network isolation can block access. Keep the computer awake.')}</p>
      {p.advanced}
    </details>
  </section>;
}
