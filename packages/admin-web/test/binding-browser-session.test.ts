import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { bindingBrowserRequest } from '../src/binding-browser-session.js';

for (const action of ['browser', 'grant'] as const) {
  for (const code of ['BINDING_SESSION_REQUIRED', 'BINDING_SESSION_INVALID']) {
    test(`${action} restores ${code} through authenticated reopen before retrying the same task`, async () => {
      const paths: string[] = [];
      const options: (RequestInit | undefined)[] = [];
      const result = await bindingBrowserRequest(async <T>(path: string, init?: RequestInit): Promise<T> => {
        paths.push(path); options.push(init);
        if (paths.length === 1) throw new ApiError(401, code, 'Browser session unavailable');
        return { id: 'original' } as T;
      }, 'original', action);
      assert.deepEqual(paths, [`/binding-intents/original/${action}`, '/binding-intents/original/reopen', `/binding-intents/original/${action}`]);
      assert.deepEqual(options[1], { method: 'POST', body: '{}' });
      assert.deepEqual(result, { id: 'original' });
    });
  }
}

test('authorization, expiry, executor and network errors are not retried', async () => {
  for (const error of [new ApiError(401, 'SESSION_REQUIRED', 'Sign in'), new ApiError(409, 'BINDING_NOT_CLAIMABLE', 'Expired'), new ApiError(409, 'BINDING_EXECUTOR_ACTIVE', 'Native executor'), new Error('Network failure')]) {
    let calls = 0;
    await assert.rejects(bindingBrowserRequest(async () => { calls++; throw error; }, 'original', 'grant'), (actual) => actual === error);
    assert.equal(calls, 1);
  }
});

test('reopen rejection stops the grant and a retry cannot loop', async () => {
  for (const reopenDenied of [true, false]) {
    let calls = 0;
    await assert.rejects(bindingBrowserRequest(async <T>(): Promise<T> => {
      calls++;
      if (calls === 2 && !reopenDenied) return { id: 'original' } as T;
      throw new ApiError(calls === 2 && reopenDenied ? 404 : 401, calls === 2 && reopenDenied ? 'NOT_FOUND' : 'BINDING_SESSION_INVALID', 'Unavailable');
    }, 'original', 'grant'), ApiError);
    assert.equal(calls, reopenDenied ? 2 : 3);
  }
});
