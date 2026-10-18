import { useEffect, useState } from 'react';
import { api, errorMessage } from './api.js';
import { Button, Field, Icon, Select, collectionOf } from './ui.js';
import type { Translate } from './ui.js';

type Device = Record<string, unknown>;
export type DevicePage = { items: readonly Device[]; total_count: number; summary: { online: number; offline: number }; next_cursor: string | null };
type Filters = { search: string; online: string; group: string; cursor: string };
export function deviceListPath({ search, online, group, cursor }: Filters): string {
  const query = new URLSearchParams({ limit: '25' });
  if (search.trim()) query.set('search', search.trim());
  if (online) query.set('online', online);
  if (group) query.set('group_id', group);
  if (cursor) query.set('cursor', cursor);
  return `/admin/devices?${query}`;
}

type ListProps = {
  t: Translate; data?: DevicePage | undefined; groups: readonly Device[];
  search: string; online: string; group: string; page: number; loading: boolean; error: string;
  onSearch: (value: string) => void; onOnline: (value: string) => void; onGroup: (value: string) => void;
  onSelect: (id: string) => void; onRefresh: () => void; onPrevious: () => void; onNext: () => void;
};
function lastSeen(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '—';
  return new Date(value).toLocaleString(globalThis.document?.documentElement.lang || 'zh-CN', { hour12: false });
}
export function DeviceFleetView({ t, data, groups, search, online, group, page, loading, error, onSearch, onOnline, onGroup, onSelect, onRefresh, onPrevious, onNext }: ListProps) {
  return <section className="content-card device-fleet" aria-busy={loading}>
    <header className="fleet-heading"><div><h2>{t('Device list')}</h2><p>{t('Select a device to manage its recordings, connection and settings.')}</p></div><Button kind="ghost" icon="refresh" disabled={loading} onClick={onRefresh}>{t('Refresh')}</Button></header>
    <div className="fleet-filters">
      <Field id="fleet-search" label={t('Search devices')} placeholder={t('Device name or serial number')} value={search} onChange={onSearch} maxLength={128}/>
      <Field id="fleet-online" label={t('Server connection')}><Select id="fleet-online" ariaLabel={t('Server connection')} value={online} onChange={onOnline} options={[{ value: '', label: t('All connection states') }, { value: 'true', label: t('Server online') }, { value: 'false', label: t('Server offline') }]}/></Field>
      <Field id="fleet-group" label={t('Group')}><Select id="fleet-group" ariaLabel={t('Group')} value={group} onChange={onGroup} options={[{ value: '', label: t('All authorized groups') }, ...groups.map((item) => ({ value: String(item.id), label: String(item.name) }))]}/></Field>
    </div>
    {error ? <div className="inline-alert inline-alert-error" role="alert"><p>{error}</p><Button kind="secondary" onClick={onRefresh}>{t('Try again')}</Button></div> : null}
    {data ? <p className="fleet-count" role="status">{t('{count} matching devices', { count: data.total_count.toLocaleString() })}<span>{t('{count} online', { count: data.summary.online.toLocaleString() })}</span><span>{t('{count} offline', { count: data.summary.offline.toLocaleString() })}</span></p> : loading ? <p className="fleet-count" role="status">{t('Loading devices…')}</p> : null}
    {data?.items.length ? <div className="fleet-table-wrap"><table className="data-table fleet-table"><thead><tr>{['Device', 'Server connection', 'Group', 'Model', 'Firmware', 'Last online'].map((label) => <th key={label} scope="col">{t(label)}</th>)}</tr></thead><tbody>{data.items.map((device) => <tr key={String(device.id)}>
      <td data-label={t('Device')}><button type="button" className="fleet-device-link" onClick={() => onSelect(String(device.id))}><Icon name="device"/><span><strong>{String(device.display_name || device.sn)}</strong><small>{String(device.sn)}</small></span><Icon name="arrow" size={14}/></button></td>
      <td data-label={t('Server connection')}><span className={`fleet-status ${device.online === true ? 'is-online' : 'is-offline'}`}><i/>{t(device.online === true ? 'Server online' : 'Server offline')}</span></td>
      <td data-label={t('Group')}>{String(device.group_name || device.group_id || '—')}</td>
      <td data-label={t('Model')}>{String(device.model || '—')}</td>
      <td data-label={t('Firmware')}>{String(device.firmware_version || '—')}</td>
      <td data-label={t('Last online')}>{lastSeen(device.last_seen_at)}</td>
    </tr>)}</tbody></table></div> : data && !loading ? <div className="fleet-empty"><Icon name="device" size={24}/><h3>{t(search || online || group ? 'No matching devices' : 'No devices yet')}</h3><p>{t(search || online || group ? 'Try another name, serial number or filter.' : 'Use Add device to connect your first recorder.')}</p></div> : null}
    <nav className="table-pagination" aria-label={t('Pagination')}><Button kind="ghost" disabled={page === 0 || loading} onClick={onPrevious}>{t('Previous')}</Button><span>{t('Page {page}', { page: page + 1 })}</span><Button kind="ghost" disabled={!data?.next_cursor || loading} onClick={onNext}>{t('Next')}</Button></nav>
  </section>;
}

export function DeviceFleet({ t, onSelect, active }: { t: Translate; onSelect: (id: string) => void; active: boolean }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState({ search: '', online: '', group: '', cursors: [''], page: 0 });
  const [groups, setGroups] = useState<readonly Device[]>([]);
  const [groupError, setGroupError] = useState('');
  const [data, setData] = useState<DevicePage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { const timer = globalThis.setTimeout(() => setQuery((current) => current.search === search.trim() ? current : { ...current, search: search.trim(), cursors: [''], page: 0 }), 300); return () => globalThis.clearTimeout(timer); }, [search]);
  useEffect(() => { let live = true; void api('/user-groups').then((value) => { if (live) { setGroups(collectionOf(value)); setGroupError(''); } }, () => { if (live) setGroupError(t('Group filter could not be loaded. Refresh to retry.')); }); return () => { live = false; }; }, [refresh]);
  useEffect(() => {
    if (!active) return;
    let live = true; setData(undefined);
    const load = async (quiet = false): Promise<void> => {
      if (!quiet) setLoading(true);
      try { const next = await api<DevicePage>(deviceListPath({ ...query, cursor: query.cursors[query.page] ?? '' })); if (live) { setData(next); setError(''); } }
      catch (cause) { if (live) { setError(errorMessage(cause)); setData(undefined); } }
      finally { if (live) setLoading(false); }
    };
    void load(); const timer = globalThis.setInterval(() => void load(true), 15_000);
    return () => { live = false; globalThis.clearInterval(timer); };
  }, [active, query, refresh]);
  const filter = (key: 'online' | 'group', value: string): void => setQuery((current) => ({ ...current, [key]: value, cursors: [''], page: 0 }));
  return <div hidden={!active}>{groupError ? <p className="inline-alert" role="alert">{groupError}</p> : null}<DeviceFleetView t={t} data={data} groups={groups} search={search} online={query.online} group={query.group} page={query.page} loading={loading} error={error} onSearch={setSearch} onOnline={(value) => filter('online', value)} onGroup={(value) => filter('group', value)} onSelect={onSelect} onRefresh={() => setRefresh((value) => value + 1)} onPrevious={() => setQuery((current) => ({ ...current, page: Math.max(0, current.page - 1) }))} onNext={() => { if (data?.next_cursor) { const next = data.next_cursor; setQuery((current) => ({ ...current, page: current.page + 1, cursors: [...current.cursors.slice(0, current.page + 1), next] })); } }}/></div>;
}
