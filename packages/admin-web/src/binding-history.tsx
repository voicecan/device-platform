import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from './api.js';
import { Button } from './ui.js';
import type { Translate } from './ui.js';
import { bindingTaskUrl } from './navigation.js';

type HistoryTask = {
  id: string; status: string; display_name: string | null; serial_number: string | null;
  group_name: string; created_at: string; expires_at: string; failure_code: string | null;
  binding_path: 'app' | 'web';
};
type History = { items: HistoryTask[]; total_count: number };

export function BindingHistory({ t, currentId, disabled }: { t: Translate; currentId: string; disabled: boolean }) {
  const [visible, setVisible] = useState(false);
  return <div className="binding-history-entry">
    <Button kind="ghost" icon="clock" aria-haspopup="dialog" onClick={() => setVisible(true)}>{t('Task history')}</Button>
    {visible ? <BindingHistoryDialog t={t} currentId={currentId} disabled={disabled} onClose={() => setVisible(false)}/> : null}
  </div>;
}

function BindingHistoryDialog({ t, currentId, disabled, onClose }: { t: Translate; currentId: string; disabled: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  const [filter, setFilter] = useState<'unfinished' | 'all'>('unfinished');
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<History>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState('');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setResult(undefined);
    const load = async () => {
      try {
        const next = await api<History>(`/binding-intents?filter=${filter}&limit=10&offset=${page * 10}`);
        if (active) { setResult(next); setError(''); }
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active) { setLoading(false); timer = setTimeout(() => void load(), 10_000); } }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [filter, page, revision, currentId]);
  const open = async (task: HistoryTask) => {
    setOpening(task.id); setError('');
    try {
      await api(`/binding-intents/${encodeURIComponent(task.id)}/reopen`, { method: 'POST', body: '{}' });
      globalThis.location.assign(bindingTaskUrl(globalThis.location.href, task.id, task.binding_path).href);
    } catch (cause) { setError(errorMessage(cause)); setOpening(''); }
  };
  return createPortal(<dialog ref={dialog} className="binding-history-dialog" aria-labelledby="binding-history-title" aria-describedby="binding-history-description" onCancel={event => { event.preventDefault(); if (!opening) onClose(); }}>
    <header className="binding-history-header">
      <h2 id="binding-history-title">{t('Binding task history')}</h2>
      <Button kind="ghost" icon="close" disabled={Boolean(opening)} onClick={onClose}>{t('Close')}</Button>
    </header>
    <div className="binding-history-content">
    <p id="binding-history-description">{t('Tasks are saved on the platform. Reopen the original task after switching modules or refreshing. Expired app tasks require reauthorization.')}</p>
    <div className="form-actions">
      <Button kind={filter === 'unfinished' ? 'primary' : 'secondary'} disabled={Boolean(opening)} onClick={() => { setFilter('unfinished'); setPage(0); }}>{t('Unfinished tasks')}</Button>
      <Button kind={filter === 'all' ? 'primary' : 'secondary'} disabled={Boolean(opening)} onClick={() => { setFilter('all'); setPage(0); }}>{t('All tasks')}</Button>
      <Button kind="ghost" disabled={loading || Boolean(opening)} onClick={() => setRevision(value => value + 1)}>{t('Refresh')}</Button>
    </div>
    {error ? <p role="alert" className="inline-alert inline-alert-error">{error}</p> : null}
    {loading ? <p role="status">{t('Loading tasks…')}</p> : result?.items.length === 0 ? <p>{t('No binding tasks found.')}</p> : null}
    {result?.items.map(task => <div className="impact-note native-handoff-request" key={task.id}>
      <div className="native-handoff-request-copy">
        <strong>{task.display_name || task.serial_number || task.id}</strong>
        <p>{task.group_name} · {t(task.binding_path === 'app' ? 'Bind in native app' : 'Bind in browser')} · {t(task.status)}</p>
        <p><code>{task.id}</code>{task.serial_number ? ` · ${task.serial_number}` : ''}</p>
        <p>{new Date(task.created_at).toLocaleString()}{Date.parse(task.expires_at) <= Date.now() && !['completed', 'canceled'].includes(task.status) ? ` · ${t('Expired')}` : ''}</p>
        {task.failure_code ? <p>{task.failure_code}</p> : null}
      </div>
      <Button disabled={disabled || Boolean(opening) || task.id === currentId} onClick={() => void open(task)}>
        {t(task.id === currentId ? 'Current task' : ['completed', 'canceled'].includes(task.status) ? 'View task' : 'Resume task')}
      </Button>
    </div>)}
    {result && result.total_count > 10 ? <nav className="table-pagination" aria-label={t('Pagination')}>
      <Button kind="ghost" disabled={page === 0 || loading || Boolean(opening)} onClick={() => setPage(value => value - 1)}>{t('Previous')}</Button>
      <span>{t('Page {page} of {total}', { page: page + 1, total: Math.ceil(result.total_count / 10) })}</span>
      <Button kind="ghost" disabled={(page + 1) * 10 >= result.total_count || loading || Boolean(opening)} onClick={() => setPage(value => value + 1)}>{t('Next')}</Button>
    </nav> : null}
    </div>
  </dialog>, document.body);
}
