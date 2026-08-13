let csrfToken = sessionStorage.getItem('voicecan_csrf') ?? '';

type Envelope<T> = { success: boolean; code: string; message: string; data: T };

export function setCsrfToken(value: string): void {
  csrfToken = value;
  if (value) sessionStorage.setItem('voicecan_csrf', value);
  else sessionStorage.removeItem('voicecan_csrf');
}

function csrfCookie(): string {
  const entry = document.cookie.split('; ').find((value) => value.startsWith('vc_csrf='));
  return entry ? decodeURIComponent(entry.slice('vc_csrf='.length)) : '';
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
  const payload = await response.json() as Envelope<T>;
  if (allowCsrfRefresh && response.status === 403 && payload.code === 'CSRF_FAILED') {
    const refreshed = await request<{ csrf_token: string }>('/auth/csrf', {}, false);
    setCsrfToken(refreshed.csrf_token);
    return request<T>(path, options, false);
  }
  if (!response.ok || !payload.success) throw new Error(`${payload.code}: ${payload.message}`);
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
    const payload = await response.json() as Partial<Envelope<unknown>>;
    message = `${payload.code ?? 'REQUEST_FAILED'}: ${payload.message ?? message}`;
  } catch { /* Preserve the HTTP fallback for a non-JSON proxy response. */ }
  throw new Error(message);
}

export async function apiBinaryUpload<T>(path: string, content: Blob, allowCsrfRefresh = true): Promise<T> {
  const cookieToken = csrfCookie();
  if (cookieToken && cookieToken !== csrfToken) setCsrfToken(cookieToken);
  const response = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) }, body: content });
  const payload = await response.json() as Envelope<T>;
  if (allowCsrfRefresh && response.status === 403 && payload.code === 'CSRF_FAILED') {
    const refreshed = await request<{ csrf_token: string }>('/auth/csrf', {}, false); setCsrfToken(refreshed.csrf_token);
    return apiBinaryUpload<T>(path, content, false);
  }
  if (!response.ok || !payload.success) throw new Error(`${payload.code}: ${payload.message}`);
  return payload.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}
