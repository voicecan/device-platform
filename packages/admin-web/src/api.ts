import { ApiError } from './api-error.js';
import { parseApiEnvelope } from './api-response.js';

// Storage access throws in some hardened/embedded browsers; a lost cache only
// costs one refresh round-trip, so it must never break the module import.
function readStoredToken(): string {
  try { return globalThis.sessionStorage?.getItem('voicecan_csrf') ?? ''; }
  catch { return ''; }
}

function writeStoredToken(value: string): void {
  try {
    if (value) globalThis.sessionStorage?.setItem('voicecan_csrf', value);
    else globalThis.sessionStorage?.removeItem('voicecan_csrf');
  } catch { /* the in-memory token still works for this page */ }
}

let csrfToken = readStoredToken();

export function setCsrfToken(value: string): void {
  csrfToken = value;
  writeStoredToken(value);
}

function csrfCookie(): string {
  try {
    const entry = document.cookie.split('; ').find((value) => value.startsWith('vc_csrf='));
    return entry ? decodeURIComponent(entry.slice('vc_csrf='.length)) : '';
  } catch { return ''; }
}

async function request<T>(path: string, options: RequestInit, allowCsrfRefresh: boolean): Promise<T> {
  const cookieToken = csrfCookie();
  if (cookieToken && cookieToken !== csrfToken) setCsrfToken(cookieToken);
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...options.headers,
    },
  });
  const payload = parseApiEnvelope<T>(response.status, await response.text());
  if (allowCsrfRefresh && response.status === 403 && payload.code === 'CSRF_FAILED') {
    const refreshed = await request<{ csrf_token: string }>('/auth/csrf', {}, false);
    setCsrfToken(refreshed.csrf_token);
    return request<T>(path, options, false);
  }
  if (!response.ok || !payload.success) throw new ApiError(response.status, payload.code, payload.message);
  return payload.data;
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  return request<T>(path, options, path !== '/auth/csrf');
}

export async function apiBinary(path: string): Promise<Response> {
  const response = await fetch(`/api/v1${path}`, { headers: { accept: 'application/octet-stream' } });
  if (response.ok) return response;
  let message = `HTTP ${response.status}`;
  try {
    const payload = parseApiEnvelope<unknown>(response.status, await response.text());
    message = `${payload.code || 'REQUEST_FAILED'}: ${payload.message || message}`;
  } catch (error) {
    // Preserve the HTTP fallback for a non-JSON proxy response, but keep a
    // server-provided code/message when there is one.
    if (error instanceof ApiError && !['INVALID_RESPONSE', 'EMPTY_RESPONSE'].includes(error.code)) message = `${error.code}: ${error.message}`;
  }
  throw new Error(message);
}

export async function apiBinaryUpload<T>(path: string, content: Blob, allowCsrfRefresh = true): Promise<T> {
  const cookieToken = csrfCookie();
  if (cookieToken && cookieToken !== csrfToken) setCsrfToken(cookieToken);
  const response = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) }, body: content });
  const payload = parseApiEnvelope<T>(response.status, await response.text());
  if (allowCsrfRefresh && response.status === 403 && payload.code === 'CSRF_FAILED') {
    const refreshed = await request<{ csrf_token: string }>('/auth/csrf', {}, false); setCsrfToken(refreshed.csrf_token);
    return apiBinaryUpload<T>(path, content, false);
  }
  if (!response.ok || !payload.success) throw new ApiError(response.status, payload.code, payload.message);
  return payload.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}
