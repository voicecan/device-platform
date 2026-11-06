import { useEffect, useState } from 'react';
import { api, errorMessage } from './api.js';
import { Button, Icon } from './ui.js';
import type { Translate } from './ui.js';
import type { View } from './workspaces.js';

type Device = Record<string, unknown>;
type DevicePage = { items: readonly Device[]; total_count: number; summary: { online: number; offline: number } };
type CountPage = { total_count: number };
type EventItem = { id: string; type: string; created_at: string; data?: Record<string, unknown> };
type EventPage = { items: readonly EventItem[]; total_count: number };
type PlatformOverview = {
  applications?: { total?: number; active?: number; suspended?: number };
  security_alerts?: { open?: number; critical?: number };
  calls_24h?: { requests?: number; errors?: number };
};
type StorageState = {
  stored_bytes: number;
  max_storage_bytes: number;
  warning_ratio: number;
  stop_ratio: number;
  capacity?: { available: number; usedRatio: number } | null;
};
type OverviewData = {
  devices?: DevicePage | undefined;
  offline?: DevicePage | undefined;
  pending?: CountPage | undefined;
  failed?: CountPage | undefined;
  recordings?: CountPage | undefined;
  events?: EventPage | undefined;
  platform?: PlatformOverview | undefined;
  storage?: StorageState | undefined;
};
type IconName = Parameters<typeof Icon>[0]['name'];
type Tone = 'danger' | 'warning';
type NavigateOptions = { recordingStatus?: string };
type Attention = { key: string; tone: Tone; icon: IconName; title: string; detail: string; action: string; target: View; recordingStatus?: string };
type Kpi = { key: string; label: string; value: string; sub: string; icon: IconName; target: View; recordingStatus?: string; tone?: Tone; disabled?: boolean };

const REFRESH_MS = 30_000;

function fulfilled<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === 'fulfilled' ? result.value : undefined;
}

function totalOf(value: { total_count?: number } | undefined): number | undefined {
  const total = value?.total_count;
  return typeof total === 'number' && Number.isFinite(total) ? total : undefined;
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function locale(): string {
  return globalThis.document?.documentElement.lang || 'zh-CN';
}

function number(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString(locale());
}

function bytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 || unit === 0 ? size.toFixed(unit === 0 ? 0 : 1) : size.toFixed(2)} ${units[unit]}`;
}

function percent(value: number): string {
  return `${(Math.max(0, value) * 100).toLocaleString(locale(), { maximumFractionDigits: 1 })}%`;
}

function when(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '—';
  return new Date(value).toLocaleString(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function time(value: Date): string {
  return value.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function deviceName(device: Device): string {
  return String(device.display_name || device.sn || device.id || '—');
}

function eventLabel(type: string): string {
  return type.split('.').join(' · ').replaceAll('_', ' ');
}

function eventMeta(item: EventItem): string {
  const data = item.data;
  if (!data) return '';
  const value = data.device_id ?? data.serial_number ?? data.session_id;
  return value === undefined ? '' : String(value);
}

export function Overview({ t, health, onNavigate, onSelectDevice, isSystemAdmin, isGroupAdmin, isViewer = false, hasGroup }: {
  t: Translate;
  health: string;
  onNavigate: (view: View, options?: NavigateOptions) => void;
  onSelectDevice: (deviceId: string) => void;
  isSystemAdmin: boolean;
  isGroupAdmin: boolean;
  isViewer?: boolean;
  hasGroup: boolean;
}) {
  const [data, setData] = useState<OverviewData>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [refresh, setRefresh] = useState(0);

  const canSeeGroupData = isSystemAdmin || hasGroup;
  const canSeePlatform = isSystemAdmin || isGroupAdmin || isViewer;
  const canSeeStorage = isSystemAdmin || isViewer;
  const canProvision = isSystemAdmin || isGroupAdmin;
  const noGroup = !canSeeGroupData;

  useEffect(() => {
    let active = true;
    const load = async (quiet: boolean): Promise<void> => {
      if (!quiet) setLoading(true);
      if (!canSeeGroupData) {
        if (!active) return;
        setData({});
        setError('');
        setUpdatedAt(new Date());
        setLoading(false);
        return;
      }
      const results = await Promise.allSettled([
        api<DevicePage>('/admin/devices?limit=6'),
        api<DevicePage>('/admin/devices?limit=3&online=false&attention=active'),
        api<CountPage>('/files?limit=1&status=pending'),
        api<CountPage>('/files?limit=1&status=failed&attention=active'),
        api<CountPage>('/files?limit=1'),
        api<EventPage>('/events?limit=5'),
        canSeePlatform ? api<PlatformOverview>('/open-platform/overview') : Promise.resolve(undefined),
        canSeeStorage ? api<StorageState>('/admin/storage') : Promise.resolve(undefined),
      ]);
      if (!active) return;
      const devices = fulfilled(results[0]);
      setData({
        devices,
        offline: fulfilled(results[1]),
        pending: fulfilled(results[2]),
        failed: fulfilled(results[3]),
        recordings: fulfilled(results[4]),
        events: fulfilled(results[5]),
        platform: fulfilled(results[6]),
        storage: fulfilled(results[7]),
      });
      setError(devices ? '' : results[0].status === 'rejected' ? errorMessage(results[0].reason) : '');
      setUpdatedAt(new Date());
      setLoading(false);
    };
    void load(false);
    if (!canSeeGroupData) return () => { active = false; };
    const timer = globalThis.setInterval(() => void load(true), REFRESH_MS);
    return () => { active = false; globalThis.clearInterval(timer); };
  }, [refresh, canSeeGroupData, canSeePlatform, canSeeStorage]);

  const deviceTotal = data.devices?.total_count;
  const online = data.devices?.summary.online;
  const offline = data.devices?.summary.offline;
  const offlineAttention = totalOf(data.offline);
  const pending = totalOf(data.pending);
  const failed = totalOf(data.failed);
  const recordings = totalOf(data.recordings);
  const alerts = countOf(data.platform?.security_alerts?.open);
  const criticalAlerts = countOf(data.platform?.security_alerts?.critical);
  const applications = countOf(data.platform?.applications?.total);
  const activeApplications = countOf(data.platform?.applications?.active);
  const usage = data.storage && data.storage.max_storage_bytes > 0 ? data.storage.stored_bytes / data.storage.max_storage_bytes : undefined;
  const freeBytes = data.storage ? Math.max(0, data.storage.max_storage_bytes - data.storage.stored_bytes) : undefined;
  const storageTone: Tone | undefined = usage === undefined || !data.storage ? undefined
    : usage >= data.storage.stop_ratio ? 'danger'
      : usage >= data.storage.warning_ratio ? 'warning'
        : undefined;
  const noDevices = canSeeGroupData && deviceTotal === 0;
  const healthy = health === 'ready';

  const offlineNames = (data.offline?.items ?? []).slice(0, 3).map(deviceName);
  const attention: Attention[] = [];
  if (offlineAttention && offlineAttention > 0) {
    attention.push({
      key: 'offline', tone: 'warning', icon: 'device',
      title: t('{count} devices offline', { count: offlineAttention }),
      detail: offlineNames.length ? t('Offline: {names}', { names: offlineNames.join(', ') }) : t('A device has not contacted the server recently.'),
      action: t('View devices'), target: 'devices',
    });
  }
  if (failed && failed > 0) {
    attention.push({
      key: 'failed', tone: 'danger', icon: 'pulse',
      title: t('{count} recordings failed to sync', { count: failed }),
      detail: t('Check the recording library and retry the upload.'),
      action: t('View recordings'), target: 'files', recordingStatus: 'failed',
    });
  }
  if (canSeePlatform && alerts && alerts > 0) {
    attention.push({
      key: 'alerts', tone: criticalAlerts ? 'danger' : 'warning', icon: 'shield',
      title: t('{count} open security alerts', { count: alerts }),
      detail: t('Review credentials and open-platform activity.'),
      action: t('Review alerts'), target: 'security-alerts',
    });
  }
  if (canSeeStorage && storageTone && usage !== undefined) {
    attention.push({
      key: 'storage', tone: storageTone, icon: 'storage',
      title: t('Storage at {percent}', { percent: percent(usage) }),
      detail: t('Writes may stop when the configured limit is reached.'),
      action: t('Storage settings'), target: 'storage',
    });
  }

  const kpis: Kpi[] = [
    { key: 'devices', label: t('Devices'), value: number(deviceTotal), sub: data.devices ? t('{online} online · {offline} offline', { online: number(online), offline: number(offline) }) : t('Unavailable'), icon: 'device', target: 'devices' },
    { key: 'pending', label: t('Pending sync'), value: number(pending), sub: pending === undefined ? t('Unavailable') : t('Recordings waiting'), icon: 'transfer', target: 'files' },
    { key: 'failed', label: t('Sync failures'), value: number(failed), sub: failed === undefined ? t('Unavailable') : failed > 0 ? t('Needs attention') : t('None'), icon: 'pulse', target: 'files', recordingStatus: 'failed', ...(failed && failed > 0 ? { tone: 'danger' as const } : {}) },
    { key: 'recordings', label: t('Recordings'), value: number(recordings), sub: recordings === undefined ? t('Unavailable') : t('Total recordings'), icon: 'file', target: 'files' },
    ...(canSeeStorage ? [{ key: 'storage', label: t('Storage'), value: usage === undefined ? '—' : percent(usage), sub: freeBytes === undefined ? t('Unavailable') : t('{free} free', { free: bytes(freeBytes) }), icon: 'storage' as const, target: 'storage' as const, ...(storageTone ? { tone: storageTone } : {}) }] : []),
  ];

  const events = (data.events?.items ?? []).slice(0, 5);
  const devices = (data.devices?.items ?? []).slice(0, 6);
  const bannerWarning = noGroup || !healthy || Boolean(error) || attention.length > 0;
  const headline = noGroup ? t('No device group assigned')
    : !healthy ? t('Server {status}', { status: t(health) })
      : attention.length ? t('{count} items need attention', { count: attention.length })
        : isSystemAdmin ? t('All systems operational') : t('Your group is up to date');
  const detail = noGroup ? t('Ask a System Administrator to add this account to a device group.')
    : !healthy ? t('Some server features may be unavailable.')
      : attention.length ? t('Review the items below before they affect recordings or AI access.')
        : isSystemAdmin ? t('Devices, synchronization and AI access are ready.')
          : isGroupAdmin ? t('Your group devices and recordings are ready.')
            : t('A read-only view of devices and recordings in your group.');

  return <div className="overview-page" aria-busy={loading}>
    <section className={`overview-banner ${bannerWarning ? 'has-attention' : 'is-clear'}`}>
      <div className="overview-banner-main">
        <span className={`health-dot ${healthy && !noGroup ? 'health-ready' : health === 'draining' ? 'health-draining' : ''}`}/>
        <div><strong>{headline}</strong><p>{detail}</p></div>
      </div>
      <div className="overview-banner-actions">
        <span className="overview-updated">{updatedAt ? t('Updated {time}', { time: time(updatedAt) }) : t('Loading…')}</span>
        <Button kind="ghost" icon="refresh" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{t('Refresh')}</Button>
        {canProvision && !noGroup ? <Button icon="provision" onClick={() => onNavigate('provision')}>{t('Add device')}</Button> : null}
      </div>
    </section>

    {noGroup ? <section className="overview-card overview-no-group">
      <header className="overview-card-header"><div><p className="eyebrow">{t('Account setup')}</p><h2>{t('No device group assigned')}</h2><p>{t('This account can sign in, but it has no devices or recordings to show until a System Administrator adds it to a group.')}</p></div></header>
      <div className="overview-card-body"><p>{t('Ask a System Administrator to open Users and assign this account to a group.')}</p></div>
    </section> : <>
      {error ? <div className="inline-alert inline-alert-error" role="alert"><p>{t('Overview data could not be loaded.')} {error}</p><Button kind="secondary" onClick={() => setRefresh((value) => value + 1)}>{t('Try again')}</Button></div> : null}

      <section className="overview-kpis" aria-label={t('Overview metrics')}>
        {kpis.map((kpi) => <button type="button" key={kpi.key} className={`overview-kpi ${kpi.tone ? `is-${kpi.tone}` : ''}`} disabled={kpi.disabled} onClick={() => onNavigate(kpi.target, kpi.recordingStatus ? { recordingStatus: kpi.recordingStatus } : undefined)}>
          <span className="overview-kpi-icon"><Icon name={kpi.icon} size={19}/></span>
          <span className="overview-kpi-copy"><span className="overview-kpi-label">{kpi.label}</span><strong className="overview-kpi-value">{kpi.value}</strong><span className="overview-kpi-sub">{kpi.sub}</span></span>
          {!kpi.disabled ? <Icon name="arrow" size={15}/> : null}
        </button>)}
      </section>

      <div className="overview-grid">
        <div className="overview-main">
          {noDevices ? (canProvision ? <section className="overview-card overview-onboarding">
            <header className="overview-card-header"><div><p className="eyebrow">{t('Getting started')}</p><h2>{t('Add your first device')}</h2><p>{t('Connect Bluetooth, then Wi-Fi. Recordings will appear here after synchronization.')}</p></div></header>
            <div className="overview-onboarding-steps">
              <article><span className="overview-step-number">1</span><strong>{t('Add device')}</strong><p>{t('Bluetooth and Wi-Fi')}</p><Button onClick={() => onNavigate('provision')}>{t('Add device')}</Button></article>
              <article><span className="overview-step-number">2</span><strong>{t('Record and sync')}</strong><p>{t('Make a recording; the device uploads it when online.')}</p><Button kind="secondary" onClick={() => onNavigate('files')}>{t('View recordings')}</Button></article>
              <article><span className="overview-step-number">3</span><strong>{t('Connect AI tools')}</strong><p>{t('Choose an AI tool and authorize access to recordings.')}</p><Button kind="secondary" onClick={() => onNavigate('open-platform')}>{t('Connect AI tools')}</Button></article>
            </div>
          </section> : <section className="overview-card">
            <header className="overview-card-header"><div><h2>{t('This group has no devices yet')}</h2><p>{t('Ask a Group Admin to add a device to this group.')}</p></div></header>
          </section>) : <>
            <section className="overview-card">
              <header className="overview-card-header"><div><h2>{t('Needs attention')}</h2><p>{t('Items that can block synchronization or AI access.')}</p></div>{attention.length ? <span className="overview-count">{attention.length}</span> : null}</header>
              <div className="overview-card-body">
                {attention.length ? <div className="overview-attention-list">{attention.map((item) => <div className={`overview-attention-row is-${item.tone}`} key={item.key}>
                  <span className="overview-attention-icon"><Icon name={item.icon} size={16}/></span>
                  <div><strong>{item.title}</strong><p>{item.detail}</p></div>
                  <Button kind="ghost" onClick={() => onNavigate(item.target, item.recordingStatus ? { recordingStatus: item.recordingStatus } : undefined)}>{item.action}</Button>
                </div>)}</div> : <div className="overview-clear"><span><Icon name="check" size={18}/></span><div><strong>{t('All clear')}</strong><p>{t('No actionable offline devices, failed syncs, or open alerts.')}</p></div></div>}
              </div>
            </section>

            <section className="overview-card">
              <header className="overview-card-header"><div><h2>{t('Devices')}</h2><p>{data.devices ? t('{count} matching devices', { count: number(deviceTotal) }) : t('Unavailable')}</p></div><Button kind="ghost" onClick={() => onNavigate('devices')}>{t('View all')}</Button></header>
              <div className="overview-card-body overview-card-body-flush">
                {data.devices === undefined ? <div className="overview-empty-inline"><strong>{t('Unavailable')}</strong></div> : devices.length ? <div className="overview-table-wrap"><table className="overview-device-table">
                  <thead><tr><th>{t('Device')}</th><th>{t('Connection')}</th><th>{t('Group')}</th><th>{t('Last online')}</th></tr></thead>
                  <tbody>{devices.map((device) => <tr key={String(device.id)}>
                    <td><button type="button" className="overview-device-button" onClick={() => onSelectDevice(String(device.id))}><Icon name="device" size={16}/><span><strong>{deviceName(device)}</strong><small>{String(device.sn ?? '')}</small></span></button></td>
                    <td data-label={t('Connection')}><span className={`overview-status ${device.online === true ? 'is-online' : ''}`}><i/>{t(device.online === true ? 'Server online' : 'Server offline')}</span></td>
                    <td data-label={t('Group')}>{String(device.group_name ?? device.group_id ?? '—')}</td>
                    <td data-label={t('Last online')}>{when(device.last_seen_at)}</td>
                  </tr>)}</tbody>
                </table></div> : <div className="overview-empty-inline"><strong>{t('No devices yet')}</strong><p>{t('Add your first device to start syncing recordings.')}</p>{canProvision ? <Button kind="secondary" onClick={() => onNavigate('provision')}>{t('Add device')}</Button> : null}</div>}
              </div>
            </section>
          </>}
        </div>

        <aside className="overview-side">
          <section className="overview-card">
            <header className="overview-card-header"><div><h2>{t('System health')}</h2><p>{t('Server, storage and AI access at a glance.')}</p></div></header>
            <div className="overview-card-body">
              <div className="overview-health-row"><span className="overview-health-label">{t('Server')}</span><span className="overview-health-value"><i className={`health-dot ${healthy ? 'health-ready' : health === 'draining' ? 'health-draining' : ''}`}/>{t(health)}</span></div>
              {canSeeStorage && data.storage ? <div className="overview-health-row"><span className="overview-health-label">{t('Storage')}</span><span className="overview-health-value">{usage === undefined ? t('Unavailable') : percent(usage)}</span></div> : null}
              {canSeeStorage && usage !== undefined ? <div className="overview-meter" role="progressbar" aria-label={t('Storage')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(usage * 100))}><span style={{ width: `${Math.min(100, usage * 100)}%` }}/></div> : null}
              {canSeePlatform && data.platform ? <div className="overview-health-row"><span className="overview-health-label">{t('Open platform')}</span><span className="overview-health-value">{applications === undefined ? t('Unavailable') : t('{active}/{total} applications', { active: number(activeApplications), total: number(applications) })}{alerts ? ` · ${t('{count} open alerts', { count: alerts })}` : ''}</span></div> : null}
              {recordings !== undefined ? <div className="overview-health-row"><span className="overview-health-label">{t('Recordings')}</span><span className="overview-health-value">{number(recordings)}</span></div> : null}
            </div>
          </section>

          <section className="overview-card">
            <header className="overview-card-header"><div><h2>{t('Recent activity')}</h2><p>{t('The latest events from your devices and server.')}</p></div><Button kind="ghost" onClick={() => onNavigate('events')}>{t('View all')}</Button></header>
            <div className="overview-card-body">
              {data.events === undefined ? <p className="overview-empty-inline">{t('Unavailable')}</p> : events.length ? <div className="overview-activity">{events.map((item) => <div className="overview-activity-row" key={item.id}>
                <i/>
                <div><strong className="overview-activity-type">{eventLabel(item.type)}</strong><small className="overview-activity-meta">{eventMeta(item) || '—'}</small></div>
                <time className="overview-activity-time" dateTime={item.created_at}>{when(item.created_at)}</time>
              </div>)}</div> : <p className="overview-empty-inline">{t('No recent events.')}</p>}
            </div>
          </section>
        </aside>
      </div>
    </>}
  </div>;
}
