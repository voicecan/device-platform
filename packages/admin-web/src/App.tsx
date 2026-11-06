import { ChangePasswordDialog } from './change-password-dialog.js';
import { RecordingLibrary } from './recording-library.js';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { decodeConnectCallback } from '@voicecan/device-connect-web';
import type { DeviceConnectCallback } from '@voicecan/device-connect-web';
import { api, errorMessage, setCsrfToken, setUnauthorizedHandler } from './api.js';
import { initialLocale, saveLocale, translate } from './i18n.js';
import type { Locale } from './i18n.js';
import { deviceListUrl, urlForView } from './navigation.js';
import { AdminWorkspace, labels, navGroups, resourcePaths } from './workspaces.js';
import { DeviceManagement } from './device-management.js';
import { DeviceFleet } from './device-fleet.js';
import { Overview } from './overview.js';
import { AddDeviceDialog } from './add-device-dialog.js';
import type { View } from './workspaces.js';
import { Button, containsRevealedSecrets, DataTable, Icon, ResultPanel, SecretRevealDialog, Select, Stepper } from './ui.js';
import type { Translate } from './ui.js';

type AuthMode = 'loading' | 'setup' | 'login' | 'ready';
type SessionUser = { username: string; role: string; membership_role?: string | null; group_id?: string | null; can_change_password: boolean; can_mutate_group: boolean };
type ConnectReturn = { phase: 'checking' | 'completed' | 'failed'; message: string; deviceId?: string };

const LocaleContext = createContext<Locale>('en');

function viewFromLocation(): View {
  const value = new URLSearchParams(globalThis.location.search).get('view');
  return value && Object.hasOwn(labels, value) ? value as View : 'overview';
}

function updateViewLocation(view: View, mode: 'push' | 'replace' = 'push'): void {
  const url = urlForView(globalThis.location.href, view);
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
  return 'transfer';
}

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [mode, setMode] = useState<AuthMode>('loading');
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [health, setHealth] = useState('Checking…');
  const [notice, setNotice] = useState('Loading setup state…');
  const [user, setUser] = useState<SessionUser>();
  const [changingPassword, setChangingPassword] = useState(false);
  const [bindingHeaderActions, setBindingHeaderActions] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>(viewFromLocation);
  const [deviceId, setDeviceId] = useState(() => new URLSearchParams(globalThis.location.search).get('device') ?? '');
  const pageView = view === 'provision' ? 'devices' : view;
  useEffect(() => { if (view === 'devices' && deviceId) globalThis.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }, [view, deviceId]);
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
    setUnauthorizedHandler((path) => {
      if (path === '/auth/login' || modeRef.current !== 'ready') return;
      setUser(undefined);
      setNotice(t('Your session expired. Sign in again to continue.'));
      setMode('login');
    });
    return () => setUnauthorizedHandler(undefined);
  }, [locale]);
  useEffect(() => {
    if (mode !== 'ready') return;
    let stopped = false;
    const refresh = async (): Promise<void> => {
      if (stopped || globalThis.document?.visibilityState === 'hidden') return;
      try { await api('/auth/refresh', { method: 'POST', body: '{}' }); }
      catch { /* 401 moves to login; transient network errors retry on the next interval */ }
    };
    void refresh();
    const timer = globalThis.setInterval(() => void refresh(), 10 * 60_000);
    const onVisibility = (): void => { void refresh(); };
    globalThis.document?.addEventListener('visibilitychange', onVisibility);
    return () => { stopped = true; globalThis.clearInterval(timer); globalThis.document?.removeEventListener('visibilitychange', onVisibility); };
  }, [mode]);
  useEffect(() => {
    const restoreView = (): void => { setView(viewFromLocation()); setDeviceId(new URLSearchParams(globalThis.location.search).get('device') ?? ''); };
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

  const selectView = (nextView: View, options?: { recordingStatus?: string }): void => {
    if (nextView === 'devices') globalThis.history.pushState({ view: 'devices' }, '', deviceListUrl(globalThis.location.href));
    else if (nextView !== view) updateViewLocation(nextView);
    if (nextView === 'files') {
      const url = new URL(globalThis.location.href);
      if (options?.recordingStatus) url.searchParams.set('recording_status', options.recordingStatus);
      else url.searchParams.delete('recording_status');
      globalThis.history.replaceState({ view: 'files' }, '', url);
    }
    setDeviceId(''); setView(nextView); setError(''); setOperationResult(undefined);
    setMobileNavOpen(false);
  };

  const selectDevice = (deviceId: string): void => {
    const url = urlForView(globalThis.location.href, 'devices');
    url.searchParams.set('device', deviceId);
    globalThis.history.pushState({ view: 'devices', deviceId }, '', url);
    setDeviceId(deviceId); setView('devices'); setError(''); setOperationResult(undefined);
    setMobileNavOpen(false);
  };

  const releaseDevice = (deviceId: string): void => {
    const url = urlForView(globalThis.location.href, 'release');
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

  const isSystemAdmin = user?.role === 'system_admin';
  const isGroupAdmin = user?.membership_role === 'group_admin';
  const canManageGroup = isSystemAdmin || isGroupAdmin;
  const isViewer = !isSystemAdmin && user?.membership_role === 'viewer';

  const visibleNavGroups = navGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => {
      if (isViewer) return true;
      if (item === 'users') return isSystemAdmin;
      if (item === 'groups') return canManageGroup;
      if (item === 'storage') return isSystemAdmin;
      return true;
    }) }))
    .filter((group) => group.items.length > 0);

  return <LocaleContext.Provider value={locale}>{mode === 'ready' ? <div className="app-shell admin-linear">
    <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><span className="brand-mark">V<span>○</span></span><div><strong>Voicecan</strong><small>{t('Device platform')}</small></div><button type="button" className="sidebar-close" aria-label={t('Close navigation')} onClick={() => setMobileNavOpen(false)}><Icon name="close"/></button></div>
      <nav className="side-nav" aria-label={t('Main navigation')}>
        <section>{visibleNavGroups[0]?.items.map((item) => <button type="button" key={item} className={pageView === item ? 'active' : undefined} aria-current={pageView === item ? 'page' : undefined} onClick={() => selectView(item)}><Icon name={navIcon(item)}/><span>{t(labels[item])}</span>{pageView === item ? <i/> : null}</button>)}</section>
        <details className="admin-navigation" open={visibleNavGroups.slice(1).some((group) => group.items.includes(view)) ? true : undefined}>
          <summary><Icon name="storage"/><span>{t('Management and advanced settings')}</span><Icon name="arrow" size={14}/></summary>
          {visibleNavGroups.slice(1).map((group) => <section key={group.label}><p>{t(group.label)}</p>{group.items.map((item) => <button type="button" key={item} className={pageView === item ? 'active' : undefined} aria-current={pageView === item ? 'page' : undefined} onClick={() => selectView(item)}><Icon name={navIcon(item)}/><span>{t(labels[item])}</span>{pageView === item ? <i/> : null}</button>)}</section>)}
        </details>
      </nav>
      <div className="sidebar-footer"><div className="server-mini"><span className={`health-dot health-${health}`}/><div><strong>{t('Device Server')}</strong><small>{t(health)}</small></div></div><button type="button" onClick={() => void logout()}><Icon name="logout"/><span>{t('Sign out')}</span></button></div>
    </aside>
    {mobileNavOpen ? <button type="button" aria-label={t('Close navigation')} className="nav-scrim" onClick={() => setMobileNavOpen(false)}/> : null}
    <div className="app-main">
      <header className="app-topbar"><button type="button" className="mobile-menu" aria-label={t('Open navigation')} onClick={() => setMobileNavOpen(true)}><Icon name="menu"/></button><div className="breadcrumbs"><span>{t('Voicecan device platform')}</span><Icon name="arrow" size={14}/><strong>{t(deviceId && pageView === 'devices' ? 'Device details' : labels[pageView])}</strong></div><div className="topbar-actions"><label className="language-control"><Icon name="globe" size={16}/><span className="sr-only">{t('Language')}</span><Select compact ariaLabel={t('Language')} value={locale} options={[{ value: 'zh-CN', label: '中文' }, { value: 'en', label: 'English' }]} onChange={(next) => setLocale(next as Locale)}/></label>{user?.can_change_password ? <Button kind="ghost" onClick={() => setChangingPassword(true)}>{t('Change password')}</Button> : null}<div className="user-chip"><span>{user?.username.slice(0, 1).toUpperCase()}</span><div><strong>{user?.username}</strong><small>{t((isViewer ? 'viewer' : user?.role.replaceAll('_', ' ')) ?? '')}</small></div></div></div></header>
      <main className="page">{isViewer ? <p role="status" className="inline-alert">{t('Browse your group’s devices, recordings, applications and operations. Changes and credential creation are disabled.')}</p> : null}<header className="page-header"><div>{deviceId && pageView === 'devices' ? <Button className="fleet-back" kind="ghost" onClick={() => selectView('devices')}>{t('Back to device list')}</Button> : <p className="eyebrow">{t(pageEyebrow(pageView))}</p>}<h1>{t(deviceId && pageView === 'devices' ? 'Device details' : labels[pageView])}</h1>{deviceId && pageView === 'devices' ? null : <p>{t(pageDescription(pageView))}</p>}</div><PageActions view={pageView} deviceId={deviceId} canRelease={user?.role === 'system_admin'} canProvision={canManageGroup || isViewer} t={t} onNavigate={selectView} onRefresh={() => void loadResource(view, resourceCursors[resourcePage] ?? '')} onRelease={releaseDevice}/></header>
        {view === 'files' ? <RecordingLibrary t={t} canSync={!isViewer}/> : null}
        {view === 'overview' ? <Overview t={t} health={health} onNavigate={selectView} onSelectDevice={selectDevice} isSystemAdmin={user?.role === 'system_admin'} isGroupAdmin={user?.membership_role === 'group_admin'} isViewer={isViewer} hasGroup={Boolean(user?.group_id)}/> : null}
        {pageView === 'devices' ? <><DeviceFleet t={t} onSelect={selectDevice} active={!deviceId}/>{deviceId ? <DeviceManagement key={deviceId} devices={undefined} t={t} canEdit={user?.role === 'system_admin' || user?.membership_role === 'group_admin'} canRelease={user?.role === 'system_admin'} canSync={!isViewer} onDevicesRefresh={() => {}}/> : null}</> : null}
        {resourcePaths[view] ? <section className="content-card resource-card">{loading && resourceData === undefined ? <ResourceSkeleton/> : error && resourceData === undefined ? <ResultPanel result={undefined} error={error} loading={false} t={t}/> : <><DataTable data={resourceData} t={t} pageSize={cursorPaginated ? 100 : 12}/>{cursorPaginated && resourceData !== undefined ? <nav className="table-pagination" aria-label={t('Pagination')}><Button kind="ghost" disabled={resourcePage === 0 || loading} onClick={goToPreviousResourcePage}>{t('Previous')}</Button><span>{t('Page {page}', { page: resourcePage + 1 })}</span><Button kind="ghost" disabled={!nextResourceCursor || loading} onClick={goToNextResourcePage}>{t('Next')}</Button></nav> : null}</>}</section> : null}
        {!resourcePaths[view] && !['overview', 'devices', 'provision', 'files'].includes(view) ? <AdminWorkspace headerActions={bindingHeaderActions} key={view} view={view} t={t} run={run} locale={locale} onNavigateDevice={selectDevice} canExportBackup={user?.role === 'system_admin'} isSystemAdmin={isSystemAdmin} isGroupAdmin={isGroupAdmin} readOnly={isViewer}/> : null}

        {view !== 'overview' && !['provision', 'release'].includes(view) && (!resourcePaths[view] || operationResult !== undefined) ? <ResultPanel result={operationResult} error={error} loading={loading} t={t}/> : null}
        {view === 'release' && (loading || error) ? <ResultPanel result={undefined} error={error} loading={loading} t={t}/> : null}
      </main>
    </div>
    {view === 'provision' ? <AddDeviceDialog t={t} busy={loading} onClose={() => selectView('devices')} headerRef={setBindingHeaderActions}>
      <AdminWorkspace headerActions={bindingHeaderActions} view="provision" t={t} run={run} locale={locale} onNavigateDevice={selectDevice} canExportBackup={user?.role === 'system_admin'} isSystemAdmin={isSystemAdmin} isGroupAdmin={isGroupAdmin} readOnly={isViewer}/>
      {view === 'provision' && connectReturn ? <section className={`connect-return connect-return-${connectReturn.phase}`} role="status"><span>{connectReturn.phase === 'checking' ? <span className="spinner"/> : connectReturn.phase === 'completed' ? '✓' : '!'}</span><div><strong>{t(connectReturn.phase === 'checking' ? 'Checking connection result' : connectReturn.phase === 'completed' ? 'Device connected' : 'Connection needs attention')}</strong><p>{connectReturn.message}</p>{connectReturn.deviceId ? <code>{connectReturn.deviceId}</code> : null}</div></section> : null}
      {connectReturn?.phase === 'completed' && connectReturn.deviceId ? <Button onClick={() => selectDevice(connectReturn.deviceId!)}>{t('Open device details')}</Button> : null}
      {loading || error ? <ResultPanel result={undefined} error={error} loading={loading} t={t}/> : null}
    </AddDeviceDialog> : null}
    {changingPassword && user?.can_change_password ? <ChangePasswordDialog t={t} onClose={() => setChangingPassword(false)} onChanged={() => { setChangingPassword(false); void refreshSession(); }}/> : null}
    {secretReveal !== undefined ? <SecretRevealDialog result={secretReveal} t={t} onClose={() => { setSecretReveal(undefined); setOperationResult(undefined); }}/>: null}
  </div> : <AuthExperience mode={mode} notice={notice} health={health} locale={locale} setLocale={setLocale} onSetup={submitSetup} onLogin={submitLogin}/>}</LocaleContext.Provider>;
}

function pageEyebrow(view: View): string {
  if (['devices', 'files', 'provision', 'release'].includes(view)) return 'Device operations';
  if (['groups', 'users'].includes(view)) return 'Organization';
  if (['open-platform', 'open-platform-overview', 'permission-catalog', 'oauth-clients', 'call-logs', 'download-grants', 'security-alerts'].includes(view)) return 'Open platform';
  if (['events', 'inspector', 'storage', 'audit'].includes(view)) return 'Operations and diagnostics';
  return 'Independent device platform';
}

function pageDescription(view: View): string {
  const descriptions: Record<View, string> = {
    overview: 'A calm view of device health, activity and the next action that needs attention.',
    devices: 'Monitor ownership and connection state across the current authorized scope.',
    files: 'Find recordings by device, check synchronization and use them in your AI tool.',
    provision: 'Choose your nearby device, connect its network, and wait for this platform to confirm it online.',
    release: 'Release control safely while preserving recordings and audit history.',
    groups: 'Use user groups to assign devices and recordings to a shared access boundary, then control which members can manage or view them.',
    users: 'Create local accounts and control administrative access.',
    'open-platform': 'Choose OpenClaw, Codex or another AI tool to work with your recordings.',
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

function PageActions({ view, deviceId, canRelease, canProvision, t, onNavigate, onRefresh, onRelease }: { view: View; deviceId: string; canRelease: boolean; canProvision: boolean; t: Translate; onNavigate: (view: View) => void; onRefresh: () => void; onRelease: (deviceId: string) => void }) {
  if (view === 'devices') return deviceId
    ? canRelease ? <Button kind="danger" icon="close" onClick={() => onRelease(deviceId)}>{t('Remove device')}</Button> : null
    : canProvision ? <Button data-add-device-trigger kind="secondary" icon="provision" onClick={() => onNavigate('provision')}>{t('Add device')}</Button> : null;
  if (view === 'overview') return null;
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

function ResourceSkeleton() {
  return <div className="resource-skeleton" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index}/>)}</div>;
}
