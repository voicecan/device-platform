import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ServerConfig } from './config.js';
import type { Database } from './database.js';
import { decryptSecretWithKeyring } from './security.js';
import { API_VERSION } from '@voicecan/contracts';

type DeliveryRow = {
  id: string;
  event_id: string;
  endpoint_id: string;
  application_id: string | null;
  attempts: number;
  url: string;
  secret_id: string;
  secret_ciphertext: string;
  payload_json: string;
  event_type: string;
  event_created_at: string;
  event_device_id: string;
  replay_namespace: string;
  event_types_json: string;
  device_ids_json: string;
  attributes_json: string;
};

function parseFilter(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' || typeof item === 'number').map(String) : [];
  } catch {
    return [];
  }
}

export function matchesEventSubscriptionFilter(row: Pick<DeliveryRow, 'replay_namespace' | 'event_types_json' | 'device_ids_json' | 'attributes_json' | 'event_type' | 'event_device_id' | 'payload_json'>): boolean {
  if (row.replay_namespace.startsWith('test:')) return true;
  const types = parseFilter(row.event_types_json);
  const devices = parseFilter(row.device_ids_json);
  const attributes = parseFilter(row.attributes_json);
  if (types.length > 0 && !types.includes(row.event_type)) return false;
  if (devices.length > 0 && !devices.includes(row.event_device_id)) return false;
  if (attributes.length > 0) {
    let attribute: string | undefined;
    try {
      const payload = JSON.parse(row.payload_json) as { attribute?: unknown };
      if (typeof payload.attribute === 'string' || typeof payload.attribute === 'number') attribute = String(payload.attribute);
    } catch {
      return false;
    }
    if (attribute === undefined || !attributes.includes(attribute)) return false;
  }
  return true;
}

const deniedAddresses = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) deniedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]] as const) deniedAddresses.addSubnet(network, prefix, 'ipv6');

function isPrivateAddress(rawAddress: string): boolean {
  const address = rawAddress.startsWith('[') && rawAddress.endsWith(']') ? rawAddress.slice(1, -1) : rawAddress;
  const family = isIP(address);
  return family === 0 || deniedAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export async function validateWebhookUrl(rawUrl: string, allowPrivate: boolean, allowHttp = false): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.username || url.password) throw new Error('WEBHOOK_CREDENTIALS_DENIED');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('WEBHOOK_HTTP_PROTOCOL_REQUIRED');
  if (url.protocol === 'http:' && !allowHttp) throw new Error('WEBHOOK_HTTPS_REQUIRED');
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!allowPrivate && addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('WEBHOOK_PRIVATE_ADDRESS_DENIED');
  return url;
}

async function postWebhook(rawUrl: string, allowPrivate: boolean, allowHttp: boolean, headers: Record<string, string>, body: string): Promise<number> {
  const url = await validateWebhookUrl(rawUrl, allowPrivate, allowHttp);
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  const resolved = isIP(hostname) ? hostname : (await lookup(hostname, { all: true }))[0]?.address;
  if (!resolved || (!allowPrivate && isPrivateAddress(resolved))) throw new Error('WEBHOOK_ADDRESS_DENIED');
  return new Promise<number>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport({
      protocol: url.protocol, hostname: resolved, port: url.port || undefined, path: `${url.pathname}${url.search}`,
      method: 'POST', servername: url.protocol === 'https:' ? hostname : undefined,
      headers: { ...headers, host: url.host, 'content-length': String(Buffer.byteLength(body)) },
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
    request.setTimeout(10_000, () => request.destroy(new Error('WEBHOOK_TIMEOUT')));
    request.on('error', reject);
    request.end(body);
  });
}

export class EventDispatcher {
  #timer?: NodeJS.Timeout;
  #running = false;
  readonly #instanceId = `dispatcher_${randomUUID()}`;

  constructor(private readonly db: Database, private readonly config: ServerConfig) {}

  start(): void {
    this.#timer = setInterval(() => void this.drain(), 2_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.db.run(`UPDATE event_endpoints SET
        secret_id=next_secret_id,secret_ciphertext=next_secret_ciphertext,
        next_secret_id=NULL,next_secret_ciphertext=NULL,next_activates_at=NULL
        WHERE next_secret_id IS NOT NULL AND next_activates_at<=?`, [new Date().toISOString()]);
      const claimAt = new Date().toISOString();
      const claimExpiresAt = new Date(Date.now() + 30_000).toISOString();
      const rows = await this.db.all<DeliveryRow>(`
        SELECT ed.id, ed.event_id, ed.endpoint_id, ed.attempts, ed.replay_namespace, ep.application_id,
               ep.url, ep.secret_id, ep.secret_ciphertext,
               ep.event_types_json, ep.device_ids_json, ep.attributes_json,
               e.payload_json, e.type AS event_type, e.created_at AS event_created_at, e.device_id AS event_device_id
        FROM event_deliveries ed
        JOIN event_endpoints ep ON ep.id = ed.endpoint_id AND ep.enabled = 1
        LEFT JOIN open_platform_applications a ON a.id = ep.application_id
        JOIN events e ON e.id = ed.event_id
        JOIN devices d ON d.id = e.device_id
        WHERE ed.status = 'pending' AND ed.next_attempt_at <= ?
          AND (ed.claimed_by IS NULL OR ed.claim_expires_at <= ?)
          AND ep.group_id = d.group_id AND e.owner_group_id = d.group_id AND e.ownership_epoch = d.ownership_epoch
          AND (ep.application_id IS NULL OR (
            a.status='active' AND a.channels_json LIKE '%"webhook"%' AND EXISTS(
              SELECT 1 FROM application_permission_grants p WHERE p.application_id=a.id AND p.permission='events:read'
            )
          ))
        ORDER BY ed.next_attempt_at, ed.id LIMIT 20`, [claimAt, claimAt]);
      for (const row of rows) {
        if (!matchesEventSubscriptionFilter(row)) {
          await this.db.run("UPDATE event_deliveries SET status='canceled',last_error='ENDPOINT_FILTER_CHANGED',claimed_by=NULL,claim_expires_at=NULL WHERE id=? AND status='pending'", [row.id]);
          continue;
        }
        const claim = await this.db.run("UPDATE event_deliveries SET claimed_by=?,claim_expires_at=? WHERE id=? AND status='pending' AND next_attempt_at<=? AND (claimed_by IS NULL OR claim_expires_at<=?)", [this.#instanceId, claimExpiresAt, row.id, claimAt, claimAt]);
        if (claim.changes === 1) await this.#deliver(row);
      }
    } finally {
      this.#running = false;
    }
  }

  async #deliver(row: DeliveryRow): Promise<void> {
    const eligible = await this.db.get<DeliveryRow>(`SELECT ed.id,ed.event_id,ed.endpoint_id,ed.attempts,ed.replay_namespace,ep.application_id,
        ep.url,ep.secret_id,ep.secret_ciphertext,ep.event_types_json,ep.device_ids_json,ep.attributes_json,
        e.payload_json,e.type AS event_type,e.created_at AS event_created_at,e.device_id AS event_device_id
      FROM event_deliveries ed
      JOIN event_endpoints ep ON ep.id=ed.endpoint_id AND ep.enabled=1
      LEFT JOIN open_platform_applications a ON a.id=ep.application_id
      JOIN events e ON e.id=ed.event_id
      WHERE ed.id=? AND ed.status='pending' AND ed.claimed_by=?
        AND (ep.application_id IS NULL OR (
          a.status='active' AND a.channels_json LIKE '%"webhook"%' AND EXISTS(
            SELECT 1 FROM application_permission_grants p WHERE p.application_id=a.id AND p.permission='events:read'
          )
        ))`, [row.id, this.#instanceId]);
    if (!eligible) return;
    if (!matchesEventSubscriptionFilter(eligible)) {
      await this.db.run("UPDATE event_deliveries SET status='canceled',last_error='ENDPOINT_FILTER_CHANGED',claimed_by=NULL,claim_expires_at=NULL WHERE id=? AND status='pending' AND claimed_by=?", [row.id, this.#instanceId]);
      return;
    }
    row = eligible;
    const deliveryId = row.id;
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = JSON.stringify({
      id: row.event_id,
      type: row.event_type,
      api_version: API_VERSION,
      created_at: row.event_created_at,
      data: JSON.parse(row.payload_json),
    });
    try {
      const secret = decryptSecretWithKeyring(row.secret_ciphertext, this.config.masterKeys, row.endpoint_id);
      const signature = createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.`).update(body).digest('hex');
      const status = await postWebhook(row.url, this.config.allowPrivateWebhooks, this.config.allowHttpWebhooks, {
          'content-type': 'application/json',
          'voicecan-event-id': row.event_id,
          'voicecan-delivery-id': deliveryId,
          'voicecan-timestamp': timestamp,
          'voicecan-secret-id': row.secret_id,
          'voicecan-signature': `v1=${signature}`,
      }, body);
      if (status < 200 || status >= 300) throw new Error(`HTTP_${status}`);
      await this.db.run("UPDATE event_deliveries SET status='delivered',attempts=attempts+1,delivered_at=?,last_status_code=?,last_error=NULL,claimed_by=NULL,claim_expires_at=NULL WHERE id=? AND status='pending' AND claimed_by=? AND EXISTS(SELECT 1 FROM event_endpoints WHERE id=? AND enabled=1)", [new Date().toISOString(), status, row.id, this.#instanceId, row.endpoint_id]);
    } catch (error) {
      const attempts = row.attempts + 1;
      const next = new Date(Date.now() + Math.min(3_600_000, 1_000 * 2 ** attempts)).toISOString();
      const errorMessage = error instanceof Error ? error.message.slice(0, 200) : 'DELIVERY_FAILED';
      const statusCode = /^HTTP_(\d{3})$/.exec(errorMessage)?.[1];
      const updated = await this.db.run("UPDATE event_deliveries SET status=?,attempts=?,next_attempt_at=?,last_status_code=?,last_error=?,claimed_by=NULL,claim_expires_at=NULL WHERE id=? AND status='pending' AND claimed_by=? AND EXISTS(SELECT 1 FROM event_endpoints WHERE id=? AND enabled=1)", [
        attempts >= 12 ? 'dead' : 'pending', attempts, next,
        statusCode ? Number(statusCode) : null, errorMessage, row.id, this.#instanceId, row.endpoint_id,
      ]);
      if (attempts >= 12 && updated.changes === 1 && row.application_id) {
        await this.db.run('INSERT INTO open_platform_security_alerts(id,application_id,severity,code,details_json,created_at) VALUES(?,?,?,?,?,?)', [`alert_${randomUUID()}`, row.application_id, 'warning', 'WEBHOOK_DELIVERY_DEAD', JSON.stringify({ endpoint_id: row.endpoint_id, delivery_id: row.id, event_id: row.event_id, attempts }), new Date().toISOString()]);
      }
    }
  }
}
