export type SessionTimestamp = { date: Date; iso: string };

/** Device session IDs are UTC Unix seconds, with a millisecond fallback for future clients. */
export function sessionTimestamp(sessionId: number): SessionTimestamp | null {
  if (!Number.isFinite(sessionId) || sessionId <= 0) return null;
  const millis = sessionId > 1_000_000_000_000 ? sessionId : sessionId * 1_000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : { date, iso: date.toISOString() };
}

export function formatSessionTimestamp(sessionId: number, locale?: string, timeZone?: string): string {
  const value = sessionTimestamp(sessionId);
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale || undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(value.date);
}

export function sessionTimestampTitle(sessionId: number, locale?: string, timeZone?: string): string | undefined {
  const value = sessionTimestamp(sessionId);
  if (!value) return undefined;
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${formatSessionTimestamp(sessionId, locale, timeZone)} · ${zone}`;
}

export function formatIsoTimestamp(value: string | null | undefined, locale?: string, timeZone?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale || undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function isoTimestampTitle(value: string | null | undefined, locale?: string, timeZone?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${formatIsoTimestamp(value, locale, timeZone)} · ${zone}`;
}
