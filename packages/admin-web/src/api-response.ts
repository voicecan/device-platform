import { ApiError } from './api-error.js';

export type ApiEnvelope<T> = { success: boolean; code: string; message: string; data: T };

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.success === 'boolean' && typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

/**
 * Reads the JSON envelope without assuming it exists. Reverse proxies, crash
 * pages, and truncated bodies produce HTML or an empty body; turning those into
 * a typed error keeps the console from failing with an opaque SyntaxError.
 */
export function parseApiEnvelope<T>(status: number, text: string): ApiEnvelope<T> {
  const trimmed = text.trim();
  if (!trimmed) {
    if (status >= 200 && status < 300) return { success: true, code: '', message: 'success', data: undefined as T };
    throw new ApiError(status, 'EMPTY_RESPONSE', `The server returned an empty response (HTTP ${status}). Retry, then check the server logs.`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch {
    throw new ApiError(status >= 400 ? status : 502, 'INVALID_RESPONSE', `The server returned an unreadable response (HTTP ${status}). Check that the reverse proxy and Device Server are healthy, then retry.`);
  }
  if (!isEnvelope(parsed)) {
    throw new ApiError(status >= 400 ? status : 502, 'INVALID_RESPONSE', `The server returned an unexpected response shape (HTTP ${status}). Check that the reverse proxy and Device Server are healthy, then retry.`);
  }
  return parsed as ApiEnvelope<T>;
}
