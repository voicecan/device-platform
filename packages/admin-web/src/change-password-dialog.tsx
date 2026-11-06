import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from './api.js';
import { Button, Field } from './ui.js';
import type { Translate } from './ui.js';

export function ChangePasswordDialog({ t, onClose, onChanged }: { t: Translate; onClose: () => void; onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
      setCurrentPassword(''); setNewPassword(''); onChanged();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <div className="secret-dialog-backdrop"><section className="secret-dialog" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
    <h2 id="change-password-title">{t('Change password')}</h2><p>{t('Changing your password signs out all your sessions.')}</p>
    <form className="form-grid" onSubmit={(event) => void submit(event)}>
      <Field id="current-password" label={t('Current password')} type="password" value={currentPassword} onChange={setCurrentPassword} maxLength={256} required wide/>
      <Field id="new-password" label={t('New password')} type="password" value={newPassword} onChange={setNewPassword} minLength={12} maxLength={256} required wide/>
      {error ? <p role="alert">{error}</p> : null}
      <div className="form-actions"><Button type="submit" disabled={busy || !currentPassword || newPassword.length < 12}>{t('Change password')}</Button><Button kind="ghost" disabled={busy} onClick={onClose}>{t('Cancel')}</Button></div>
    </form>
  </section></div>;
}
