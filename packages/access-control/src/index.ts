export type AccessContext = {
  actorId: string;
  actorType: 'user' | 'group_token' | 'application_token' | 'oauth';
  isSystemAdmin: boolean;
  groupId: string | null;
  isGroupAdmin: boolean;
  scopes: ReadonlySet<string>;
  applicationId?: string;
  credentialId?: string;
  principalId?: string;
  channel?: 'admin' | 'rest' | 'mcp_stdio' | 'mcp_remote';
};

export class AccessDeniedError extends Error {
  constructor() {
    super('Resource not found');
    this.name = 'AccessDeniedError';
  }
}

export function requireSystemAdmin(context: AccessContext): void {
  if (!context.isSystemAdmin) throw new AccessDeniedError();
}

export function requireGroup(context: AccessContext): string {
  if (!context.groupId) throw new AccessDeniedError();
  return context.groupId;
}

export function requireGroupAdmin(context: AccessContext, groupId: string): void {
  if (context.isSystemAdmin) return;
  if (context.groupId !== groupId || !context.isGroupAdmin) throw new AccessDeniedError();
}

export function requireScope(context: AccessContext, scope: string): void {
  if (context.isSystemAdmin || context.actorType === 'user') return;
  if (!context.scopes.has(scope)) throw new AccessDeniedError();
}

export function sqlGroupGuard(context: AccessContext, deviceAlias = 'd'): { clause: string; params: unknown[] } {
  if (context.isSystemAdmin) return { clause: '1 = 1', params: [] };
  return { clause: `${deviceAlias}.group_id = ?`, params: [requireGroup(context)] };
}
