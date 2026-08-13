import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { supportsLocalWebBluetooth } from '@voicecan/device-connect-web';
import { api, errorMessage } from './api.js';
import { EmbeddedDeviceProvisioner, RemoteDeviceProvisioner } from './device-integration.js';
import type { StartRemoteProvisioning } from './device-integration.js';
import type { Locale } from './i18n.js';
import { Button, DataTable, Field, FlowHeader, Icon, ResourcePicker, Stepper } from './ui.js';
import type { Translate } from './ui.js';
import { OpenPlatformWorkspace } from './open-platform-workspace.js';

export type View = 'overview' | 'devices' | 'files' | 'provision' | 'release' | 'device-settings' | 'groups' | 'users' | 'open-platform' | 'open-platform-overview' | 'permission-catalog' | 'oauth-clients' | 'call-logs' | 'download-grants' | 'security-alerts' | 'events' | 'inspector' | 'storage' | 'audit';

export const labels: Record<View, string> = {
  overview: 'Overview', devices: 'Devices', files: 'Recording files', provision: 'Bind device', release: 'Transfer device', 'device-settings': 'Device access settings', groups: 'Groups', users: 'Users', 'open-platform': 'Applications', 'open-platform-overview': 'Open platform overview', 'permission-catalog': 'Permission catalog', 'oauth-clients': 'OAuth / MCP clients', 'call-logs': 'API and MCP call logs', 'download-grants': 'Temporary download grants', 'security-alerts': 'Security alerts', events: 'Events', inspector: 'Delivery inspector', storage: 'Storage', audit: 'Audit log',
};

export const navGroups: readonly { label: string; items: readonly View[] }[] = [
  { label: 'Workspace', items: ['overview'] },
  { label: 'Devices', items: ['devices', 'files', 'provision', 'release', 'device-settings'] },
  { label: 'Organization', items: ['groups', 'users'] },
  { label: 'Open platform', items: ['open-platform-overview', 'open-platform', 'permission-catalog', 'oauth-clients', 'call-logs', 'download-grants', 'security-alerts'] },
  { label: 'Operations', items: ['events', 'inspector', 'storage', 'audit'] },
];

function deviceConnectUrl(): string {
  const configured = document.querySelector<HTMLMetaElement>('meta[name="voicecan-connect-url"]')?.content.trim();
  return configured && configured !== '__VOICECAN_CONNECT_URL__' ? configured : 'https://connect.voice-can.com/';
}

export const resourcePaths: Partial<Record<View, string>> = {
  devices: '/devices', files: '/files?limit=20', events: '/events?limit=20', audit: '/audit-logs',
  'open-platform-overview': '/open-platform/overview', 'permission-catalog': '/open-platform/permission-catalog', 'oauth-clients': '/open-platform/oauth-clients', 'call-logs': '/open-platform/call-logs', 'download-grants': '/open-platform/download-grants', 'security-alerts': '/open-platform/security-alerts',
};

type Runner = <T>(operation: () => Promise<T>) => Promise<T | undefined>;

function Tabs({ options, value, onChange, t }: { options: readonly string[]; value: string; onChange: (value: string) => void; t: Translate }) {
  return <div className="operation-tabs" role="tablist">{options.map((option) => <button type="button" role="tab" aria-selected={value === option} className={value === option ? 'active' : undefined} key={option} onClick={() => onChange(option)}>{t(option)}</button>)}</div>;
}

function Actions({ children }: { children: ReactNode }) { return <div className="form-actions">{children}</div>; }

export function AdminWorkspace({ view, t, run, locale, onNavigateDevice }: { view: View; t: Translate; run: Runner; locale: Locale; onNavigateDevice: (deviceId: string) => void }) {
  if (view === 'open-platform') return <OpenPlatformWorkspace t={t} run={run} />;
  if (view === 'groups') return <GroupsWorkspace t={t} run={run} />;
  if (view === 'users') return <UsersWorkspace t={t} run={run} />;
  if (view === 'provision') return <ProvisionWorkspace t={t} run={run} locale={locale} onNavigateDevice={onNavigateDevice} />;
  if (view === 'release') return <ReleaseWorkspace t={t} run={run} />;
  if (view === 'device-settings') return <DeviceAccessSettingsWorkspace t={t} run={run} />;
  if (view === 'inspector') return <InspectorWorkspace t={t} run={run} />;
  if (view === 'storage') return <StorageWorkspace t={t} run={run} />;
  return null;
}

function GroupsWorkspace({ t, run }: { t: Translate; run: Runner }) {
  const [action, setAction] = useState('Create group');
  const [groupId, setGroupId] = useState('');
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('active');
  const [reason, setReason] = useState('');
  return <div className="operation-layout"><Tabs options={['Create group', 'Update group', 'Manage members', 'Transfer administrator']} value={action} onChange={setAction} t={t}/><div className="operation-card"><form className="form-grid" onSubmit={(event) => event.preventDefault()}>
    {action === 'Create group' ? <><Field id="group-name" label={t('Group name')} value={name} onChange={setName} required/><ResourcePicker id="group-admin-user" label={t('Initial Group Admin')} endpoint="/users" value={userId} onChange={setUserId} t={t} required/><Actions><Button id="create-group" icon="group" onClick={() => void run(() => api('/user-groups', { method: 'POST', body: JSON.stringify({ name: name.trim(), group_admin_user_id: userId }) }))}>{t('Create group')}</Button></Actions></> : null}
    {action === 'Update group' ? <><ResourcePicker id="group-id" label={t('Group')} endpoint="/user-groups" value={groupId} onChange={setGroupId} t={t} required/><Field id="group-name" label={t('New group name')} value={name} onChange={setName}/><Field id="group-status" label={t('Status')} value={status} onChange={setStatus} options={[{ value: 'active', label: t('active') }, { value: 'archived', label: t('archived') }]}/><Actions><Button id="update-group" onClick={() => void run(() => api(`/user-groups/${encodeURIComponent(groupId)}`, { method: 'PATCH', body: JSON.stringify({ ...(name.trim() ? { name: name.trim() } : {}), status }) }))}>{t('Update group')}</Button></Actions></> : null}
    {action === 'Manage members' ? <><ResourcePicker id="group-id" label={t('Group')} endpoint="/user-groups" value={groupId} onChange={setGroupId} t={t} required/><ResourcePicker id="group-member-user" label={t('User')} endpoint="/users" value={userId} onChange={setUserId} t={t} required/><Actions><Button id="add-member" onClick={() => void run(() => api(`/user-groups/${encodeURIComponent(groupId)}/members`, { method: 'PUT', body: JSON.stringify({ user_id: userId }) }))}>{t('Add member')}</Button><Button id="remove-member" kind="danger" onClick={() => { if (globalThis.confirm(t('Remove this member from the group?'))) void run(() => api(`/user-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE', body: '{}' })); }}>{t('Remove member')}</Button></Actions></> : null}
    {action === 'Transfer administrator' ? <><ResourcePicker id="group-id" label={t('Group')} endpoint="/user-groups" value={groupId} onChange={setGroupId} t={t} required/><ResourcePicker id="group-member-user" label={t('New Group Admin')} endpoint="/users" value={userId} onChange={setUserId} t={t} required/><Field id="group-transfer-reason" label={t('Transfer reason')} value={reason} onChange={setReason} wide required/><div className="impact-note field-wide"><strong>{t('High-impact operation')}</strong><p>{t('The selected user will become the new Group Admin. This action is recorded in the audit log.')}</p></div><Actions><Button id="transfer-group-admin" kind="danger" onClick={() => { if (globalThis.confirm(t('Transfer Group Admin now?'))) void run(() => api(`/user-groups/${encodeURIComponent(groupId)}/transfer-admin`, { method: 'POST', body: JSON.stringify({ user_id: userId, reason: reason.trim() }) })); }}>{t('Transfer Group Admin')}</Button></Actions></> : null}
  </form></div><Button id="list-groups" kind="ghost" icon="refresh" onClick={() => void run(() => api('/user-groups'))}>{t('Refresh groups')}</Button></div>;
}

function UsersWorkspace({ t, run }: { t: Translate; run: Runner }) {
  const [action, setAction] = useState('Create user');
  const [userId, setUserId] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [disabled, setDisabled] = useState('false');
  const [reason, setReason] = useState('');
  const [users, setUsers] = useState<unknown>();
  const [listError, setListError] = useState('');
  const roleOptions = [{ value: 'user', label: t('user') }, { value: 'system_admin', label: t('system admin') }];
  const refreshUsers = async (): Promise<void> => { try { setUsers(await api('/users')); setListError(''); } catch (cause) { setListError(cause instanceof Error ? cause.message : String(cause)); } };
  const mutate = async (operation: () => Promise<unknown>): Promise<void> => { const response = await run(operation); if (response !== undefined) await refreshUsers(); };
  useEffect(() => { void refreshUsers(); }, []);
  return <div className="operation-layout"><Tabs options={['Create user', 'Update access', 'Reset password']} value={action} onChange={setAction} t={t}/><div className="operation-card"><form className="form-grid" onSubmit={(event) => event.preventDefault()}>
    {action === 'Create user' ? <><Field id="user-name" label={t('Username')} value={username} onChange={setUsername} required/><Field id="user-display" label={t('Display name')} value={displayName} onChange={setDisplayName}/><Field id="user-password" label={t('Initial password')} hint={t('Use at least 12 characters.')} value={password} onChange={setPassword} type="password" minLength={12} maxLength={256} required/><Field id="user-role" label={t('Role')} value={role} onChange={setRole} options={roleOptions}/><Actions><Button id="create-user" disabled={!username.trim() || password.length < 12} onClick={() => void mutate(async () => { const response = await api('/users', { method: 'POST', body: JSON.stringify({ username: username.trim(), display_name: displayName.trim(), password, role }) }); setPassword(''); return response; })}>{t('Create user')}</Button></Actions></> : null}
    {action === 'Update access' ? <><ResourcePicker id="user-id" label={t('User')} endpoint="/users" value={userId} onChange={setUserId} t={t} required/><Field id="user-display" label={t('Display name')} value={displayName} onChange={setDisplayName}/><Field id="user-role" label={t('Role')} value={role} onChange={setRole} options={roleOptions}/><Field id="user-disabled" label={t('Disabled')} value={disabled} onChange={setDisabled} options={[{ value: 'false', label: t('false') }, { value: 'true', label: t('true') }]}/><Field id="user-reason" label={t('Change reason')} value={reason} onChange={setReason} wide required/><Actions><Button id="update-user" onClick={() => void mutate(() => api(`/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ role, disabled: disabled === 'true', display_name: displayName.trim(), reason: reason.trim() }) }))}>{t('Update role/status')}</Button><Button id="delete-user" kind="danger" onClick={() => { if (globalThis.confirm(t('Delete this user?'))) void mutate(() => api(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE', body: '{}' })); }}>{t('Delete user')}</Button></Actions></> : null}
    {action === 'Reset password' ? <><ResourcePicker id="user-id" label={t('User')} endpoint="/users" value={userId} onChange={setUserId} t={t} required/><Field id="user-password" label={t('New password')} hint={t('Use at least 12 characters.')} value={password} onChange={setPassword} type="password" minLength={12} maxLength={256} wide required/><Actions><Button id="set-user-password" disabled={!userId || password.length < 12} onClick={() => void mutate(async () => { const response = await api(`/users/${encodeURIComponent(userId)}/password`, { method: 'PUT', body: JSON.stringify({ password }) }); setPassword(''); return response; })}>{t('Set password')}</Button></Actions></> : null}
  </form></div><section className="content-card user-list-card"><header><div><p className="eyebrow">{t('Organization')}</p><h2>{t('User list')}</h2></div><Button id="list-users" kind="ghost" icon="refresh" onClick={() => void refreshUsers()}>{t('Refresh users')}</Button></header>{listError ? <div className="inline-alert inline-alert-error">{listError}</div> : <DataTable data={users} t={t} pageSize={10}/>}</section></div>;
}

function ProvisionWorkspace({ t, run, locale, onNavigateDevice }: { t: Translate; run: Runner; locale: Locale; onNavigateDevice: (deviceId: string) => void }) {
  const [groupId, setGroupId] = useState('');
  const [serial, setSerial] = useState('');
  const [deviceWsUrl, setDeviceWsUrl] = useState('');
  const [bleNamePrefix, setBleNamePrefix] = useState('CAPSO-');
  const [started, setStarted] = useState(false);
  const [connectorReady, setConnectorReady] = useState(false);
  const [deviceStep, setDeviceStep] = useState(0);
  const startConnector = useRef<((createGrant: () => Promise<{ provisioning_token: string; expires_at: string }>) => Promise<void>) | undefined>(undefined);
  const localBluetooth = supportsLocalWebBluetooth();
  const connectorUrl = deviceConnectUrl();
  const startRemoteConnector = useRef<StartRemoteProvisioning | undefined>(undefined);
  useEffect(() => { let active = true; void api<{ ble_name_prefix: string; preferred_device_ws_url: string }>('/settings/device-access').then((settings) => { if (active) { setBleNamePrefix(settings.ble_name_prefix); setDeviceWsUrl((currentUrl) => currentUrl || settings.preferred_device_ws_url); } }, () => undefined); return () => { active = false; }; }, []);
  const steps = ['Choose ownership', 'Connect nearby device', 'Configure network', 'Binding complete'];
  const current = !groupId ? 0 : !started || deviceStep === 0 ? 1 : deviceStep === 1 || deviceStep === 2 ? 2 : 3;
  const createGrant = async (): Promise<{ expires_at: string; provisioning_token: string }> => { const expectedSn = serial.trim(); return api('/provisioning-sessions', { method: 'POST', body: JSON.stringify({ group_id: groupId, allowed_origin: location.origin, ...(!localBluetooth ? { connector_origin: new URL(connectorUrl).origin } : {}), ...(expectedSn ? { expected_sn: expectedSn } : {}) }) }); };
  const reportError = (integrationError: unknown): void => { setStarted(false); setDeviceStep(0); const message = integrationError instanceof Error ? integrationError.message : 'Device selection failed unexpectedly.'; void run(() => Promise.reject(new Error(t(message)))); };
  const beginBinding = (): void => {
    if (!groupId) return;
    setStarted(true); setDeviceStep(0);
    if (localBluetooth) { const start = startConnector.current; if (!start) { setStarted(false); return; } void start(createGrant); return; }
    const start = startRemoteConnector.current; if (!start) { setStarted(false); return; }
    void run(async () => { await start(createGrant); return true; }).then((opened) => { if (!opened) setStarted(false); });
  };
  return <div className="flow-layout"><Stepper steps={steps} current={current} t={t}/>{!started ? <div className="flow-stage"><form className="form-grid provision-form" onSubmit={(event) => event.preventDefault()}><ResourcePicker id="provision-group" label={t('Destination group')} endpoint="/user-groups" value={groupId} onChange={setGroupId} t={t} required selectFirst/><Field id="provision-sn" label={t('Expected serial (optional)')} hint={t('Use the serial printed on the device to reduce nearby-device mistakes.')} value={serial} onChange={setSerial}/><Field id="provision-device-ws-url" label={t('Device WebSocket URL')} hint={t('Use an address reachable from the device network, for example a LAN IP or public domain.')} type="url" value={deviceWsUrl} onChange={setDeviceWsUrl} wide required/><Actions><Button id="create-provision" icon="provision" disabled={!groupId || !deviceWsUrl.trim() || !connectorReady} onClick={beginBinding}>{t('Start binding')}</Button></Actions></form></div> : null}{localBluetooth ? <EmbeddedDeviceProvisioner deviceWsUrl={deviceWsUrl.trim()} bleNamePrefix={bleNamePrefix} locale={locale} hidden={!started} registerStart={(start) => { startConnector.current = start; setConnectorReady(Boolean(start)); }} onStepChange={setDeviceStep} onProvisioned={() => setDeviceStep(3)} onAlreadyClaimed={onNavigateDevice} onError={reportError}/> : <RemoteDeviceProvisioner deviceWsUrl={deviceWsUrl.trim()} bleNamePrefix={bleNamePrefix} locale={locale} connectorUrl={connectorUrl} hidden={!started} registerStart={(start) => { startRemoteConnector.current = start; setConnectorReady(Boolean(start)); }} onProvisioned={() => setDeviceStep(3)} onAlreadyClaimed={onNavigateDevice}/>}</div>;
}

function DeviceAccessSettingsWorkspace({ t, run }: { t: Translate; run: Runner }) {
  const [bleNamePrefix, setBleNamePrefix] = useState('CAPSO-');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => { let active = true; void api<{ ble_name_prefix: string }>('/settings/device-access').then((settings) => { if (active) { setBleNamePrefix(settings.ble_name_prefix); setLoaded(true); } }, () => { if (active) setLoadError(true); }); return () => { active = false; }; }, []);
  return <div className="operation-layout"><div className="operation-card device-access-settings"><div className="settings-intro"><span className="settings-mark">⌁</span><div><h2>{t('Nearby device discovery')}</h2><p>{t('Control which advertised Bluetooth device names appear in the browser selector during device binding.')}</p></div></div><form className="form-grid" onSubmit={(event) => event.preventDefault()}>{loadError ? <div className="impact-note field-wide" role="alert"><strong>{t('Device access settings could not be loaded')}</strong><p>{t('Reload the page and try again before changing discovery rules.')}</p></div> : null}<Field id="ble-name-prefix" label={t('BLE device name prefix')} hint={t('Only nearby devices whose advertised names start with this value will be shown. Use 1 to 24 visible characters.')} value={bleNamePrefix} onChange={setBleNamePrefix} wide required/><div className="ble-prefix-preview field-wide"><span>{t('Selector preview')}</span><code>{bleNamePrefix || '—'}VOICECAN-01</code><small>{t('Changing this setting affects new browser device selections immediately. It does not rename devices.')}</small></div><Actions><Button id="save-device-access-settings" icon="check" disabled={!loaded || !bleNamePrefix.trim()} onClick={() => void run(async () => { const settings = await api<{ ble_name_prefix: string }>('/settings/device-access', { method: 'PATCH', body: JSON.stringify({ ble_name_prefix: bleNamePrefix.trim() }) }); setBleNamePrefix(settings.ble_name_prefix); return settings; })}>{t('Save device access settings')}</Button></Actions></form></div></div>;
}

type StorageState = {
  driver: 'filesystem_http' | 'server_relay' | 's3_direct';
  driver_source: 'deployment_environment';
  driver_change_requires_restart: boolean;
  supported_drivers: readonly StorageState['driver'][];
  deployment_profile: string;
  max_file_bytes: number;
  max_storage_bytes: number;
  warning_ratio: number;
  stop_ratio: number;
  settings_updated_at: string | null;
  active_transfers: number;
  stored_bytes: number;
  capacity: { total: number; available: number; usedRatio: number } | null;
};

function formatStorageBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 || unit === 0 ? size.toFixed(unit === 0 ? 0 : 1) : size.toFixed(2)} ${units[unit]}`;
}

function formatStoragePercent(value: number): string {
  const percent = Math.max(0, value * 100);
  if (percent > 0 && percent < 0.1) return '<0.1%';
  return `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function StorageWorkspace({ t, run }: { t: Translate; run: Runner }) {
  const [state, setState] = useState<StorageState>();
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [maxStorageGb, setMaxStorageGb] = useState('');
  const [warningPercent, setWarningPercent] = useState('');
  const [stopPercent, setStopPercent] = useState('');
  const [reason, setReason] = useState('');
  const applyState = (next: StorageState): void => {
    setState(next);
    setMaxStorageGb(String(Number((next.max_storage_bytes / 1024 ** 3).toFixed(2))));
    setWarningPercent(String(Number((next.warning_ratio * 100).toFixed(1))));
    setStopPercent(String(Number((next.stop_ratio * 100).toFixed(1))));
  };
  const refresh = async (): Promise<void> => {
    setLoading(true);
    try { applyState(await api<StorageState>('/admin/storage')); setLoadError(''); }
    catch (cause) { setLoadError(errorMessage(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  if (loading && !state) return <div className="loading-panel" role="status"><span className="spinner"/><span>{t('Loading storage configuration…')}</span></div>;
  if (!state) return <div className="error-panel" role="alert"><span className="error-mark">!</span><div><strong>{t('Storage configuration could not be loaded')}</strong><p>{loadError}</p><Button kind="secondary" icon="refresh" onClick={() => void refresh()}>{t('Try again')}</Button></div></div>;
  const logicalUsage = state.max_storage_bytes > 0 ? state.stored_bytes / state.max_storage_bytes : 0;
  const physicalUsage = state.capacity?.usedRatio ?? null;
  const displayUsage = Math.max(0, Math.min(1, logicalUsage));
  const storageAtRisk = logicalUsage >= 1 || physicalUsage !== null && physicalUsage >= state.stop_ratio
    ? 'stop'
    : physicalUsage !== null && physicalUsage >= state.warning_ratio ? 'warning' : 'healthy';
  const maxBytes = Math.round(Number(maxStorageGb) * 1024 ** 3);
  const warningRatio = Number(warningPercent) / 100;
  const stopRatio = Number(stopPercent) / 100;
  const valid = Number.isSafeInteger(maxBytes) && maxBytes >= state.max_file_bytes && warningRatio > 0 && stopRatio < 1 && warningRatio < stopRatio && reason.trim().length > 0;
  const drivers: Readonly<Record<StorageState['driver'], { title: string; description: string }>> = {
    filesystem_http: { title: 'Filesystem HTTP', description: 'The device uploads directly to this server and objects are stored on its filesystem.' },
    server_relay: { title: 'Server relay', description: 'The server relays bounded chunks into local immutable storage.' },
    s3_direct: { title: 'S3 direct', description: 'The device uploads to S3 with temporary signed requests; production requires this mode.' },
  };
  return <div className="storage-workspace">
    {loadError ? <div className="inline-alert inline-alert-error" role="alert">{loadError}</div> : null}
    <section className="storage-overview-grid">
      <article className="content-card storage-capacity-card">
        <header><div><p className="eyebrow">{t('Platform storage usage')}</p><h2>{formatStorageBytes(state.stored_bytes)} <small>{t('stored')}</small></h2></div><span className={`storage-health storage-health-${storageAtRisk}`}>{t(storageAtRisk === 'stop' ? 'Writes stopped' : storageAtRisk === 'warning' ? 'Near capacity' : 'Capacity healthy')}</span></header>
        <div className="storage-meter" role="progressbar" aria-label={t('Platform storage usage')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Number((displayUsage * 100).toFixed(1)))}><span style={{ width: `${displayUsage * 100}%` }}/></div>
        <div className="storage-meter-labels"><span>{t('{percent} of the configured limit used', { percent: formatStoragePercent(logicalUsage) })}</span><span>{t('{remaining} remaining within the configured limit', { remaining: formatStorageBytes(Math.max(0, state.max_storage_bytes - state.stored_bytes)) })}</span></div>
        {physicalUsage !== null && state.capacity ? <div className="physical-capacity"><div><span>{t('Host disk usage')}</span><strong>{formatStoragePercent(physicalUsage)}</strong></div><div className="physical-capacity-meter" role="progressbar" aria-label={t('Host disk usage')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(physicalUsage * 100)}><span style={{ width: `${Math.min(1, physicalUsage) * 100}%` }}/><i className="warning-mark" style={{ left: `${state.warning_ratio * 100}%` }}/><i className="stop-mark" style={{ left: `${state.stop_ratio * 100}%` }}/></div><small>{t('{available} physical space available; this includes files outside Voicecan.', { available: formatStorageBytes(state.capacity.available) })}</small></div> : <div className="physical-capacity physical-capacity-external"><span>{t('Physical capacity is managed by the object store')}</span></div>}
        <dl className="storage-stat-grid"><div><dt>{t('Configured upper limit')}</dt><dd>{formatStorageBytes(state.max_storage_bytes)}</dd></div><div><dt>{t('Single file limit')}</dt><dd>{formatStorageBytes(state.max_file_bytes)}</dd></div><div><dt>{t('Active transfers')}</dt><dd>{state.active_transfers.toLocaleString()}</dd></div></dl>
      </article>
      <aside className="content-card storage-driver-card"><span className="storage-driver-icon"><Icon name="storage" size={24}/></span><p className="eyebrow">{t('Storage type')}</p><h2>{t(drivers[state.driver].title)}</h2><p>{t(drivers[state.driver].description)}</p><dl><div><dt>{t('Configuration source')}</dt><dd>{t('Deployment environment')}</dd></div><div><dt>{t('Deployment profile')}</dt><dd>{t(state.deployment_profile)}</dd></div></dl><div className="impact-note"><strong>{t('Restart required to change storage type')}</strong><p>{t('Set VOICECAN_STORAGE_DRIVER and the matching storage credentials in the deployment environment, then restart the server. Runtime limits below do not require a restart.')}</p></div></aside>
    </section>
    <section className="content-card storage-types-card"><header><div><p className="eyebrow">{t('Available storage types')}</p><h2>{t('Choose the deployment model before changing the driver')}</h2></div><Button kind="ghost" icon="refresh" disabled={loading} onClick={() => void refresh()}>{t('Refresh status')}</Button></header><div className="storage-type-grid">{state.supported_drivers.map((driver) => <article className={driver === state.driver ? 'active' : undefined} key={driver}><span><Icon name="storage" size={18}/></span><div><strong>{t(drivers[driver].title)}</strong><p>{t(drivers[driver].description)}</p></div>{driver === state.driver ? <b>{t('Current')}</b> : <small>{t('Deployment change')}</small>}</article>)}</div></section>
    <section className="operation-card storage-policy-card"><div className="settings-intro"><span className="settings-mark"><Icon name="storage" size={20}/></span><div><h2>{t('Runtime capacity policy')}</h2><p>{t('These settings are stored by the Device Server, audited, and applied to new uploads immediately on every instance.')}</p></div></div><form className="form-grid" onSubmit={(event) => event.preventDefault()}>
      <Field id="storage-max-gb" label={t('Storage upper limit (GB)')} hint={t('Must be at least the configured single-file limit of {limit}.', { limit: formatStorageBytes(state.max_file_bytes) })}><input id="storage-max-gb" type="number" min={state.max_file_bytes / 1024 ** 3} step="0.25" value={maxStorageGb} onChange={(event) => setMaxStorageGb(event.target.value)}/></Field>
      <Field id="storage-warning-percent" label={t('Capacity warning threshold (%)')} hint={t('Warn operators when physical disk usage reaches this level.')}><input id="storage-warning-percent" type="number" min="1" max="98" step="0.1" value={warningPercent} onChange={(event) => setWarningPercent(event.target.value)}/></Field>
      <Field id="storage-stop-percent" label={t('Stop writes threshold (%)')} hint={t('New uploads are rejected when physical disk usage reaches this level.')}><input id="storage-stop-percent" type="number" min="2" max="99" step="0.1" value={stopPercent} onChange={(event) => setStopPercent(event.target.value)}/></Field>
      <Field id="storage-change-reason" label={t('Change reason')} value={reason} onChange={setReason} wide required/>
      <div className="impact-note field-wide"><strong>{t('Immediate effect')}</strong><p>{t('Lowering the upper limit below current usage does not delete files; it blocks new uploads until usage falls below the limit.')}</p></div>
      <Actions><Button id="save-storage-settings" icon="check" disabled={!valid} onClick={() => void run(() => api<StorageState>('/admin/storage', { method: 'PATCH', body: JSON.stringify({ max_storage_bytes: maxBytes, warning_ratio: warningRatio, stop_ratio: stopRatio, reason: reason.trim() }) })).then((updated) => { if (updated) { applyState(updated); setReason(''); } })}>{t('Save storage policy')}</Button></Actions>
    </form></section>
  </div>;
}

function ReleaseWorkspace({ t, run }: { t: Translate; run: Runner }) {
  const [deviceId, setDeviceId] = useState(() => new URLSearchParams(globalThis.location.search).get('device') ?? '');
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [grant, setGrant] = useState<{ expires_at: string; transfer_token: string }>();
  const steps = ['Select device', 'Review impact', 'Create transfer grant', 'Nearby confirmation'];
  return <div className="flow-layout"><FlowHeader eyebrow={t('Controlled transfer')} title={t('Release a device')} description={t('Transfer control without erasing recordings or exposing the existing device credential.')} icon="transfer"/><Stepper steps={steps} current={grant ? 3 : acknowledged ? 2 : deviceId ? 1 : 0} t={t}/><div className="flow-stage">{!grant ? <form className="form-grid" onSubmit={(event) => event.preventDefault()}><ResourcePicker id="release-device" label={t('Device')} endpoint="/devices" value={deviceId} onChange={setDeviceId} t={t} required/><Field id="release-reason" label={t('Transfer reason')} value={reason} onChange={setReason} wide required/><label className="acknowledgement field-wide"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}/><span><strong>{t('I understand the impact')}</strong><small>{t('Recordings remain stored. Existing successful webhook deliveries cannot be recalled.')}</small></span></label><Actions><Button id="create-release" kind="danger" disabled={!deviceId || !reason.trim() || !acknowledged} onClick={() => void run(async () => { const response = await api<{ expires_at: string; transfer_token: string }>(`/devices/${encodeURIComponent(deviceId)}/transfer-out-sessions`, { method: 'POST', body: JSON.stringify({ allowed_origin: location.origin, reason: reason.trim() }) }); setGrant(response); return response; })}>{t('Create 5-minute release grant')}</Button></Actions></form> : <div className="grant-handoff compact"><div className="device-visual release"><span className="device-body"><i/><b/></span><span className="connection-ring"/></div><div><span className="status-pill status-warning">{t('Physical confirmation required')}</span><h3>{t('Continue near the selected device')}</h3><p>{t('Copy the one-time grant and complete the BLE acknowledgment on the device page before {expires}.', { expires: new Date(grant.expires_at).toLocaleString() })}</p><div className="grant-code"><span>{t('One-time grant')}</span><code>{grant.transfer_token}</code></div><div className="handoff-actions"><Button icon="copy" onClick={() => void navigator.clipboard.writeText(grant.transfer_token)}>{t('Copy transfer grant')}</Button><Button kind="secondary" onClick={() => window.open('/device', '_blank', 'noopener,noreferrer')}>{t('Open device flow')}</Button></div></div></div>}</div></div>;
}

function InspectorWorkspace({ t, run }: { t: Translate; run: Runner }) {
  const [endpointId, setEndpointId] = useState(''); const [status, setStatus] = useState('dead'); const [deliveryId, setDeliveryId] = useState(''); const [reason, setReason] = useState('');
  return <div className="operation-layout"><FlowHeader eyebrow={t('Operations')} title={t('Delivery inspector')} description={t('Inspect delivery metadata without exposing signing secrets.')} icon="pulse"/><div className="operation-card"><form className="form-grid" onSubmit={(event) => event.preventDefault()}><ResourcePicker id="inspector-endpoint" label={t('Endpoint')} endpoint="/event-endpoints" value={endpointId} onChange={setEndpointId} t={t} required/><Field id="inspector-status" label={t('Status')} value={status} onChange={setStatus} options={['dead', 'pending', 'delivered', 'canceled'].map((value) => ({ value, label: t(value) }))}/><Actions><Button id="inspect-deliveries" onClick={() => void run(() => api(`/event-endpoints/${encodeURIComponent(endpointId)}/deliveries?status=${encodeURIComponent(status)}`))}>{t('Inspect deliveries')}</Button></Actions><div className="section-divider field-wide"><span>{t('Replay one delivery')}</span></div><Field id="replay-delivery" label={t('Delivery ID to replay')} value={deliveryId} onChange={setDeliveryId}/><Field id="replay-reason" label={t('Replay reason')} value={reason} onChange={setReason}/><Actions><Button id="replay-delivery-button" kind="secondary" onClick={() => void run(() => api(`/event-deliveries/${encodeURIComponent(deliveryId)}/replay`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }))}>{t('Replay delivery')}</Button></Actions></form></div></div>;
}
