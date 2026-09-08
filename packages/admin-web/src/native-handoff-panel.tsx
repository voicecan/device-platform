import { useEffect, useState } from 'react';
import { api, errorMessage } from './api.js';
import { Button } from './ui.js';
import type { Translate } from './ui.js';

type Handoff = { id: string; status: string; client_fingerprint: string | null; lease_expires_at: string | null; expires_at: string };
type Snapshot = { execution_epoch: number; active_handoff_id: string | null; handoffs: Handoff[] };
type Launch = { launch_url: string; ticket_expires_at: string };

export function NativeHandoffPanel({ intentId, t, onExecutorChange }: { intentId: string; t: Translate; onExecutorChange: (active: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [launch, setLaunch] = useState<Launch>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const path = `/binding-intents/${encodeURIComponent(intentId)}/native-handoffs`;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await api<Snapshot>(path);
        if (active) { setSnapshot(next); onExecutorChange(Boolean(next.active_handoff_id)); setError(''); }
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active) { setClock(Date.now()); timer = setTimeout(() => void load(), 5_000); } }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [path, onExecutorChange]);
  const mutate = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try {
      await operation();
      const next = await api<Snapshot>(path); setSnapshot(next); onExecutorChange(Boolean(next.active_handoff_id));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const liveLaunch = launch && Date.parse(launch.ticket_expires_at) > clock;
  return <section className="operation-card" aria-label={t('Continue in native app')}>
    <h2>{t('Continue in native app')}</h2>
    <p>{t('Preview integration: requires an app configured to trust this platform. The current discovery app cannot execute this task yet.')}</p>
    <p>{t('Open the link on your phone, then compare its verification code here before approving. The link expires in five minutes.')}</p>
    <Button id="native-create-handoff" disabled={busy} onClick={() => void mutate(async () => { setLaunch(await api<Launch>(path, { method: 'POST', body: '{}' })); })}>{t('Create app link')}</Button>
    {liveLaunch ? <div className="form-actions"><a href={launch.launch_url} referrerPolicy="no-referrer">{t('Open app link')}</a><Button id="native-copy-link" kind="ghost" disabled={busy} onClick={() => void mutate(() => navigator.clipboard.writeText(launch.launch_url))}>{t('Copy app link')}</Button></div> : launch ? <p role="status">{t('App link expired. Create a new link.')}</p> : null}
    {error ? <p role="alert" className="inline-alert inline-alert-error">{error}</p> : null}
    {snapshot?.active_handoff_id ? <p role="status">{t('This task is assigned to the native app. Completion is confirmed by the device server.')}</p> : null}
    {snapshot?.handoffs.filter(item => item.client_fingerprint && Date.parse(item.expires_at) > clock).map(item => {
      const renewable = item.status === 'approved' && Date.parse(item.lease_expires_at ?? '') <= clock;
      return <div className="impact-note" key={item.id}>
        <p>{t('Verification code')}: <code>{item.client_fingerprint}</code></p>
        <p>{t(item.status)}{item.id === snapshot.active_handoff_id ? ` · ${t('Active executor')}` : ''}</p>
        {item.status === 'exchanged' || renewable ? <Button id={`approve-${item.id}`} disabled={busy} onClick={() => void mutate(async () => { await api(`/native-handoffs/${encodeURIComponent(item.id)}/approve`, { method: 'POST', body: JSON.stringify({ expected_execution_epoch: snapshot.execution_epoch }) }); setLaunch(undefined); })}>{t(renewable ? 'Reauthorize this app' : 'Approve this app')}</Button> : null}
      </div>;
    })}
  </section>;
}
