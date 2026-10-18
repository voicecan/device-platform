import { ApiError } from './api-error.js';

export type BindingRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

export async function bindingBrowserRequest<T>(request: BindingRequest, intentId: string, action: 'browser' | 'grant'): Promise<T> {
  const path = `/binding-intents/${encodeURIComponent(intentId)}`;
  const options = action === 'grant' ? { method: 'POST', body: '{}' } : {};
  try { return await request<T>(`${path}/${action}`, options); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !['BINDING_SESSION_REQUIRED', 'BINDING_SESSION_INVALID'].includes(error.code)) throw error;
    // Reopen still requires the signed-in group administrator, CSRF and original
    // origin. It restores only browser continuation, never device authorization.
    await request(`${path}/reopen`, { method: 'POST', body: '{}' });
    return request<T>(`${path}/${action}`, options);
  }
}
