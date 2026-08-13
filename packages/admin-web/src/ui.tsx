import { useEffect, useMemo, useRef, useState } from 'react';
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { api, errorMessage } from './api.js';

export type Translate = (message: string, values?: Readonly<Record<string, string | number>>) => string;

type IconName = 'overview' | 'device' | 'file' | 'group' | 'user' | 'token' | 'webhook' | 'pulse' | 'storage' | 'battery' | 'wifi' | 'microphone' | 'shield' | 'clock' | 'server' | 'audit' | 'code' | 'provision' | 'transfer' | 'menu' | 'close' | 'refresh' | 'arrow' | 'check' | 'copy' | 'logout' | 'globe';

const iconPaths: Record<IconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  device: <><rect x="6" y="2" width="12" height="20" rx="5"/><path d="M10 18h4"/><circle cx="12" cy="6" r=".7" fill="currentColor" stroke="none"/></>,
  file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></>,
  group: <><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><path d="M3 20c0-4 2-6 6-6s6 2 6 6M15 15c3 0 5 2 5 5"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 22c0-5 3-8 8-8s8 3 8 8"/></>,
  token: <><circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3M20 12v2"/></>,
  webhook: <><circle cx="12" cy="5" r="3"/><circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/><path d="M10 7 7 14M14 7l3 7M8 17h8"/></>,
  pulse: <path d="M2 12h4l2-6 4 12 3-8 2 2h5"/>,
  storage: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 2 4 3 8 3s8-1 8-3V5M4 12v7c0 2 4 3 8 3s8-1 8-3v-7"/></>,
  battery: <><rect x="3" y="7" width="17" height="10" rx="2"/><path d="M20 10h2v4h-2M7 10v4M10 10v4M13 10v4"/></>,
  wifi: <><path d="M3 9c5-4 13-4 18 0M6 13c3.5-2.8 8.5-2.8 12 0M9.5 17c1.5-1 3.5-1 5 0"/><circle cx="12" cy="20" r=".8" fill="currentColor" stroke="none"/></>,
  microphone: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/></>,
  shield: <><path d="M12 3 5 6v5c0 5 2.5 8 7 10 4.5-2 7-5 7-10V6z"/><path d="m9 12 2 2 4-5"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  server: <><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 7h.01M8 18h.01M12 7h5M12 18h5"/></>,
  audit: <><path d="M12 3 4 6v6c0 5 3 8 8 10 5-2 8-5 8-10V6z"/><path d="m9 12 2 2 4-5"/></>,
  code: <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></>,
  provision: <><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="4"/></>,
  transfer: <><path d="M5 7h13M14 3l4 4-4 4M19 17H6M10 13l-4 4 4 4"/></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></>,
  arrow: <path d="m9 18 6-6-6-6"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></>,
  logout: <><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M14 8l4 4-4 4M8 12h10"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></>,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>;
}

export function Button({ children, icon, kind = 'primary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; kind?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button {...props} className={`button button-${kind} ${className}`.trim()}>{icon ? <Icon name={icon} /> : null}<span>{children}</span></button>;
}

export type SelectOption = { value: string; label: string; description?: string | undefined; meta?: string | undefined; disabled?: boolean | undefined };

export function Select({ id, value, options, onChange, placeholder = 'Select', ariaLabel, compact = false, searchable }: {
  id?: string | undefined; value: string; options: readonly SelectOption[]; onChange: (value: string) => void; placeholder?: string | undefined; ariaLabel?: string | undefined; compact?: boolean | undefined; searchable?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);
  const showSearch = searchable ?? options.length > 7;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = normalizedQuery ? options.filter((option) => `${option.label} ${option.description ?? ''} ${option.meta ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)) : options;
  useEffect(() => {
    const close = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, []);
  return <div ref={root} className={`select ${compact ? 'select-compact' : ''} ${open ? 'select-open' : ''}`}>
    <button id={id} type="button" className="select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={() => { setOpen((current) => !current); setQuery(''); }}>
      <span className="select-value"><strong>{selected?.label ?? placeholder}</strong>{selected?.description ? <small>{selected.description}</small> : null}</span>{selected?.meta ? <span className="select-meta">{selected.meta}</span> : null}<Icon name="arrow" size={15}/>
    </button>
    {open ? <div className="select-popover">{showSearch ? <input className="select-search" autoFocus placeholder="Search…" value={query} onChange={(event) => setQuery(event.target.value)}/> : null}<div className="select-options" role="listbox" aria-label={ariaLabel}>{visibleOptions.map((option) => <button type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className="select-option" key={option.value} onClick={() => { onChange(option.value); setOpen(false); setQuery(''); }}><span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>{option.meta ? <span className="select-option-meta">{option.meta}</span> : null}{option.value === value ? <Icon name="check" size={15}/> : null}</button>)}{visibleOptions.length === 0 ? <div className="select-empty">No matching options</div> : null}</div></div> : null}
  </div>;
}

export function Field({ label, hint, value, onChange, type = 'text', options, id, required = false, wide = false, placeholder, minLength, maxLength, children }: {
  label: string; hint?: string; value?: string; onChange?: (value: string) => void; type?: string; options?: readonly SelectOption[]; id?: string; required?: boolean; wide?: boolean; placeholder?: string; minLength?: number; maxLength?: number; children?: ReactNode;
}) {
  return <label className={`field ${wide ? 'field-wide' : ''}`} htmlFor={id}><span className="field-label">{label}{required ? <span className="required"> *</span> : null}</span>{hint ? <span className="field-hint">{hint}</span> : null}{children ?? (options
    ? <Select id={id} ariaLabel={label} value={value ?? ''} options={options} placeholder={placeholder ?? label} onChange={(next) => onChange?.(next)}/>
    : <input id={id} value={value} type={type} required={required} minLength={minLength} maxLength={maxLength} placeholder={placeholder} autoComplete={type === 'password' ? 'off' : undefined} onChange={(event) => onChange?.(event.target.value)} />)}</label>;
}

function collectionOf(data: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  if (!data || typeof data !== 'object') return [];
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  }
  return [];
}

const secretKey = /(?:password|secret|token|ciphertext|signature|private[_-]?key)/i;
const idKey = /(?:^id$|_id$)/;
const timeKey = /(?:^|_)(?:created|updated|started|ended|seen|synced|expires|expired|used|delivered|requested|completed|failed|revoked|activates|attempt)(?:_at)?$/i;

function safeColumns(records: readonly Record<string, unknown>[]): readonly string[] {
  const priority = ['display_name', 'name', 'username', 'sn', 'type', 'action', 'manufacturer', 'model', 'status', 'result', 'state', 'role', 'online', 'url', 'content_length', 'created_at', 'updated_at'];
  const available = new Set(records.flatMap((record) => Object.keys(record)).filter((key) => !secretKey.test(key) && !idKey.test(key) && key !== 'api_version' && key !== 'data' && key !== 'payload_json'));
  return [...priority.filter((key) => available.has(key)), ...[...available].filter((key) => !priority.includes(key) && typeof records.find((record) => record[key] !== undefined)?.[key] !== 'object')].slice(0, 7);
}

export function formatLocalDateTime(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}

function parseStructured(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim().startsWith('{') && !value.trim().startsWith('[')) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 || unit === 0 ? size.toFixed(unit === 0 ? 0 : 1) : size.toFixed(2)} ${units[unit]}`;
}

function compactStructuredValue(value: unknown, key = '', parentKey = ''): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return `${value.length} items`;
  if (timeKey.test(key) && Number.isFinite(Date.parse(String(value)))) return formatLocalDateTime(value);
  if (typeof value === 'number' && (/(?:^|_)bytes?$/.test(key) || parentKey === 'capacity' && /^(?:total|available)$/.test(key))) return formatBytes(value);
  if (typeof value === 'number' && /ratio$/i.test(key)) return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).slice(0, 3).map(([nestedKey, item]) => `${nestedKey.replaceAll('_', ' ')}: ${typeof item === 'object' ? '…' : compactStructuredValue(item, nestedKey, key)}`).join(' · ');
  return String(value);
}

function StructuredData({ value, t, parentKey = '' }: { value: unknown; t: Translate; parentKey?: string }) {
  const parsed = parseStructured(value);
  if (!parsed || typeof parsed !== 'object') return <span>{String(parsed ?? '—')}</span>;
  const entries = Object.entries(parsed as Record<string, unknown>);
  return <div className="structured-data">{entries.slice(0, 6).map(([key, item]) => <div key={key}><span>{t(key.replaceAll('_', ' '))}</span><strong>{compactStructuredValue(item, key, parentKey)}</strong></div>)}{entries.length > 6 ? <small>+{entries.length - 6}</small> : null}</div>;
}

function displayValue(key: string, value: unknown, t: Translate): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="empty-value">—</span>;
  if (typeof value === 'boolean') return t(value ? 'Yes' : 'No');
  if (timeKey.test(key) && Number.isFinite(Date.parse(String(value)))) return <time dateTime={String(value)} title={String(value)}>{formatLocalDateTime(value)}</time>;
  if (typeof value === 'number' && /(?:^|_)bytes?$/.test(key)) return formatBytes(value);
  if (typeof value === 'number' && /ratio$/i.test(key)) return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'object' || parseStructured(value) !== value) return <StructuredData value={value} t={t} parentKey={key}/>;
  return typeof value === 'string' ? t(value) : String(value);
}

function isStatusColumn(key: string): boolean { return /status|state|enabled|online|disabled/i.test(key); }

export function DataTable({ data, t, emptyMessage, onSelect, maxRows, pageSize = 12, className = '' }: { data: unknown; t: Translate; emptyMessage?: string; onSelect?: (record: Record<string, unknown>) => void; maxRows?: number; pageSize?: number; className?: string }) {
  const records = useMemo(() => collectionOf(data), [data]);
  const [page, setPage] = useState(0);
  const totalPages = maxRows ? 1 : Math.max(1, Math.ceil(records.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const visibleRecords = maxRows ? records.slice(0, maxRows) : records.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const columns = useMemo(() => safeColumns(records), [records]);
  const [expanded, setExpanded] = useState('');
  useEffect(() => { setPage(0); setExpanded(''); }, [records.length]);
  const details = useMemo(() => data && typeof data === 'object' && !Array.isArray(data) && !Object.values(data).some(Array.isArray)
    ? Object.entries(data).filter(([key]) => !secretKey.test(key)).slice(0, 24)
    : [], [data]);
  if (!records.length && details.length) return <dl className="detail-grid">{details.map(([key, value]) => <div key={key}><dt>{t(key.replaceAll('_', ' '))}</dt><dd>{isStatusColumn(key) ? <span className={`status-pill status-${String(value).toLowerCase().replaceAll('_', '-')}`}>{displayValue(key, value, t)}</span> : displayValue(key, value, t)}</dd></div>)}</dl>;
  if (!records.length) return <div className="empty-state"><div className="empty-orbit"><Icon name="pulse" size={24} /></div><h3>{t('Nothing here yet')}</h3><p>{emptyMessage ?? t('New resources will appear here when they are created.')}</p></div>;
  return <div className={`table-wrap ${className}`.trim()}><table className="data-table"><thead><tr>{columns.map((column) => <th key={column}>{t(column.replaceAll('_', ' '))}</th>)}<th><span className="sr-only">{t('Actions')}</span></th></tr></thead><tbody>{visibleRecords.map((record, index) => { const key = String(record.id ?? currentPage * pageSize + index); const isExpanded = expanded === key; return <Fragment key={key}><tr className="row-interactive" onClick={() => onSelect ? onSelect(record) : setExpanded(isExpanded ? '' : key)}>{columns.map((column) => <td key={column}>{isStatusColumn(column) ? <span className={`status-pill status-${String(record[column]).toLowerCase().replaceAll('_', '-')}`}>{displayValue(column, record[column], t)}</span> : displayValue(column, record[column], t)}</td>)}<td className={`row-arrow ${isExpanded ? 'is-expanded' : ''}`}><Icon name="arrow" /></td></tr>{isExpanded && !onSelect ? <tr className="table-detail-row"><td colSpan={columns.length + 1}><div className="table-record-detail"><dl>{Object.entries(record).filter(([field]) => !secretKey.test(field)).map(([field, value]) => <div key={field}><dt>{t(field.replaceAll('_', ' '))}</dt><dd>{idKey.test(field) ? <code>{String(value ?? '—')}</code> : displayValue(field, value, t)}</dd></div>)}</dl></div></td></tr> : null}</Fragment>; })}</tbody></table>{maxRows && records.length > maxRows ? <div className="table-limit-note">{t('Showing the latest {count} items.', { count: maxRows })}</div> : null}{!maxRows && totalPages > 1 ? <nav className="table-pagination" aria-label={t('Pagination')}><Button kind="ghost" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>{t('Previous')}</Button><span>{t('Page {page} of {total}', { page: currentPage + 1, total: totalPages })}</span><Button kind="ghost" disabled={currentPage >= totalPages - 1} onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))}>{t('Next')}</Button></nav> : null}</div>;
}

export function ResourcePicker({ label, endpoint, value, onChange, t, id, required = false, emptyLabel, selectFirst = false }: { label: string; endpoint: string; value: string; onChange: (value: string) => void; t: Translate; id: string; required?: boolean; emptyLabel?: string; selectFirst?: boolean }) {
  const [items, setItems] = useState<readonly Record<string, unknown>[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let active = true;
    void api(endpoint).then((result) => { if (active) { const loaded = collectionOf(result); setItems(loaded); setState('ready'); if (selectFirst && !value && loaded[0]?.id !== undefined) onChange(String(loaded[0].id)); } }, () => { if (active) setState('error'); });
    return () => { active = false; };
  }, [endpoint]);
  const title = (item: Record<string, unknown>): string => String(item.display_name ?? item.name ?? item.username ?? item.sn ?? item.url ?? t('Unnamed resource'));
  const description = (item: Record<string, unknown>): string => [item.display_name ? item.sn : null, item.model, item.username !== title(item) ? item.username : null, item.role].filter(Boolean).map(String).join(' · ');
  const options = items.map((item) => ({ value: String(item.id), label: title(item), description: description(item) || undefined, meta: item.online === undefined ? item.status ? t(String(item.status)) : undefined : t(item.online ? 'Online' : 'Offline') }));
  return <Field label={label} id={id} required={required}><Select id={id} value={value} options={options} ariaLabel={label} searchable placeholder={state === 'loading' ? t('Loading options…') : state === 'error' ? t('Could not load options') : emptyLabel ?? t('Select a resource')} onChange={onChange}/></Field>;
}

export function Stepper({ steps, current, t }: { steps: readonly string[]; current: number; t: Translate }) {
  return <ol className="stepper" aria-label={t('Progress')}>{steps.map((step, index) => <li key={step} className={index < current ? 'step-complete' : index === current ? 'step-current' : ''} aria-current={index === current ? 'step' : undefined}><span className="step-marker">{index < current ? <Icon name="check" size={14} /> : index + 1}</span><span>{t(step)}</span></li>)}</ol>;
}

type RevealedSecret = { label: string; value: string };
const revealedSecretKeys = new Set(['token', 'secret', 'password', 'private_key', 'private-key', 'access_token', 'refresh_token', 'device_token', 'setup_token', 'transfer_token', 'client_secret']);

function revealedSecretLabel(key: string, value: string): string {
  if (value.startsWith('vcd_app_')) return 'Application token';
  if (value.startsWith('vce_')) return 'Webhook signing secret';
  return key.replaceAll('_', ' ').replaceAll('-', ' ');
}

function collectSecrets(data: unknown, output: RevealedSecret[] = []): RevealedSecret[] {
  if (!data || typeof data !== 'object') return output;
  for (const [key, value] of Object.entries(data)) {
    if (revealedSecretKeys.has(key.toLowerCase()) && typeof value === 'string' && value) output.push({ label: revealedSecretLabel(key, value), value });
    else if (typeof value === 'object') collectSecrets(value, output);
  }
  return output;
}

export function containsRevealedSecrets(data: unknown): boolean { return collectSecrets(data).length > 0; }

export function SecretRevealDialog({ result, onClose, t }: { result: unknown; onClose: () => void; t: Translate }) {
  const secrets = useMemo(() => collectSecrets(result), [result]);
  const [copied, setCopied] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);
  if (!secrets.length) return null;
  const copyAll = (): void => { void navigator.clipboard.writeText(secrets.map((item) => `${item.label}: ${item.value}`).join('\n')).then(() => setCopied('all')); };
  return <div className="secret-dialog-backdrop"><section className="secret-dialog" role="dialog" aria-modal="true" aria-labelledby="secret-dialog-title" aria-describedby="secret-dialog-description">
    <header><span className="secret-dialog-icon"><Icon name="shield" size={24}/></span><div><p className="eyebrow">{t('One-time credential')}</p><h2 id="secret-dialog-title">{t('Save this credential before continuing')}</h2><p id="secret-dialog-description">{t('For security, this value cannot be shown again after you close this dialog.')}</p></div></header>
    <div className="secret-dialog-values">{secrets.map((secret) => <div className="secret-dialog-value" key={secret.label}><span>{t(secret.label)}</span><code>{secret.value}</code><Button kind="secondary" icon={copied === secret.label ? 'check' : 'copy'} onClick={() => void navigator.clipboard.writeText(secret.value).then(() => setCopied(secret.label))}>{copied === secret.label ? t('Copied') : t('Copy')}</Button></div>)}</div>
    <div className="secret-dialog-actions"><Button kind="secondary" icon={copied === 'all' ? 'check' : 'copy'} onClick={copyAll}>{copied === 'all' ? t('Copied all') : t('Copy all')}</Button><label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}/><span>{t('I have stored this credential securely.')}</span></label><Button disabled={!acknowledged} onClick={onClose}>{t('Done')}</Button></div>
  </section></div>;
}

export function ResultPanel({ result, error, loading, t }: { result: unknown; error: string; loading: boolean; t: Translate }) {
  const [copied, setCopied] = useState('');
  const secrets = useMemo(() => collectSecrets(result), [result]);
  useEffect(() => { setCopied(''); }, [result]);
  if (loading) return <div className="loading-panel" role="status"><span className="spinner"/><span>{t('Loading…')}</span></div>;
  if (error) return <div className="error-panel" role="alert"><span className="error-mark">!</span><div><strong>{t('The operation could not be completed')}</strong><p>{error}</p></div></div>;
  if (result === undefined) return null;
  return <section className="result-panel" aria-live="polite">{secrets.length ? <div className="secret-stack"><div className="secret-warning"><strong>{t('Save this value now')}</strong><span>{t('It is displayed once and is not stored by this page.')}</span></div>{secrets.map((secret) => <div className="secret-field" key={secret.label}><span>{t(secret.label)}</span><code>{secret.value}</code><Button kind="secondary" icon={copied === secret.label ? 'check' : 'copy'} onClick={() => void navigator.clipboard.writeText(secret.value).then(() => setCopied(secret.label))}>{copied === secret.label ? t('Copied') : t('Copy')}</Button></div>)}</div> : <div className="operation-success"><span>✓</span><strong>{t('Operation completed')}</strong></div>}</section>;
}

export function FlowHeader({ eyebrow, title, description, icon }: { eyebrow: string; title: string; description: string; icon: IconName }) {
  // Page identity and description belong to App's single page header. Keep this
  // compatibility component temporarily while older workspaces are migrated.
  void eyebrow; void title; void description; void icon;
  return null;
}

export { collectionOf, errorMessage };
