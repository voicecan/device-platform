export type AccessContext = {
  actorId: string;
  actorType: 'user' | 'group_token' | 'application_token' | 'oauth';
  isSystemAdmin: boolean;
  groupId: string | null;
  isGroupAdmin: boolean;
  membershipRole?: 'group_admin' | 'member' | 'viewer' | null;
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

// Administrative metadata may be inspected by a human Group viewer, within
// their own group. This never grants token access or permission to mutate it.
export function requireGroupReader(context: AccessContext, groupId: string): void {
  if (context.actorType !== 'user') throw new AccessDeniedError();
  if (context.isSystemAdmin) return;
  if (context.groupId !== groupId || (!context.isGroupAdmin && !isGroupViewer(context))) throw new AccessDeniedError();
}

export function requireScope(context: AccessContext, scope: string): void {
  if (context.isSystemAdmin) return;
  if (context.actorType === 'user') {
    if (!isGroupViewer(context) || GROUP_VIEWER_SCOPES.has(scope)) return;
    throw new AccessDeniedError();
  }
  if (!context.scopes.has(scope)) throw new AccessDeniedError();
}

// A Group viewer may obtain short-lived links to read a recording, but cannot
// mutate devices, retry transfers, revoke grants, or mint integration credentials.
export const GROUP_VIEWER_SCOPES: ReadonlySet<string> = new Set([
  'devices:read', 'commands:read', 'recordings:read', 'files:read',
  'recordings:download_link:create', 'events:read',
]);

export function isGroupViewer(context: AccessContext): boolean {
  return context.actorType === 'user' && !context.isSystemAdmin && context.membershipRole === 'viewer';
}

export function sqlGroupGuard(context: AccessContext, deviceAlias = 'd'): { clause: string; params: unknown[] } {
  if (context.isSystemAdmin) return { clause: '1 = 1', params: [] };
  return { clause: `${deviceAlias}.group_id = ?`, params: [requireGroup(context)] };
}
