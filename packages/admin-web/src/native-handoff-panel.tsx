import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from './api.js';
import { hasActiveNativeExecutor, visibleNativeHandoffs } from './native-handoff-state.js';
import { Button, Icon } from './ui.js';
import type { Translate } from './ui.js';

import type { NativeHandoff, Snapshot } from './native-handoff-state.js';
type Launch = { launch_url: string; ticket_expires_at: string };

export function NativeHandoffPanel({ intentId, t, onExecutorChange, bindingStatus }: { intentId: string; bindingStatus?: string; t: Translate; onExecutorChange: (active: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [launch, setLaunch] = useState<Launch>();
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dismissedApproval, setDismissedApproval] = useState('');
  const [requestedApproval, setRequestedApproval] = useState<string>();
  const [clock, setClock] = useState(Date.now());
  const path = `/binding-intents/${encodeURIComponent(intentId)}/native-handoffs`;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await api<Snapshot>(path);
        if (active) { setSnapshot(next); onExecutorChange(hasActiveNativeExecutor(next)); setError(''); }
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active) { setClock(Date.now()); timer = setTimeout(() => void load(), 5_000); } }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [path, onExecutorChange]);
  useEffect(() => {
    let active = true; setQr('');
    if (launch) void QRCode.toDataURL(launch.launch_url, { errorCorrectionLevel: 'M', margin: 4, width: 320 }).then(value => { if (active) setQr(value); }, () => { if (active) setError(t('Could not generate QR code. Use the copy link button.')); });
    return () => { active = false; };
  }, [launch, t]);
  const mutate = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try {
      await operation();
      const next = await api<Snapshot>(path); setSnapshot(next); onExecutorChange(hasActiveNativeExecutor(next));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const bindingLocked = ['configured', 'completed', 'expired', 'canceled'].includes(bindingStatus ?? '');
  const recoveryAllowed = !['completed', 'canceled'].includes(bindingStatus ?? '');
  const candidates = snapshot && recoveryAllowed ? visibleNativeHandoffs(snapshot, clock).filter(item => item.status === 'exchanged' || (item.status === 'approved' && (Date.parse(item.lease_expires_at ?? '') <= clock || Date.parse(item.expires_at) <= clock))) : [];
  const approval = candidates.find(item => item.id === requestedApproval) ?? candidates.find(item => `${item.id}:${snapshot?.execution_epoch}` !== dismissedApproval);
  const approvalKey = approval ? `${approval.id}:${snapshot?.execution_epoch}:${approval.client_fingerprint}` : '';
  const closeApproval = () => { if (approval) setDismissedApproval(`${approval.id}:${snapshot?.execution_epoch}`); setRequestedApproval(undefined); };
  const liveLaunch = launch && Date.parse(launch.ticket_expires_at) > clock;
  return <section className="operation-card" aria-label={t('Bind in native app')}>
    <h2>{t('Bind in native app')}</h2>
    <p>{t('Use Voicecan Connect on your phone to complete this binding:')}</p>
    <ol>
      <li>{t('Open Voicecan Connect and tap “Scan binding QR”.')}</li>
      <li>{t('Create the binding QR code on this page, then scan it with the app within five minutes.')}</li>
      <li>{t('Compare the verification code shown in the app with this page, then approve the app here.')}</li>
      <li>{t('Follow the app to select the nearby device and complete binding. Keep this page open for the confirmed result.')}</li>
    </ol>
    <p>{t('The app registers this self-hosted platform automatically when it opens the binding task; private-network HTTP deployments are supported.')}</p>
    <p>{t("The task QR uses the server address derived from this binding's Device WebSocket address.")}</p>
    <div className="app-download-options" aria-label={t('Get Voicecan Connect')}>
      <div className="app-download-card"><span className="app-download-placeholder" aria-hidden="true">QR</span><div><strong>{t('Apple App Store')}</strong><small>{t('Store QR code reserved')}</small></div><span className="app-download-status">{t('Coming soon')}</span></div>
      <div className="app-download-card"><span className="app-download-placeholder" aria-hidden="true">QR</span><div><strong>{t('Google Play')}</strong><small>{t('Store QR code reserved')}</small></div><span className="app-download-status">{t('Coming soon')}</span></div>
      <div className="app-download-card"><span className="app-download-placeholder app-download-placeholder-file" aria-hidden="true">APK</span><div><strong>{t('Android APK')}</strong><small>{t('APK download link reserved')}</small></div><span className="app-download-status">{t('Coming soon')}</span></div>
    </div>
    <Button id="native-create-handoff" disabled={busy || bindingLocked} onClick={() => void mutate(async () => { setLaunch(await api<Launch>(path, { method: 'POST', body: '{}' })); })}>{t('Create binding task QR code')}</Button>
    {liveLaunch ? <div>{qr ? <img src={qr} width={320} height={320} style={{ maxWidth: '100%', height: 'auto' }} alt={t('Scan this task QR in the native app')}/> : null}<div className="form-actions native-handoff-actions"><a className="button native-open-app-link" href={launch.launch_url} referrerPolicy="no-referrer"><span>{t('Open app link')}</span><Icon name="arrow" size={16}/></a><Button id="native-copy-link" kind="secondary" disabled={busy} onClick={() => void mutate(() => navigator.clipboard.writeText(launch.launch_url))}>{t('Copy app link')}</Button>{typeof navigator.share === 'function' ? <Button id="native-share-link" kind="ghost" disabled={busy} onClick={() => void mutate(async () => { try { await navigator.share({ url: launch.launch_url }); } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) throw cause; } })}>{t('Share to app')}</Button> : null}</div></div> : launch ? <p role="status">{t('App link expired. Create a new link.')}</p> : null}
    {error ? <p role="alert" className="inline-alert inline-alert-error">{error}</p> : null}
    {approval && snapshot ? <NativeApprovalDialog key={approvalKey} item={approval} busy={busy} error={error} t={t} onClose={closeApproval} onApprove={() => void mutate(async () => {
      await api(`/native-handoffs/${encodeURIComponent(approval.id)}/${Date.parse(approval.expires_at) <= clock ? 'reauthorize' : 'approve'}`, { method: 'POST', body: JSON.stringify({ expected_execution_epoch: snapshot.execution_epoch }) });
      setLaunch(undefined); closeApproval();
    })}/> : null}
    {snapshot && hasActiveNativeExecutor(snapshot, clock) ? <p role="status" className="native-handoff-status">{t('This task is assigned to the native app. Completion is confirmed by the device server.')}</p> : null}
    {snapshot && visibleNativeHandoffs(snapshot, clock).map(item => {
      const renewable = item.status === 'approved' && (Date.parse(item.lease_expires_at ?? '') <= clock || Date.parse(item.expires_at) <= clock);
      const activeExecutor = item.id === snapshot.active_handoff_id && hasActiveNativeExecutor(snapshot, clock);
      return <div className="impact-note native-handoff-request" key={item.id}>
        <div className="native-handoff-request-copy">
          <p>{t('Verification code')}: <code>{item.client_fingerprint}</code></p>
          {item.provisioning_stage ? <p>{t('Device progress')}: {t(item.provisioning_stage)}</p> : null}
          {item.failure_code ? <p role="status">{t('Last attempt failed; keep this task and retry in the app.')}: {item.failure_code}</p> : null}
          {Date.parse(item.expires_at) <= clock ? <p>{t('Reauthorize the original app to continue with the same device credential.')}</p> : null}
          <p>{t(item.status)}{activeExecutor ? ` · ${t('Active executor')}` : ''}</p>
        </div>
        {recoveryAllowed && (item.status === 'exchanged' || renewable) ? <Button id={`approve-${item.id}`} disabled={busy} onClick={() => setRequestedApproval(item.id)}>{t(renewable ? 'Reauthorize this app' : 'Approve this app')}</Button> : null}
      </div>;
    })}
  </section>;
}

function NativeApprovalDialog({ item, busy, error, t, onClose, onApprove }: { item: NativeHandoff; busy: boolean; error: string; t: Translate; onClose: () => void; onApprove: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [matched, setMatched] = useState(false);
  useEffect(() => {
    const element = dialog.current; const previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="native-approval-dialog" aria-labelledby="native-approval-title" aria-describedby="native-approval-description" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="native-approval-content">
      <span className="secret-dialog-icon"><Icon name="shield" size={28}/></span>
      <h2 id="native-approval-title">{t('Authorize this phone to bind the device')}</h2>
      <p id="native-approval-description">{t('Compare this code with the code in Voicecan Connect before approving. Only approve a request you started.')}</p>
      <div className="native-approval-code"><span>{t('Verification code')}</span><code>{item.client_fingerprint}</code></div>
      <label className="native-approval-match"><input type="checkbox" checked={matched} disabled={busy} onChange={event => setMatched(event.target.checked)}/>{t('The verification code matches the app on my phone.')}</label>
      {error ? <p role="alert" className="inline-alert inline-alert-error">{error}</p> : null}
      <div className="form-actions"><Button kind="secondary" disabled={busy} onClick={onClose}>{t('Review later')}</Button><Button disabled={busy || !matched} onClick={onApprove}>{t('Approve this app')}</Button></div>
    </div>
  </dialog>, document.body);
}
