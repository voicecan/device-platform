import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './ui.js';
import type { Translate } from './ui.js';

export function AddDeviceDialog({ t, busy, onClose, headerRef, children }: { t: Translate; busy: boolean; onClose: () => void; headerRef: (node: HTMLDivElement | null) => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = ref.current; element?.showModal(); return () => { element?.close(); document.querySelector<HTMLButtonElement>('[data-add-device-trigger]')?.focus(); }; }, []);
  return <dialog ref={ref} className="add-device-dialog" aria-labelledby="add-device-title" aria-describedby="add-device-description" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="add-device-dialog-heading"><h2 id="add-device-title">{t('Add device')}</h2><div className="add-device-dialog-actions"><div ref={headerRef}/><Button kind="ghost" icon="close" disabled={busy} aria-label={t('Close add device')} onClick={onClose}/></div><p id="add-device-description"><span>{t('Connect Bluetooth, then configure Wi-Fi.')}</span><span>{t('Backup and server setup are automatic.')}</span></p></header>
    <div className="add-device-dialog-body">{children}</div>
  </dialog>;
}
