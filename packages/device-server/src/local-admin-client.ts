import type { ServerConfig } from './config.js';
import { CliError } from './cli-contract.js';

type ApiEnvelope<T> = { success?: boolean; code?: string; message?: string; data?: T; request_id?: string };

export async function localAdminRequest<T>(config: ServerConfig, path: string, init: RequestInit = {}): Promise<T> {
  if (!config.localOperatorKey) throw new CliError('LOCAL_OPERATOR_UNAVAILABLE', 'Local automation is disabled for this deployment; configure VOICECAN_LOCAL_OPERATOR_KEY through the deployment secret manager', 4);
  const localBaseUrl = `http://127.0.0.1:${config.port}`;
  let response: Response;
  try {
    response = await fetch(`${localBaseUrl}/api/v1${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer vcd_local_${config.localOperatorKey.toString('base64url')}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    throw new CliError('SERVICE_UNAVAILABLE', `Cannot reach the local Device Platform service on port ${config.port}: ${error instanceof Error ? error.message : String(error)}`, 6);
  }
  let payload: ApiEnvelope<T>;
  try { payload = await response.json() as ApiEnvelope<T>; }
  catch { throw new CliError('INVALID_SERVER_RESPONSE', `Local Device Platform returned HTTP ${response.status} without a JSON response`, 6); }
  if (!response.ok || !payload.success) throw new CliError(payload.code || 'REQUEST_FAILED', payload.message || `HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 4 : response.status >= 500 ? 6 : 5, { request_id: payload.request_id, status: response.status });
  return payload.data as T;
}
