import { createContext, useContext, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { decodeConnectCallback } from '@voicecan/device-connect-web';
import type { DeviceConnectCallback } from '@voicecan/device-connect-web';
import { api, errorMessage, setCsrfToken } from './api.js';
import { initialLocale, saveLocale, translate } from './i18n.js';
import type { Locale } from './i18n.js';
import { AdminWorkspace, labels, navGroups, resourcePaths } from './workspaces.js';
import { DeviceManagement } from './device-management.js';
import type { View } from './workspaces.js';
import { Button, containsRevealedSecrets, DataTable, Icon, ResultPanel, SecretRevealDialog, Select, Stepper, collectionOf } from './ui.js';
import type { Translate } from './ui.js';

type AuthMode = 'loading' | 'setup' | 'login' | 'ready';
type SessionUser = { username: string; role: string; membership_role?: string | null };
type ConnectReturn = { phase: 'checking' | 'completed' | 'failed'; message: string; deviceId?: string };

const LocaleContext = createContext<Locale>('en');

function viewFromLocation(): View {
  const value = new URLSearchParams(globalThis.location.search).get('view');
  return value && Object.hasOwn(labels, value) ? value as View : 'overview';
}

function updateViewLocation(view: View, mode: 'push' | 'replace' = 'push'): void {
  const url = new URL(globalThis.location.href);
  if (view === 'overview') url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  if (view !== 'devices') url.searchParams.delete('device');
  if (mode === 'push') globalThis.history.pushState({ view }, '', url);
  else globalThis.history.replaceState({ view }, '', url);
}

function oauthReturnFromLocation(): string | undefined {
  const encoded = new URLSearchParams(globalThis.location.search).get('oauth_return');
  if (!encoded) return undefined;
  try {
    const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), (character) => character.charCodeAt(0));
    const target = new URL(new TextDecoder().decode(decoded), globalThis.location.origin);
    return target.origin === globalThis.location.origin && target.pathname === '/oauth/authorize' ? target.href : undefined;
  } catch { return undefined; }
}

function takeConnectCallback(): DeviceConnectCallback | undefined {
  const fragment = new URLSearchParams(globalThis.location.hash.slice(1));
  const encoded = fragment.get('vc_connect');
  if (!encoded) return undefined;
  fragment.delete('vc_connect');
  const cleanUrl = new URL(globalThis.location.href);
  cleanUrl.hash = fragment.toString();
  globalThis.history.replaceState(globalThis.history.state, '', cleanUrl);
  const callback = decodeConnectCallback(encoded);
  if (!callback || callback.completedAt > Date.now() + 60_000 || Date.now() - callback.completedAt > 15 * 60_000) return undefined;
  const storageKey = `voicecan.connect.state.${callback.sessionId}`;
  if (globalThis.localStorage.getItem(storageKey) !== callback.state) return undefined;
  globalThis.localStorage.removeItem(storageKey);
  return callback;
}

function useTranslate(): Translate {
  const locale = useContext(LocaleContext);
  return (message, values) => translate(locale, message, values);
}

function navIcon(view: View): Parameters<typeof Icon>[0]['name'] {
  if (view === 'overview') return 'overview';
  if (view === 'devices') return 'device';
  if (view === 'files') return 'file';
  if (view === 'groups') return 'group';
  if (view === 'users') return 'user';
  if (view === 'open-platform' || view === 'open-platform-overview' || view === 'permission-catalog') return 'code';
  if (view === 'oauth-clients') return 'token';
  if (view === 'call-logs' || view === 'security-alerts') return 'audit';
  if (view === 'download-grants') return 'file';
  if (view === 'events' || view === 'inspector') return 'pulse';
  if (view === 'storage') return 'storage';
  if (view === 'audit') return 'audit';
  if (view === 'provision') return 'provision';
  if (view === 'device-settings') return 'provision';
  return 'transfer';
}

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [mode, setMode] = useState<AuthMode>('loading');
  const [health, setHealth] = useState('Checking…');
  const [notice, setNotice] = useState('Loading setup state…');
  const [user, setUser] = useState<SessionUser>();
  const [view, setView] = useState<View>(viewFromLocation);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [resourceData, setResourceData] = useState<unknown>();
  const [resourcePage, setResourcePage] = useState(0);
  const [resourceCursors, setResourceCursors] = useState<readonly string[]>(['']);
  const [operationResult, setOperationResult] = useState<unknown>();
  const [secretReveal, setSecretReveal] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingConnectReturn] = useState(takeConnectCallback);
  const [connectReturn, setConnectReturn] = useState<ConnectReturn>();
  const t: Translate = (message, values) => translate(locale, message, values);

  const refreshSession = async (): Promise<void> => {
    try {
      const ready = await fetch('/health/ready').then((response) => response.json()) as { data?: { status?: string } };
      setHealth(ready.data?.status ?? 'unknown');
      const setup = await api<{ status: string }>('/setup/status');
      if (setup.status === 'setup_pending') {
        setNotice(t('Setup is pending. This page does not retain the setup token.'));
        setUser(undefined);
        setMode('setup');
        return;
      }
      try {
        const authenticatedUser = await api<SessionUser>('/auth/me');
        const refreshedCsrf = await api<{ csrf_token: string }>('/auth/csrf');
        setCsrfToken(refreshedCsrf.csrf_token);
        setUser(authenticatedUser);
        setNotice(t('Signed in as {username} ({role})', { username: authenticatedUser.username, role: t(authenticatedUser.role.replaceAll('_', ' ')) }));
        setMode('ready');
      } catch {
        setUser(undefined);
        setNotice(t('Setup complete. Sign in with a local account.'));
        setMode('login');
      }
    } catch (sessionError) {
      setNotice(errorMessage(sessionError));
      setMode('login');
    }
  };

  const loadResource = async (selectedView: View, cursor = ''): Promise<void> => {
    const path = resourcePaths[selectedView];
    if (!path) return;
    const requestPath = cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path;
    setLoading(true);
    setError('');
    setOperationResult(undefined);
    try { setResourceData(await api(requestPath)); }
    catch (resourceError) { setError(errorMessage(resourceError)); setResourceData(undefined); }
    finally { setLoading(false); }
  };

  const run = async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    setLoading(true);
    setError('');
    try {
      const response = await operation();
      setOperationResult(response);
      if (containsRevealedSecrets(response)) setSecretReveal(response);
      return response;
    } catch (operationError) {
      setError(errorMessage(operationError));
      return undefined;
    } finally { setLoading(false); }
  };

  useEffect(() => { document.documentElement.lang = locale; saveLocale(locale); void refreshSession(); }, [locale]);
  useEffect(() => {
    const restoreView = (): void => setView(viewFromLocation());
    globalThis.addEventListener('popstate', restoreView);
    return () => globalThis.removeEventListener('popstate', restoreView);
  }, []);
  useEffect(() => {
    setResourceData(undefined);
    setOperationResult(undefined);
    setError('');
    setResourcePage(0);
    setResourceCursors(['']);
    if (mode === 'ready') void loadResource(view, '');
  }, [mode, view]);
  useEffect(() => {
    if (mode !== 'ready' || !pendingConnectReturn) return;
    setView('provision');
    updateViewLocation('provision', 'replace');
    if (!pendingConnectReturn.provisioningSessionId) {
      setConnectReturn({ phase: 'failed', message: t(pendingConnectReturn.error ?? 'The connector returned without a provisioning session.') });
      return;
    }
    let active = true;
    setConnectReturn({ phase: 'checking', message: t('Verifying the result with this server…') });
    void api<{ id: string; status: string; device_id?: string }>(`/provisioning-sessions/${encodeURIComponent(pendingConnectReturn.provisioningSessionId)}`).then((session) => {
      if (!active) return;
      const completed = pendingConnectReturn.result === 'completed' && session.status === 'completed';
      setConnectReturn({
        phase: completed ? 'completed' : 'failed',
        message: completed ? t('The device is online and the server confirmed binding.') : t('The connector returned, but the server reports status: {status}', { status: t(session.status) }),
        ...(session.device_id ? { deviceId: session.device_id } : {}),
      });
    }).catch((connectError) => {
      if (active) setConnectReturn({ phase: 'failed', message: errorMessage(connectError) });
    });
    return () => { active = false; };
  }, [mode, pendingConnectReturn]);

  const submitSetup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try { await api('/setup/admin', { method: 'POST', body: JSON.stringify(data) }); form.reset(); await refreshSession(); }
    catch (setupError) { setNotice(errorMessage(setupError)); }
  };

  const submitLogin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      const authenticated = await api<{ csrf_token: string }>('/auth/login', { method: 'POST', body: JSON.stringify(data) });
      setCsrfToken(authenticated.csrf_token);
      form.reset();
      const oauthReturn = oauthReturnFromLocation();
      if (oauthReturn) { globalThis.location.assign(oauthReturn); return; }
      await refreshSession();
    } catch (loginError) { setNotice(errorMessage(loginError)); }
  };

  const logout = async (): Promise<void> => {
    try { await api('/auth/logout', { method: 'POST', body: '{}' }); }
    finally { setCsrfToken(''); setView('overview'); updateViewLocation('overview', 'replace'); await refreshSession(); }
  };

  const selectView = (nextView: View): void => {
    if (nextView !== view) updateViewLocation(nextView);
    setView(nextView);
    setMobileNavOpen(false);
  };

  const selectDevice = (deviceId: string): void => {
    const url = new URL(globalThis.location.href);
    url.searchParams.set('view', 'devices');
    url.searchParams.set('device', deviceId);
    globalThis.history.pushState({ view: 'devices', deviceId }, '', url);
    setView('devices');
    setMobileNavOpen(false);
  };

  const releaseDevice = (deviceId: string): void => {
    const url = new URL(globalThis.location.href);
    url.searchParams.set('view', 'release');
    url.searchParams.set('device', deviceId);
    globalThis.history.pushState({ view: 'release', deviceId }, '', url);
    setView('release');
    setMobileNavOpen(false);
  };

  const cursorPaginated = view === 'files' || view === 'events';
  const nextResourceCursor = resourceData && typeof resourceData === 'object' && typeof (resourceData as { next_cursor?: unknown }).next_cursor === 'string'
    ? (resourceData as { next_cursor: string }).next_cursor
    : '';
  const goToPreviousResourcePage = (): void => {
    if (!cursorPaginated || resourcePage === 0) return;
    const previousPage = resourcePage - 1;
    setResourcePage(previousPage);
    void loadResource(view, resourceCursors[previousPage] ?? '');
  };
  const goToNextResourcePage = (): void => {
    if (!cursorPaginated || !nextResourceCursor) return;
    const nextPage = resourcePage + 1;
    setResourceCursors((current) => current[nextPage] === nextResourceCursor ? current : [...current.slice(0, nextPage), nextResourceCursor]);
    setResourcePage(nextPage);
    void loadResource(view, nextResourceCursor);
  };

  return <LocaleContext.Provider value={locale}>{mode === 'ready' ? <div className="app-shell">
    <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><span className="brand-mark">V<span>○</span></span><div><strong>Voicecan</strong><small>{t('Device platform')}</small></div><button type="button" className="sidebar-close" aria-label={t('Close navigation')} onClick={() => setMobileNavOpen(false)}><Icon name="close"/></button></div>
      <nav className="side-nav" aria-label={t('Main navigation')}>{navGroups.map((group) => <section key={group.label}><p>{t(group.label)}</p>{group.items.filter((item) => !['device-settings', 'storage'].includes(item) || user?.role === 'system_admin').map((item) => <button type="button" key={item} className={view === item ? 'active' : undefined} aria-current={view === item ? 'page' : undefined} onClick={() => selectView(item)}><Icon name={navIcon(item)}/><span>{t(labels[item])}</span>{view === item ? <i/> : null}</button>)}</section>)}</nav>
      <div className="sidebar-footer"><div className="server-mini"><span className={`health-dot health-${health}`}/><div><strong>{t('Device Server')}</strong><small>{t(health)}</small></div></div><button type="button" onClick={() => void logout()}><Icon name="logout"/><span>{t('Sign out')}</span></button></div>
    </aside>
    {mobileNavOpen ? <button type="button" aria-label={t('Close navigation')} className="nav-scrim" onClick={() => setMobileNavOpen(false)}/> : null}
    <div className="app-main">
      <header className="app-topbar"><button type="button" className="mobile-menu" aria-label={t('Open navigation')} onClick={() => setMobileNavOpen(true)}><Icon name="menu"/></button><div className="breadcrumbs"><span>{t('Voicecan device platform')}</span><Icon name="arrow" size={14}/><strong>{t(labels[view])}</strong></div><div className="topbar-actions"><label className="language-control"><Icon name="globe" size={16}/><span className="sr-only">{t('Language')}</span><Select compact ariaLabel={t('Language')} value={locale} options={[{ value: 'zh-CN', label: '中文' }, { value: 'en', label: 'English' }]} onChange={(next) => setLocale(next as Locale)}/></label><div className="user-chip"><span>{user?.username.slice(0, 1).toUpperCase()}</span><div><strong>{user?.username}</strong><small>{t(user?.role.replaceAll('_', ' ') ?? '')}</small></div></div></div></header>
      <main className="page"><header className="page-header"><div><p className="eyebrow">{t(pageEyebrow(view))}</p><h1>{t(labels[view])}</h1><p>{t(pageDescription(view))}</p></div><PageActions view={view} t={t} onNavigate={selectView} onRefresh={() => void loadResource(view, resourceCursors[resourcePage] ?? '')}/></header>
        {view === 'overview' ? <Overview t={t} health={health} onNavigate={selectView}/> : null}
        {resourcePaths[view] ? <section className="content-card resource-card">{loading && resourceData === undefined ? <ResourceSkeleton/> : error && resourceData === undefined ? <ResultPanel result={undefined} error={error} loading={false} t={t}/> : view === 'devices' ? <DeviceManagement devices={resourceData} t={t} canEdit={user?.role === 'system_admin' || user?.membership_role === 'group_admin'} canRelease={user?.role === 'system_admin'} onRelease={releaseDevice} onDevicesRefresh={() => void loadResource('devices')}/> : <><DataTable data={resourceData} t={t} pageSize={cursorPaginated ? 100 : 12}/>{cursorPaginated && resourceData !== undefined ? <nav className="table-pagination" aria-label={t('Pagination')}><Button kind="ghost" disabled={resourcePage === 0 || loading} onClick={goToPreviousResourcePage}>{t('Previous')}</Button><span>{t('Page {page}', { page: resourcePage + 1 })}</span><Button kind="ghost" disabled={!nextResourceCursor || loading} onClick={goToNextResourcePage}>{t('Next')}</Button></nav> : null}</>}</section> : null}
        {!resourcePaths[view] && view !== 'overview' ? <AdminWorkspace key={view} view={view} t={t} run={run} locale={locale} onNavigateDevice={selectDevice}/> : null}
        {view === 'provision' && connectReturn ? <section className={`connect-return connect-return-${connectReturn.phase}`} role="status"><span>{connectReturn.phase === 'checking' ? <span className="spinner"/> : connectReturn.phase === 'completed' ? '✓' : '!'}</span><div><strong>{t(connectReturn.phase === 'checking' ? 'Checking connection result' : connectReturn.phase === 'completed' ? 'Device connected' : 'Connection needs attention')}</strong><p>{connectReturn.message}</p>{connectReturn.deviceId ? <code>{connectReturn.deviceId}</code> : null}</div></section> : null}
        {view !== 'overview' && !['provision', 'release'].includes(view) && (!resourcePaths[view] || operationResult !== undefined) ? <ResultPanel result={operationResult} error={error} loading={loading} t={t}/> : null}
        {['provision', 'release'].includes(view) && (loading || error) ? <ResultPanel result={undefined} error={error} loading={loading} t={t}/> : null}
      </main>
    </div>
    {secretReveal !== undefined ? <SecretRevealDialog result={secretReveal} t={t} onClose={() => { setSecretReveal(undefined); setOperationResult(undefined); }}/>: null}
  </div> : <AuthExperience mode={mode} notice={notice} health={health} locale={locale} setLocale={setLocale} onSetup={submitSetup} onLogin={submitLogin}/>}</LocaleContext.Provider>;
}

function pageEyebrow(view: View): string {
  if (['devices', 'files', 'provision', 'release', 'device-settings'].includes(view)) return 'Device operations';
  if (['groups', 'users'].includes(view)) return 'Organization';
  if (['open-platform', 'open-platform-overview', 'permission-catalog', 'oauth-clients', 'call-logs', 'download-grants', 'security-alerts'].includes(view)) return 'Open platform';
  if (['events', 'inspector', 'storage', 'audit'].includes(view)) return 'Operations and diagnostics';
  return 'Independent device platform';
}

function pageDescription(view: View): string {
  const descriptions: Record<View, string> = {
    overview: 'A calm view of device health, activity and the next action that needs attention.',
    devices: 'Monitor ownership and connection state across the current authorized scope.',
    files: 'Track recording discovery, storage and synchronization without exposing recording content.',
    provision: 'Bind a nearby Voicecan device to this platform through a short-lived, origin-bound flow. Network setup is one step when needed.',
    release: 'Release control safely while preserving recordings and audit history.',
    'device-settings': 'Manage server-wide discovery rules used when administrators connect nearby devices.',
    groups: 'Use user groups to assign devices and recordings to a shared access boundary, then control which members can manage or view them.',
    users: 'Create local accounts and control administrative access.',
    'open-platform': 'Manage Applications, shared REST/MCP permissions, credentials, OAuth clients, Webhooks, download delivery policies, usage and audit.',
    'open-platform-overview': 'Monitor Application health, credential risk, API and MCP calls, temporary download use and security alerts.',
    'permission-catalog': 'Review the server-owned permission catalog shared by REST, MCP and every credential.',
    'oauth-clients': 'Review approved remote MCP OAuth clients, redirect URIs, scopes and lifecycle state.',
    'call-logs': 'Inspect redacted REST and MCP request metadata without credentials or temporary URLs.',
    'download-grants': 'Review temporary recording capabilities, consumption state, expiry and revocation.',
    'security-alerts': 'Investigate leaked credentials, refresh-token reuse and other open-platform risks.',
    events: 'Review the immutable activity emitted by devices and the server.',
    inspector: 'Diagnose failed deliveries and replay a reviewed event safely.',
    storage: 'Manage upload capacity limits and safety thresholds, and review the deployment-level storage type.',
    audit: 'Trace administrative changes without revealing sensitive credentials.',
  };
  return descriptions[view];
}

function PageActions({ view, t, onNavigate, onRefresh }: { view: View; t: Translate; onNavigate: (view: View) => void; onRefresh: () => void }) {
  if (view === 'overview' || view === 'devices') return <div className="page-actions"><Button kind="secondary" icon="refresh" onClick={onRefresh}>{t('Refresh')}</Button><Button icon="provision" onClick={() => onNavigate('provision')}>{t('Bind device')}</Button></div>;
  if (resourcePaths[view]) return <Button kind="secondary" icon="refresh" onClick={onRefresh}>{t('Refresh')}</Button>;
  return null;
}

function AuthExperience({ mode, notice, health, locale, setLocale, onSetup, onLogin }: { mode: AuthMode; notice: string; health: string; locale: Locale; setLocale: (locale: Locale) => void; onSetup: (event: FormEvent<HTMLFormElement>) => Promise<void>; onLogin: (event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  const t = useTranslate();
  const languageOptions = [{ value: 'zh-CN', label: '中文' }, { value: 'en', label: 'English' }];
  return <main className="auth-shell">
    <section className="auth-brand"><div className="auth-brand-copy"><span className="brand-kicker">VOICECAN</span><h1>{t('Quiet technology, clearly managed.')}</h1><p>{t('Connect nearby devices, protect ownership and keep every operational step visible.')}</p></div><div className="hero-device" aria-hidden="true"><span className="hero-orbit orbit-one"/><span className="hero-orbit orbit-two"/><div className="hero-device-body"><span className="hero-logo">V○</span><i/></div><div className="hero-device-clip"/></div><div className="auth-trust"><span><i className={`health-dot health-${health}`}/>{t('Server {status}', { status: t(health) })}</span><span>{t('Credentials stay on this origin')}</span></div></section>
    <section className="auth-content"><header className="auth-top"><div className="brand compact"><span className="brand-mark">V<span>○</span></span><strong>Voicecan</strong></div><label className="language-control"><Icon name="globe" size={16}/><Select compact ariaLabel={t('Language')} value={locale} options={languageOptions} onChange={(next) => setLocale(next as Locale)}/></label></header><div className="auth-card">
      {mode === 'loading' ? <div className="auth-loading"><span className="spinner"/><h2>{t('Preparing your workspace')}</h2><p>{notice}</p></div> : null}
      {mode === 'setup' ? <><Stepper steps={['Check server', 'Verify setup token', 'Create administrator', 'Ready']} current={1} t={t}/><div className="auth-heading"><span className="auth-step">01</span><div><h2>{t('Create the first administrator')}</h2><p>{t('Read the owner-only setup token on the server host. It is never stored by this page.')}</p></div></div><form className="auth-form" onSubmit={(event) => void onSetup(event)}><label><span>{t('Setup token')}</span><input name="setup_token" type="password" autoComplete="off" required/></label><label><span>{t('Username')}</span><input name="username" autoComplete="username" required/></label><label><span>{t('Display name')}</span><input name="display_name" autoComplete="name"/></label><label><span>{t('Password')}</span><input name="password" type="password" autoComplete="new-password" minLength={12} required/><small>{t('Use at least 12 characters. The password is sent only to this server.')}</small></label><Button type="submit" icon="arrow">{t('Create administrator')}</Button></form></> : null}
      {mode === 'login' ? <><div className="auth-heading"><span className="auth-step">V</span><div><h2>{t('Welcome back')}</h2><p>{t('Sign in with a local account to manage this device server.')}</p></div></div><form className="auth-form" onSubmit={(event) => void onLogin(event)}><label><span>{t('Username')}</span><input name="username" autoComplete="username" required/></label><label><span>{t('Password')}</span><input name="password" type="password" autoComplete="current-password" required/></label><Button type="submit" icon="arrow">{t('Sign in')}</Button></form></> : null}
      <div className="auth-notice" role="status"><span className={`health-dot health-${health}`}/>{notice}</div>
    </div></section>
  </main>;
}

function Overview({ t, health, onNavigate }: { t: Translate; health: string; onNavigate: (view: View) => void }) {
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([api('/devices'), api('/files?limit=20'), api('/events?limit=5'), api('/open-platform/applications')]).then((results) => {
      if (!active) return;
      const value = (index: number): unknown => results[index]?.status === 'fulfilled' ? results[index].value : [];
      setData({ devices: value(0), files: value(1), events: value(2), applications: value(3) });
      setLoading(false);
    });
    return () => { active = false; };
  }, []);
  const count = (key: string): number => {
    const resource = data[key];
    if (resource && typeof resource === 'object' && !Array.isArray(resource)) {
      const total = Number((resource as Record<string, unknown>).total_count);
      if (Number.isSafeInteger(total) && total >= 0) return total;
    }
    return collectionOf(resource).length;
  };
  const metrics = [
    { label: 'Devices', value: count('devices'), icon: 'device' as const, target: 'devices' as const },
    { label: 'Recording files', value: count('files'), icon: 'file' as const, target: 'files' as const },
    { label: 'Events', value: count('events'), icon: 'pulse' as const, target: 'events' as const },
    { label: 'Applications', value: count('applications'), icon: 'code' as const, target: 'open-platform' as const },
  ];
  return <div className="overview-grid"><section className="welcome-card"><div><span className={`status-pill status-${health}`}>{t('Server {status}', { status: t(health) })}</span><h2>{t('Your device workspace is ready.')}</h2><p>{t('Bind a nearby device or inspect the latest activity across this independent deployment.')}</p><div className="welcome-actions"><Button icon="provision" onClick={() => onNavigate('provision')}>{t('Bind device')}</Button><Button kind="secondary" icon="pulse" onClick={() => onNavigate('events')}>{t('View activity')}</Button></div></div><div className="overview-device" aria-hidden="true"><span className="overview-logo">V○</span><i/></div></section><section className="metrics-grid">{metrics.map((metric) => <button type="button" className="metric-card" key={metric.label} onClick={() => onNavigate(metric.target)}><span className="metric-icon"><Icon name={metric.icon}/></span><div><span>{t(metric.label)}</span><strong>{loading ? '—' : metric.value}</strong></div><Icon name="arrow"/></button>)}</section><section className="content-card quick-start"><header><div><p className="eyebrow">{t('Guided actions')}</p><h2>{t('What would you like to do?')}</h2></div></header><div className="quick-grid"><QuickAction icon="provision" title={t('Bind a device')} description={t('Assign ownership, connect a nearby Voicecan device, and configure its network only when needed.')} onClick={() => onNavigate('provision')}/><QuickAction icon="code" title={t('Connect an application')} description={t('Create an Open Platform Application with reviewed permissions and credentials.')} onClick={() => onNavigate('open-platform')}/><QuickAction icon="webhook" title={t('Receive events')} description={t('Configure signed Webhooks within an Open Platform Application.')} onClick={() => onNavigate('open-platform')}/></div></section><section className="content-card recent-card"><header><div><p className="eyebrow">{t('Recent activity')}</p><h2>{t('Latest events')}</h2></div><Button kind="ghost" onClick={() => onNavigate('events')}>{t('View all')}</Button></header><DataTable data={data.events} t={t} maxRows={5} emptyMessage={t('Device and server activity will appear here.')}/></section></div>;
}

function QuickAction({ icon, title, description, onClick }: { icon: Parameters<typeof Icon>[0]['name']; title: string; description: string; onClick: () => void }) {
  return <button type="button" className="quick-action" onClick={onClick}><span><Icon name={icon}/></span><div><strong>{title}</strong><p>{description}</p></div><Icon name="arrow"/></button>;
}

function ResourceSkeleton() {
  return <div className="resource-skeleton" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index}/>)}</div>;
}
