import { clientConfiguration, quickMcpClients, type QuickMcpClient } from './mcp-client-config.js';
import { installCodexMcp, verifyLocalMcp } from './mcp-local-install.js';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireGroupAdmin, AccessDeniedError } from '@voicecan/access-control';
import { OPEN_PLATFORM_PERMISSION_TEMPLATES } from '@voicecan/contracts';
import { tokenHash } from './security.js';
import { OpenPlatformError, type OpenPlatformDependencies, type OpenPlatformService } from './open-platform.js';

type LocalPlan = { application_id: string; credential_id: string; secret_ref: string; expires_at: string };
const metadataScopes = [...OPEN_PLATFORM_PERMISSION_TEMPLATES.metadata_reader];
const loopback = (value: string): boolean => ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '[::1]'].includes(value);
const runner = fileURLToPath(new URL('../dist/mcp-local-runner.js', import.meta.url));

export function registerQuickMcpRoutes(deps: Pick<OpenPlatformDependencies, 'app' | 'db' | 'config' | 'resolveAccess' | 'audit'> & { service: OpenPlatformService }): void {
  const { app, config, db, service, resolveAccess, audit } = deps;
  const pending = new Map<string, Promise<LocalPlan>>();
  const available = async (): Promise<boolean> => {
    if (!loopback(new URL(config.publicBaseUrl).hostname)) return false;
    try { await access(runner); await access(new URL('../../device-mcp/dist/index.js', import.meta.url)); return true; }
    catch { return false; }
  };
  app.get('/api/v1/open-platform/mcp-quick-connect', async (request, reply) => {
    const context = await resolveAccess(request);
    if (context.actorType !== 'user') throw new AccessDeniedError();
    reply.header('cache-control', 'private, no-store');
    return { success: true, code: '', message: 'success', data: { available: loopback(request.ip) && await available(), can_install: context.isSystemAdmin && loopback(request.ip) && await available(), scopes: metadataScopes, mcp_url: new URL('/mcp', config.publicBaseUrl).href }, request_id: request.id };
  });
  app.post('/api/v1/open-platform/mcp-quick-connect', async (request, reply) => {
    const context = await resolveAccess(request, true);
    if (context.actorType !== 'user') throw new AccessDeniedError();
    if (!loopback(request.ip) || request.headers.origin !== new URL(config.publicBaseUrl).origin) throw new OpenPlatformError(403, 'LOCAL_MCP_REQUIRED', 'Quick MCP setup is available only on this server computer');
    if (!await available()) throw new OpenPlatformError(409, 'LOCAL_MCP_UNAVAILABLE', 'Use advanced MCP setup for this installation');
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || Array.isArray(body) || Object.keys(body).some((key) => !['group_id', 'client', 'install', 'access', 'consent'].includes(key)) || typeof body.group_id !== 'string' || !quickMcpClients.includes(body.client as QuickMcpClient)) throw new OpenPlatformError(400, 'INVALID_REQUEST', 'Choose a group and supported AI client');
    if (body.install !== undefined && typeof body.install !== 'boolean') throw new OpenPlatformError(400, 'INVALID_REQUEST', 'install must be a boolean');
    if (body.install && (body.client !== 'codex' || !context.isSystemAdmin)) throw new AccessDeniedError();
    const accessLevel = body.access ?? 'metadata';
    if (!['metadata', 'recordings'].includes(String(accessLevel))) throw new OpenPlatformError(400, 'INVALID_REQUEST', 'Choose a supported access level');
    if (accessLevel === 'recordings' && body.consent !== true) throw new OpenPlatformError(400, 'RECORDING_CONSENT_REQUIRED', 'Confirm access to recording content');
    const scopes = accessLevel === 'recordings' ? [...metadataScopes, 'recordings:download_link:create', 'recordings:download_link:revoke'] : metadataScopes;
    const serverName = accessLevel === 'recordings' ? 'voicecan_elio_recordings' : 'voicecan_elio';
    const groupId = body.group_id;
    requireGroupAdmin(context, groupId);
    if (!await db.get('SELECT id FROM user_groups WHERE id=?', [groupId])) throw new AccessDeniedError();
    const key = tokenHash(`${context.actorId}:${groupId}${accessLevel === 'recordings' ? ':recordings' : ''}`);
    const dir = resolve(config.dataDir, 'mcp-connections');
    const manifest = resolve(dir, `${key}.json`);
    const create = async (): Promise<LocalPlan> => {
      try {
        const plan = JSON.parse(await readFile(manifest, 'utf8')) as LocalPlan;
        const detail = await service.getApplication(context, plan.application_id);
        const credential = (detail.credentials as Record<string, unknown>[]).find((item) => item.id === plan.credential_id);
        if (detail.status !== 'active' || !(detail.channels as string[]).includes('mcp_stdio') || !scopes.every((scope) => (detail.permissions as string[]).includes(scope)) || !credential || credential.status !== 'active' || typeof credential.expires_at !== 'string' || credential.expires_at <= new Date().toISOString() || plan.expires_at <= new Date().toISOString()) throw new OpenPlatformError(409, 'MCP_CONNECTION_INACTIVE', 'Manage the existing MCP connection in Advanced mode');
        if (credential.kind !== 'mcp_stdio_token' || JSON.stringify([...(credential.allowed_ip_cidrs as string[])].sort()) !== JSON.stringify(['127.0.0.1/32', '::1/128'].sort())) throw new OpenPlatformError(409, 'MCP_CONNECTION_CHANGED', 'Manage the existing MCP connection in Advanced mode');
        const savedScopes = credential.scopes as string[];
        if (savedScopes.length !== scopes.length || !scopes.every((scope) => savedScopes.includes(scope))) throw new OpenPlatformError(409, 'MCP_CONNECTION_CHANGED', 'Manage the existing MCP connection in Advanced mode');
        try { await access(plan.secret_ref); }
        catch { throw new OpenPlatformError(409, 'MCP_CREDENTIAL_FILE_MISSING', 'Manage the existing MCP connection in Advanced mode'); }
        return plan;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const application = await service.createApplication(context, { group_id: groupId, name: accessLevel === 'recordings' ? 'AI recording access' : 'Quick MCP', description: accessLevel === 'recordings' ? 'Explicit local recording content access; no device control' : 'Read-only local AI connection', channels: ['mcp_stdio'], permissions: scopes, environment: 'development' });
      await audit(request, context, 'open_platform.application_created', 'open_platform_application', String(application.id), groupId, 'Quick MCP setup');
      const credential = await service.createCredential(context, String(application.id), { kind: 'mcp_stdio_token', name: 'Quick MCP', scopes, allowed_ip_cidrs: ['127.0.0.1/32', '::1/128'], reason: 'Quick MCP setup' });
      const secretRef = resolve(dir, `${String(credential.id)}.token`);
      const plan = { application_id: String(application.id), credential_id: String(credential.id), secret_ref: secretRef, expires_at: String(credential.expires_at) };
      try {
        await writeFile(secretRef, `${String(credential.token)}\n`, { mode: 0o600, flag: 'wx' });
        await writeFile(manifest, JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
      } catch (error) {
        await db.run("UPDATE application_credentials SET status='revoked',revoked_at=? WHERE id=?", [new Date().toISOString(), credential.id]);
        await rm(secretRef, { force: true });
        throw error;
      }
      await audit(request, context, 'open_platform.credential_created', 'application_credential', plan.credential_id, groupId, 'Quick MCP setup');
      return plan;
    };
    let operation = pending.get(key);
    if (!operation) { operation = create(); pending.set(key, operation); }
    let plan: LocalPlan;
    try { plan = await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
    const args = [runner, 'stdio', '--credential-ref', plan.secret_ref, '--server-url', config.publicBaseUrl];
    const entry = { command: process.execPath, args };
    const client = body.client as QuickMcpClient;
    const generated = clientConfiguration(client, entry, serverName);
    let installation: string | null = null; let verifiedTools: number | null = null;
    if (body.install) { verifiedTools = await verifyLocalMcp(entry); installation = await installCodexMcp(entry, undefined, serverName); await audit(request, context, 'open_platform.mcp_installed', 'open_platform_application', plan.application_id, groupId, 'Local Codex configuration verified'); }
    reply.header('cache-control', 'private, no-store');
    return { success: true, code: '', message: 'success', data: { ...plan, installation, verified_tools: verifiedTools, scopes, client, access: accessLevel, ...generated, config: { mcpServers: { [serverName]: entry } } }, request_id: request.id };
  });
}
