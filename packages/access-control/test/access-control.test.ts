import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessDeniedError, requireGroupReader, requireScope, sqlGroupGuard, type AccessContext } from '../src/index.js';

const member: AccessContext = {
  actorId: 'user_1', actorType: 'user', isSystemAdmin: false,
  groupId: 'group_1', isGroupAdmin: false, scopes: new Set(),
};

test('group guard cannot be supplied by request input', () => {
  assert.deepEqual(sqlGroupGuard(member), { clause: 'd.group_id = ?', params: ['group_1'] });
});

test('group token scopes fail closed', () => {
  const token = { ...member, actorType: 'group_token' as const, scopes: new Set(['files:read']) };
  assert.doesNotThrow(() => requireScope(token, 'files:read'));
  assert.throws(() => requireScope(token, 'sync:trigger'), AccessDeniedError);
});

test('Group viewer scopes cap human sessions without changing member or administrator access', () => {
  const viewer: AccessContext = { ...member, membershipRole: 'viewer' };
  for (const scope of ['devices:read', 'recordings:read', 'files:read', 'events:read', 'commands:read', 'recordings:download_link:create']) {
    assert.doesNotThrow(() => requireScope(viewer, scope));
  }
  for (const scope of ['devices:sync', 'recordings:download_link:revoke', 'unknown:write']) {
    assert.throws(() => requireScope(viewer, scope), AccessDeniedError);
    assert.doesNotThrow(() => requireScope(member, scope));
    assert.doesNotThrow(() => requireScope({ ...viewer, isSystemAdmin: true }, scope));
  }
});


test('administrative inspection requires a human group viewer or administrator in the target group', () => {
  const viewer: AccessContext = { ...member, membershipRole: 'viewer' };
  assert.doesNotThrow(() => requireGroupReader(viewer, 'group_1'));
  assert.throws(() => requireGroupReader(viewer, 'group_2'), AccessDeniedError);
  assert.throws(() => requireGroupReader(member, 'group_1'), AccessDeniedError);
  for (const actorType of ['group_token', 'application_token', 'oauth'] as const) {
    assert.throws(() => requireGroupReader({ ...viewer, actorType }, 'group_1'), AccessDeniedError);
  }
  assert.doesNotThrow(() => requireGroupReader({ ...member, isGroupAdmin: true }, 'group_1'));
  assert.doesNotThrow(() => requireGroupReader({ ...member, isSystemAdmin: true }, 'group_2'));
});
