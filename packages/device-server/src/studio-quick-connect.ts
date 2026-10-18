import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireGroupAdmin, AccessDeniedError } from '@voicecan/access-control';
import { tokenHash } from './security.js';
import { OpenPlatformError, type OpenPlatformDependencies, type OpenPlatformService } from './open-platform.js';
const scopes = ['devices:read', 'recordings:read', 'recordings:download_link:create'];
const local = (value: string): boolean => ['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'].includes(value);
type Plan = { application_id: string; credential_id: string; expires_at: string; secret_ref: string };
export function registerQuickStudioRoutes(deps: Pick<OpenPlatformDependencies, 'app' | 'db' | 'config' | 'resolveAccess' | 'audit'> & { service: OpenPlatformService }): void {
  const { app, db, config, service, resolveAccess, audit } = deps;
  const connections = new Map<string, Promise<void>>();
  const pending = new Map<string, Promise<Plan>>();
  app.post('/api/v1/open-platform/studio-quick-connect', async (request, reply) => {
    const context = await resolveAccess(request, true);
    if (context.actorType !== 'user' || !context.isSystemAdmin) throw new AccessDeniedError();
    if (!local(request.ip) || !local(new URL(config.publicBaseUrl).hostname) || request.headers.origin !== new URL(config.publicBaseUrl).origin) throw new OpenPlatformError(403, 'LOCAL_STUDIO_REQUIRED', 'Open this page on the server computer');
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body.group_id !== 'string' || Object.keys(body).some((key) => key !== 'group_id')) throw new OpenPlatformError(400, 'INVALID_REQUEST', 'Choose a team group');
    const groupId = body.group_id; requireGroupAdmin(context, groupId);
    if (!await db.get('SELECT id FROM user_groups WHERE id=?', [groupId])) throw new AccessDeniedError();
    let runtime: Record<string, unknown>;
    try { const response = await fetch('http://127.0.0.1:8815/api/v1/runtime', { signal: AbortSignal.timeout(3000), redirect: 'error' }); if (!response.ok) throw new Error(); runtime = await response.json() as Record<string, unknown>; }
    catch { throw new OpenPlatformError(409, 'STUDIO_NOT_RUNNING', 'Start the local recording app on port 8815, then retry'); }
    if (runtime.profile !== 'local-full') throw new OpenPlatformError(409, 'STUDIO_PROFILE_MISMATCH', 'Use the installed Local Full recording app');
    const key = tokenHash(`${context.actorId}:${groupId}:studio`), dir = resolve(config.dataDir, 'studio-connections'), manifest = resolve(dir, `${key}.json`);
    const create = async (): Promise<Plan> => {
      try {
        const plan = JSON.parse(await readFile(manifest, 'utf8')) as Plan;
        const detail = await service.getApplication(context, plan.application_id);
        const credential = (detail.credentials as Record<string, unknown>[]).find((item) => item.id === plan.credential_id);
        if (detail.status !== 'active' || !(detail.channels as string[]).includes('rest') || !scopes.every((scope) => (detail.permissions as string[]).includes(scope)) || !credential || credential.status !== 'active' || typeof credential.expires_at !== 'string' || credential.expires_at <= new Date().toISOString() || JSON.stringify([...(credential.allowed_ip_cidrs as string[])].sort()) !== JSON.stringify(['127.0.0.1/32', '::1/128'].sort()) || plan.expires_at <= new Date().toISOString() || JSON.stringify([...(credential.scopes as string[])].sort()) !== JSON.stringify([...scopes].sort())) throw new OpenPlatformError(409, 'STUDIO_CONNECTION_INACTIVE', 'Check the existing Studio application and its credential in Advanced mode');
        await readFile(plan.secret_ref, 'utf8').catch(() => { throw new OpenPlatformError(409, 'STUDIO_CREDENTIAL_FILE_MISSING', 'Check the existing Studio application in Advanced mode'); }); return plan;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (runtime.configured) throw new OpenPlatformError(409, 'STUDIO_ALREADY_CONFIGURED', 'The recording app already has an application connection; keep its existing authorization');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const application = await service.createApplication(context, { group_id: groupId, name: 'Elio Classroom & Work Studio', description: 'Local team recording summaries', environment: 'development', channels: ['rest'], permissions: scopes });
      await audit(request, context, 'open_platform.application_created', 'open_platform_application', String(application.id), groupId, 'Explicit local Studio setup');
      const credential = await service.createCredential(context, String(application.id), { kind: 'api_token', name: 'Local Studio', scopes, allowed_ip_cidrs: ['127.0.0.1/32', '::1/128'], reason: 'Explicit local Studio recording access' });
      const plan: Plan = { application_id: String(application.id), credential_id: String(credential.id), expires_at: String(credential.expires_at), secret_ref: resolve(dir, `${String(credential.id)}.token`) };
      try { await writeFile(plan.secret_ref, String(credential.token), { mode: 0o600, flag: 'wx' }); await writeFile(manifest, JSON.stringify(plan), { mode: 0o600, flag: 'wx' }); }
      catch (error) { await db.run("UPDATE application_credentials SET status='revoked',revoked_at=? WHERE id=?", [new Date().toISOString(), credential.id]); await rm(plan.secret_ref, { force: true }); throw error; }
      await audit(request, context, 'open_platform.credential_created', 'application_credential', plan.credential_id, groupId, 'Explicit local Studio setup'); return plan;
    };
    let operation = pending.get(key); if (!operation) { operation = create(); pending.set(key, operation); }
    let plan: Plan; try { plan = await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
    if (runtime.configured && (runtime.application_id !== plan.application_id || runtime.platform_url !== new URL(config.publicBaseUrl).origin)) throw new OpenPlatformError(409, 'STUDIO_ALREADY_CONFIGURED', 'The recording app has a different application connection');
    if (!runtime.configured) {
      let connecting = connections.get(key);
      if (!connecting) { connecting = (async () => { const token = (await readFile(plan.secret_ref, 'utf8')).trim();
      try { const response = await fetch('http://127.0.0.1:8815/api/local-connection', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform_url: new URL(config.publicBaseUrl).origin, application_token: token, application_id: plan.application_id }), signal: AbortSignal.timeout(120000), redirect: 'error' }); if (!response.ok) throw new Error(); }
      catch { throw new OpenPlatformError(409, 'STUDIO_CONNECT_FAILED', 'The recording app did not accept the connection. The credential is preserved for retry; check its on-page diagnostics.'); }
      })(); connections.set(key, connecting); }
      try { await connecting; } finally { if (connections.get(key) === connecting) connections.delete(key); }
    }
    reply.header('cache-control', 'private, no-store');
    return { success: true, code: '', message: 'success', data: { application_id: plan.application_id, credential_id: plan.credential_id, expires_at: plan.expires_at, scopes, studio_url: 'http://127.0.0.1:8815' }, request_id: request.id };
  });
}
