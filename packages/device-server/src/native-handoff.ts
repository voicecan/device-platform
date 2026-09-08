import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import type { Database, SqlStatement } from './database.js';
import { decryptSecret, encodeDeviceToken, opaqueToken, tokenHash } from './security.js';

type Row = Record<string, unknown>;
export class NativeHandoffError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message = code) { super(message); }
}
const now = () => new Date().toISOString();
const expires = (ms: number, ceiling: string) => new Date(Math.min(Date.now() + ms, Date.parse(ceiling))).toISOString();
const fail = (status: number, code: string): never => { throw new NativeHandoffError(status, code); };
const text = (body: Row, key: string, maximum = 200): string => {
  const value = body[key];
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > maximum) return fail(400, 'INVALID_NATIVE_REQUEST');
  return value;
};
function bodyOf(request: FastifyRequest, fields: readonly string[]): Row {
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) return fail(400, 'INVALID_NATIVE_REQUEST');
  return body as Row;
}
// Closed native request bodies contain only scalar strings and safe integers.
export function nativeCanonicalBody(body: Row): string {
  if (Object.values(body).some(value => typeof value !== 'string' && !Number.isSafeInteger(value))) return fail(400, 'INVALID_NATIVE_REQUEST');
  return JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(key => [key, body[key]])));
}
export function nativeProofMessage(audience: string, path: string, timestamp: string, nonce: string, body: Row): string {
  return ['voicecan.native-proof.v1', audience, 'POST', path, timestamp, nonce, createHash('sha256').update(nativeCanonicalBody(body)).digest('hex')].join('\n');
}
function publicKey(encoded: string) {
  try {
    if (!/^[A-Za-z0-9_-]{100,200}$/.test(encoded)) return fail(400, 'INVALID_NATIVE_PUBLIC_KEY');
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== encoded) return fail(400, 'INVALID_NATIVE_PUBLIC_KEY');
    return key;
  } catch { return fail(400, 'INVALID_NATIVE_PUBLIC_KEY'); }
}
function verifyProof(request: FastifyRequest, audience: string, encodedKey: string, body: Row): { nonce: string; nonceExpiry: string } {
  // Query parameters and browser-origin requests are not part of this protocol.
  if (request.headers.origin || request.url.includes('?')) return fail(403, 'NATIVE_PROOF_REQUIRED');
  const timestamp = request.headers['x-vc-timestamp']; const nonce = request.headers['x-vc-nonce']; const signature = request.headers['x-vc-signature'];
  if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000 ||
      typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{22,80}$/.test(nonce) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{80,110}$/.test(signature)) return fail(401, 'NATIVE_PROOF_INVALID');
  const message = nativeProofMessage(audience, request.url, timestamp, nonce, body);
  if (!verify('sha256', Buffer.from(message), publicKey(encodedKey), Buffer.from(signature, 'base64url'))) return fail(401, 'NATIVE_PROOF_INVALID');
  return { nonce, nonceExpiry: new Date(Number(timestamp) + 120_000).toISOString() };
}
const ok = (reply: FastifyReply, value: Row, status = 200) => reply.header('cache-control', 'private, no-store').code(status).send({ success: true, code: '', message: 'success', data: value, request_id: reply.request.id });

type Dependencies = {
  db: Database; config: ServerConfig;
  authorizeWeb(request: FastifyRequest, intentId: string): Promise<{ intent: Row; actorId: string }>;
  intentState(intent: Row): Promise<Row>;
  claim(session: Row, body: Row, deviceWsUrl: string, fence: SqlStatement[]): Promise<Row>;
};
export function registerNativeHandoffRoutes(app: FastifyInstance, deps: Dependencies): void {
  const { db, config } = deps;
  const audience = new URL(config.publicBaseUrl).origin;
  const instanceId = `instance_${createHash('sha256').update(audience).digest('hex').slice(0, 32)}`;
  const fingerprint = (encodedKey: unknown) => encodedKey ? createHash('sha256').update(Buffer.from(String(encodedKey), 'base64url')).digest('hex').slice(0, 24) : null;
  const read = async (id: string, code = 'NATIVE_HANDOFF_NOT_FOUND'): Promise<Row> => {
    const row = await db.get<Row>('SELECT * FROM native_handoffs WHERE id=?', [id]);
    if (!row) throw new NativeHandoffError(404, code, code === 'NOT_FOUND' ? 'Resource not found' : code);
    return row;
  };
  const intentFor = async (handoff: Row): Promise<Row> => {
    const intent = await db.get<Row>('SELECT * FROM binding_intents WHERE id=?', [handoff.binding_intent_id]);
    if (!intent) return fail(404, 'NATIVE_HANDOFF_NOT_FOUND');
    return intent;
  };
  const assertAlive = (handoff: Row) => { if (String(handoff.expires_at) <= now()) fail(410, 'NATIVE_HANDOFF_EXPIRED'); };
  const fence = (handoff: Row, leaseRequired = true): SqlStatement => ({
    sql: `UPDATE native_handoffs SET updated_at=? WHERE id=? AND status='approved' AND execution_epoch=? AND expires_at>?
      ${leaseRequired ? 'AND lease_expires_at>?' : ''}
      AND EXISTS(SELECT 1 FROM binding_executors e WHERE e.binding_intent_id=native_handoffs.binding_intent_id AND e.handoff_id=native_handoffs.id AND e.execution_epoch=native_handoffs.execution_epoch)
      AND EXISTS(SELECT 1 FROM binding_intents b JOIN user_groups g ON g.id=b.group_id JOIN users u ON u.id=native_handoffs.approved_by
        WHERE b.id=native_handoffs.binding_intent_id AND b.expires_at>? AND b.status NOT IN ('canceled','expired') AND g.status='active' AND u.disabled_at IS NULL
        AND (u.role='system_admin' OR EXISTS(SELECT 1 FROM group_memberships m WHERE m.user_id=u.id AND m.group_id=g.id AND m.active=1 AND m.role='group_admin')))`,
    params: [now(), handoff.id, handoff.execution_epoch, now(), ...(leaseRequired ? [now()] : []), now()], expectChanges: 1,
  });
  const atomic = async (statements: SqlStatement[]) => {
    try { await db.batch(statements); } catch (error) {
      if (error instanceof Error && error.message.startsWith('DATABASE_CAS_FAILED')) return fail(409, 'NATIVE_EXECUTION_CONFLICT');
      throw error;
    }
  };
  const rememberRequest = async (handoff: Row, operation: string, body: Row) => {
    const requestId = text(body, 'request_id'); const hash = tokenHash(nativeCanonicalBody(body));
    await db.run('INSERT INTO native_request_keys(handoff_id,request_id,operation,request_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT(handoff_id,request_id) DO NOTHING', [handoff.id, requestId, operation, hash, now()]);
    const key = await db.get<Row>('SELECT operation,request_hash FROM native_request_keys WHERE handoff_id=? AND request_id=?', [handoff.id, requestId]);
    if (key?.operation !== operation || key.request_hash !== hash) fail(409, 'NATIVE_IDEMPOTENCY_CONFLICT');
  };
  const consumeNonce = async (handoff: Row, proof: { nonce: string; nonceExpiry: string }) => {
    const count = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM native_request_keys WHERE handoff_id=?', [handoff.id]);
    if (Number(count?.count) >= 2048) fail(429, 'NATIVE_REQUEST_LIMIT');
    await db.run('DELETE FROM native_request_nonces WHERE handoff_id=? AND expires_at<?', [handoff.id, now()]);
    const recent = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM native_request_nonces WHERE handoff_id=?', [handoff.id]);
    if (Number(recent?.count) >= 512) fail(429, 'NATIVE_REQUEST_LIMIT');
    const inserted = await db.run('INSERT INTO native_request_nonces(handoff_id,nonce,expires_at) VALUES(?,?,?) ON CONFLICT(handoff_id,nonce) DO NOTHING', [handoff.id, proof.nonce, proof.nonceExpiry]);
    if (inserted.changes !== 1) fail(409, 'NATIVE_PROOF_REPLAY');
  };
  const authenticated = async (request: FastifyRequest, body: Row, operation: string): Promise<Row> => {
    if (!Number.isSafeInteger(body.execution_epoch) || Number(body.execution_epoch) < 0) return fail(400, 'INVALID_NATIVE_REQUEST');
    const handoff = await read(String((request.params as Row).id)); assertAlive(handoff);
    if (!handoff.client_public_key) return fail(401, 'NATIVE_EXCHANGE_REQUIRED');
    const proof = verifyProof(request, audience, String(handoff.client_public_key), body);
    await consumeNonce(handoff, proof);
    await rememberRequest(handoff, operation, body);
    return handoff;
  };
  const summary = async (handoff: Row): Promise<Row> => {
    const intent = await intentFor(handoff); const state = await deps.intentState(intent);
    const executor = await db.get<Row>('SELECT handoff_id,execution_epoch FROM binding_executors WHERE binding_intent_id=?', [intent.id]);
    const owns = handoff.status === 'approved' && String(handoff.lease_expires_at) > now() && executor?.handoff_id === handoff.id && Number(executor?.execution_epoch) === Number(handoff.execution_epoch);
    return {
      schema_version: 1, instance_id: instanceId, audience, binding_intent_id: intent.id, handoff_id: handoff.id,
      status: handoff.status, binding_status: state.status, device_id: state.device_id,
      client_fingerprint: fingerprint(handoff.client_public_key),
      execution_epoch: handoff.execution_epoch ?? 0, owns_execution: owns, lease_expires_at: handoff.lease_expires_at,
      expires_at: handoff.expires_at, expected_identity: { serial_number: intent.expected_sn }, display_name: intent.display_name,
      network_mode: intent.network_mode, resolved_device_ws_url: intent.resolved_device_ws_url,
      scope: ['device:bind'], scan_config: { schema_version: 1, kind: 'voicecan.scan-config', revision: 'native-v1', profiles: [{ id: 'platform', advertised_service_uuids: [config.bleServiceUuid], gatt_profile_id: 'voicecan-default-v1' }] },
      callback_registration: { url: `${audience}/admin?view=provision&binding_intent=${encodeURIComponent(String(intent.id))}`, state: String(intent.id) },
    };
  };

  app.post('/api/v1/binding-intents/:id/native-handoffs', { bodyLimit: 4096 }, async (request, reply) => {
    bodyOf(request, []);
    const { intent } = await deps.authorizeWeb(request, String((request.params as Row).id));
    const state = await deps.intentState(intent);
    if (String(intent.expires_at) <= now() || ['completed', 'canceled', 'expired'].includes(String(state.status))) return fail(409, 'BINDING_NOT_CLAIMABLE');
    const count = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM native_handoffs WHERE binding_intent_id=?', [intent.id]);
    if (Number(count?.count) >= 20) return fail(429, 'NATIVE_HANDOFF_LIMIT');
    const id = `handoff_${randomUUID()}`, ticket = `vcd_native_${opaqueToken()}`, timestamp = now();
    const ticketExpires = expires(5 * 60_000, String(intent.expires_at));
    await db.batch([
      { sql: 'INSERT INTO binding_executors(binding_intent_id,execution_epoch,updated_at) VALUES(?,0,?) ON CONFLICT(binding_intent_id) DO NOTHING', params: [intent.id, timestamp] },
      { sql: "INSERT INTO native_handoffs(id,binding_intent_id,ticket_hash,ticket_expires_at,expires_at,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)", params: [id, intent.id, tokenHash(ticket), ticketExpires, intent.expires_at, timestamp, timestamp], expectChanges: 1 },
    ]);
    const link = new URL('/native/connect', audience); link.searchParams.set('v', '1'); link.searchParams.set('handoff', id); link.hash = `ticket=${encodeURIComponent(ticket)}`;
    return ok(reply, { handoff_id: id, ticket_expires_at: ticketExpires, launch_url: link.href, requires_web_approval: true }, 201);
  });

  app.post('/api/v1/native-handoffs/exchange', { bodyLimit: 4096 }, async (request, reply) => {
    const body = bodyOf(request, ['handoff_id', 'ticket', 'client_public_key', 'request_id']);
    const handoff = await read(text(body, 'handoff_id'));
    const encodedKey = text(body, 'client_public_key', 200); const requestId = text(body, 'request_id');
    const proof = verifyProof(request, audience, encodedKey, body); assertAlive(handoff);
    if (tokenHash(text(body, 'ticket', 512)) !== handoff.ticket_hash) return fail(403, 'NATIVE_TICKET_INVALID');
    const exchangeHash = tokenHash(nativeCanonicalBody(body));
    if (handoff.client_public_key) {
      if (handoff.client_public_key !== encodedKey || handoff.exchange_request_id !== requestId || handoff.exchange_hash !== exchangeHash) return fail(409, 'NATIVE_TICKET_USED');
    } else {
      if (String(handoff.ticket_expires_at) <= now()) return fail(410, 'NATIVE_TICKET_EXPIRED');
      const result = await db.run("UPDATE native_handoffs SET client_public_key=?,exchange_request_id=?,exchange_hash=?,status='exchanged',updated_at=? WHERE id=? AND client_public_key IS NULL AND status='pending' AND ticket_expires_at>?", [encodedKey, requestId, exchangeHash, now(), handoff.id, now()]);
      if (result.changes !== 1) return fail(409, 'NATIVE_TICKET_USED');
    }
    await consumeNonce(handoff, proof); await rememberRequest(handoff, 'exchange', body);
    return ok(reply, await summary(await read(String(handoff.id))));
  });

  app.get('/api/v1/binding-intents/:id/native-handoffs', async (request, reply) => {
    const { intent } = await deps.authorizeWeb(request, String((request.params as Row).id));
    const rows = await db.all<Row>('SELECT id,status,client_public_key,execution_epoch,lease_expires_at,expires_at FROM native_handoffs WHERE binding_intent_id=? ORDER BY created_at DESC,id DESC', [intent.id]);
    const executor = await db.get<Row>('SELECT execution_epoch,handoff_id FROM binding_executors WHERE binding_intent_id=?', [intent.id]);
    return ok(reply, { execution_epoch: executor?.execution_epoch ?? 0, active_handoff_id: executor?.handoff_id ?? null, handoffs: rows.map(({ client_public_key, ...row }) => ({ ...row, client_fingerprint: fingerprint(client_public_key) })) });
  });

  app.post('/api/v1/native-handoffs/:id/approve', { bodyLimit: 4096 }, async (request, reply) => {
    const body = bodyOf(request, ['expected_execution_epoch']); const handoff = await read(String((request.params as Row).id), 'NOT_FOUND');
    const { intent, actorId } = await deps.authorizeWeb(request, String(handoff.binding_intent_id)); assertAlive(handoff);
    const expectedEpoch = body.expected_execution_epoch;
    if (!Number.isSafeInteger(expectedEpoch) || Number(expectedEpoch) < 0) return fail(400, 'INVALID_NATIVE_REQUEST');
    if (!handoff.client_public_key || !['exchanged', 'approved'].includes(String(handoff.status))) return fail(409, 'NATIVE_APPROVAL_NOT_READY');
    const executor = await db.get<Row>('SELECT * FROM binding_executors WHERE binding_intent_id=?', [intent.id]);
    if (executor?.handoff_id === handoff.id && Number(executor?.execution_epoch) === Number(expectedEpoch) + 1 && handoff.status === 'approved' && String(handoff.lease_expires_at) > now()) return ok(reply, await summary(handoff));
    if (Number(executor?.execution_epoch) !== expectedEpoch) return fail(409, 'NATIVE_EXECUTION_CONFLICT');
    const state = await deps.intentState(intent);
    if (['completed', 'expired', 'canceled'].includes(String(state.status))) return fail(409, 'BINDING_NOT_CLAIMABLE');
    const previous = intent.provisioning_session_id ? await db.get<Row>('SELECT * FROM provisioning_sessions WHERE id=?', [intent.provisioning_session_id]) : null;
    // Never silently transfer an executor that already holds a device credential.
    if (previous?.consumed_at && executor?.handoff_id !== handoff.id) return fail(409, 'EXECUTOR_ALREADY_STARTED');
    const sessionId = String(handoff.provisioning_session_id ?? `provision_${randomUUID()}`); const timestamp = now();
    const epoch = Number(expectedEpoch) + 1, lease = expires(120_000, String(handoff.expires_at));
    const statements: SqlStatement[] = [
      { sql: 'UPDATE binding_intents SET updated_at=updated_at WHERE id=? AND provisioning_session_id IS NOT DISTINCT FROM ?', params: [intent.id, intent.provisioning_session_id], expectChanges: 1 },
      { sql: 'UPDATE binding_executors SET handoff_id=?,execution_epoch=?,updated_at=? WHERE binding_intent_id=? AND execution_epoch=?', params: [handoff.id, epoch, timestamp, intent.id, expectedEpoch], expectChanges: 1 },
      { sql: "UPDATE native_handoffs SET status='approved',execution_epoch=?,lease_expires_at=?,provisioning_session_id=?,approved_by=?,updated_at=? WHERE id=? AND status IN ('exchanged','approved') AND expires_at>?", params: [epoch, lease, sessionId, actorId, timestamp, handoff.id, timestamp], expectChanges: 1 },
    ];
    // Insert session before the FK-bearing handoff update. All changes are one transaction.
    if (!handoff.provisioning_session_id) statements.unshift({ sql: "INSERT INTO provisioning_sessions(id,public_token_hash,allowed_origin,expected_sn,group_id,created_by,expires_at,status,updated_at,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)", params: [sessionId, tokenHash(opaqueToken()), `native:${handoff.id}`, intent.expected_sn, intent.group_id, actorId, handoff.expires_at, timestamp, timestamp], expectChanges: 1 });
    if (handoff.provisioning_session_id && previous?.id !== sessionId) statements.push({ sql: "UPDATE provisioning_sessions SET status='pending',failure_code=NULL,failed_at=NULL,updated_at=? WHERE id=? AND status='failed' AND consumed_at IS NULL", params: [timestamp, sessionId], expectChanges: 1 });
    if (previous && previous.id !== sessionId) statements.push({ sql: "UPDATE provisioning_sessions SET status='failed',failure_code='NATIVE_TAKEOVER',updated_at=? WHERE id=? AND consumed_at IS NULL", params: [timestamp, previous.id], expectChanges: 1 });
    statements.push({ sql: "UPDATE binding_intents SET provisioning_session_id=?,status=CASE WHEN device_id IS NULL THEN 'ble_selected' ELSE status END,updated_at=? WHERE id=? AND expires_at>? AND status NOT IN ('completed','canceled','expired')", params: [sessionId, timestamp, intent.id, timestamp], expectChanges: 1 });
    await atomic(statements);
    return ok(reply, await summary(await read(String(handoff.id))));
  });

  app.post('/api/v1/native-handoffs/:id/claim', { bodyLimit: 4096 }, async (request, reply) => {
    const body = bodyOf(request, ['request_id', 'execution_epoch', 'manufacturer', 'serial_number', 'model', 'firmware_version']);
    const handoff = await authenticated(request, body, 'claim');
    if (body.execution_epoch !== Number(handoff.execution_epoch)) return fail(409, 'NATIVE_EXECUTION_CONFLICT');
    const intent = await intentFor(handoff);
    const serial = text(body, 'serial_number', 16); text(body, 'manufacturer', 64);
    if (intent.expected_sn && intent.expected_sn !== serial) return fail(403, 'NATIVE_TARGET_MISMATCH');
    const session = await db.get<Row>('SELECT * FROM provisioning_sessions WHERE id=?', [handoff.provisioning_session_id]);
    if (!session) return fail(409, 'NATIVE_APPROVAL_REQUIRED');
    if (!['pending', 'reserved', 'ble_authenticated', 'configured', 'online', 'completed'].includes(String(session.status))) return fail(409, 'PROVISIONING_STAGE_CONFLICT');
    if (session.device_id) {
      const credential = await db.get<Row>(`SELECT d.sn,d.manufacturer,c.id AS credential_id,c.token_ciphertext,c.key_version FROM devices d
        JOIN device_credentials c ON c.device_id=d.id AND c.status='temporary' AND c.revoked_at IS NULL AND c.expires_at>?
        WHERE d.id=? AND d.group_id=? AND d.deleted_at IS NULL ORDER BY c.credential_epoch DESC LIMIT 1`, [now(), session.device_id, intent.group_id]);
      if (session.status === 'completed') { await atomic([fence(handoff)]); return ok(reply, await summary(handoff)); }
      if (!credential || credential.sn !== serial || credential.manufacturer !== body.manufacturer) return fail(409, 'NATIVE_TARGET_MISMATCH');
      await atomic([fence(handoff)]);
      const raw = decryptSecret(String(credential.token_ciphertext), config.masterKeys.get(Number(credential.key_version)) ?? config.masterKey, `${session.device_id}:${credential.credential_id}`);
      try { return ok(reply, { ...(await summary(handoff)), device_token: encodeDeviceToken(raw), recovered: true }); } finally { raw.fill(0); }
    }
    let claimed: Row;
    try { claimed = await deps.claim(session, body, String(intent.resolved_device_ws_url), [fence(handoff)]); }
    catch (error) {
      if (error instanceof Error && /DATABASE_CAS_FAILED|concurrent/i.test(error.message)) return fail(409, 'NATIVE_EXECUTION_CONFLICT');
      throw error;
    }
    // No browser continuation grant is ever released to the native executor.
    return ok(reply, { ...(await summary(handoff)), device_token: claimed.device_token, recovered: claimed.recovered }, 201);
  });

  for (const operation of ['observe', 'resume'] as const) {
    app.post(`/api/v1/native-handoffs/:id/${operation}`, { bodyLimit: 4096 }, async (request, reply) => {
      const body = bodyOf(request, ['request_id', 'execution_epoch']); const handoff = await authenticated(request, body, operation);
      if (operation === 'observe') return ok(reply, await summary(handoff));
      if (handoff.status === 'approved') {
        if (body.execution_epoch !== Number(handoff.execution_epoch)) return fail(409, 'NATIVE_EXECUTION_CONFLICT');
        await atomic([fence(handoff), { sql: 'UPDATE native_handoffs SET lease_expires_at=? WHERE id=?', params: [expires(120_000, String(handoff.expires_at)), handoff.id], expectChanges: 1 }]);
      }
      return ok(reply, await summary(await read(String(handoff.id))));
    });
  }
  app.post('/api/v1/native-handoffs/:id/progress', { bodyLimit: 4096 }, async (request, reply) => {
    const body = bodyOf(request, ['request_id', 'execution_epoch', 'stage']); const handoff = await authenticated(request, body, 'progress');
    if (body.execution_epoch !== Number(handoff.execution_epoch)) return fail(409, 'NATIVE_EXECUTION_CONFLICT');
    const stage = text(body, 'stage', 32);
    if (!['ble_authenticated', 'configured'].includes(stage)) return fail(400, 'INVALID_PROVISIONING_STAGE');
    const session = await db.get<Row>('SELECT status FROM provisioning_sessions WHERE id=?', [handoff.provisioning_session_id]);
    const order = ['pending', 'reserved', 'ble_authenticated', 'configured', 'online', 'completed'];
    if (!session || order.indexOf(String(session.status)) < 1) return fail(409, 'PROVISIONING_STAGE_CONFLICT');
    const target = order.indexOf(stage), current = order.indexOf(String(session.status));
    if (target > current + 1) return fail(409, 'PROVISIONING_STAGE_CONFLICT');
    const statements = [fence(handoff)];
    if (target > current) statements.push({ sql: 'UPDATE provisioning_sessions SET status=?,updated_at=? WHERE id=? AND status=?', params: [stage, now(), handoff.provisioning_session_id, session.status], expectChanges: 1 });
    await atomic(statements);
    return ok(reply, await summary(handoff));
  });
  app.post('/api/v1/native-handoffs/:id/cancel', { bodyLimit: 4096 }, async (request, reply) => {
    const body = bodyOf(request, ['request_id', 'execution_epoch']); const handoff = await authenticated(request, body, 'cancel');
    if (body.execution_epoch !== Number(handoff.execution_epoch ?? 0)) return fail(409, 'NATIVE_EXECUTION_CONFLICT');
    if (handoff.status === 'approved') await atomic([fence(handoff, false), { sql: "UPDATE native_handoffs SET status='cancelled',lease_expires_at=?,updated_at=? WHERE id=?", params: [now(), now(), handoff.id], expectChanges: 1 }]);
    else if (handoff.status === 'exchanged') await atomic([{ sql: "UPDATE native_handoffs SET status='cancelled',updated_at=? WHERE id=? AND status='exchanged'", params: [now(), handoff.id], expectChanges: 1 }]);
    return ok(reply, { ...(await summary(await read(String(handoff.id)))), outcome: 'stopped_pending_device_confirmation' });
  });
  // A preview/GET never exchanges a ticket or redirects to an untrusted callback.
  app.get('/native/connect', async (_request, reply) => reply.header('cache-control', 'no-store').type('text/plain').send('Open this link in a configured VoiceCan native app. Return to the originating Web page to approve the request. Opening this page does not consume the ticket.'));
}
