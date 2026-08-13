import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessDeniedError, requireScope, sqlGroupGuard, type AccessContext } from '../src/index.js';

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
