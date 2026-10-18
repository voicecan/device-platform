import { useEffect, useState } from 'react';
import { api, errorMessage } from './api.js';
import { Button, type Translate } from './ui.js';
type Storage = { capacity: { total: number; available: number; usedRatio: number } | null; stop_ratio: number };
export function SetupPreflight({ t }: { t: Translate }) {
  const [storage, setStorage] = useState<Storage>(); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; const load = async (): Promise<void> => { try { const value = await api<Storage>('/admin/storage'); if (active) { setStorage(value); setError(''); } } catch (cause) { if (active) setError(errorMessage(cause)); } }; void load(); const timer = globalThis.setInterval(() => void load(), 30_000); return () => { active = false; globalThis.clearInterval(timer); }; }, [attempt]);
  if (error) return <div className="inline-alert inline-alert-error" role="alert"><strong>{t('Could not check recording storage')}</strong><p>{error}</p><Button kind="secondary" onClick={() => setAttempt((value) => value + 1)}>{t('Try again')}</Button></div>;
  if (!storage?.capacity || storage.capacity.usedRatio < storage.stop_ratio) return null;
  return <div className="inline-alert inline-alert-error setup-preflight" role="alert"><strong>{t('Recording upload is blocked by disk protection')}</strong><p>{t('Disk used: {used}%. Stop threshold: {limit}%. Free space: {free} GB.', { used: (storage.capacity.usedRatio * 100).toFixed(1), limit: Math.round(storage.stop_ratio * 100), free: (storage.capacity.available / 1_000_000_000).toFixed(1) })}</p><p>{t('Device connection and MCP setup can continue, but recordings cannot upload until storage is available. Free space or review storage protection in Settings.')}</p><code>STORAGE_LOW_SPACE</code><div><a href="/admin?view=settings">{t('Review storage settings')}</a></div></div>;
}
