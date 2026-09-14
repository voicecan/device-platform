import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingTaskUrl, urlForView } from '../src/navigation.js';

const bindingUrl = 'http://127.0.0.1:8787/admin?binding_intent=bind_example&binding_path=app&binding_path_locked=1&view=provision';

test('leaving device binding removes binding-flow query parameters', () => {
  const url = urlForView(bindingUrl, 'groups');

  assert.equal(url.href, 'http://127.0.0.1:8787/admin?view=groups');
});

test('entering device binding from another page does not revive stale binding state', () => {
  const staleUrl = 'http://127.0.0.1:8787/admin?view=groups&binding_intent=bind_example&binding_path=app&binding_path_locked=1';
  const url = urlForView(staleUrl, 'provision');

  assert.equal(url.href, 'http://127.0.0.1:8787/admin?view=provision');
});

test('updating the current binding view retains its active flow state', () => {
  const url = urlForView(bindingUrl, 'provision');

  assert.equal(url.searchParams.get('binding_intent'), 'bind_example');
  assert.equal(url.searchParams.get('binding_path'), 'app');
  assert.equal(url.searchParams.get('binding_path_locked'), '1');
});


test('history restores the original binding without stale device or launch parameters', () => {
  const url = bindingTaskUrl('https://platform.example/admin?view=devices&device=other#launch=secret', 'bind_original', 'app');
  assert.equal(url.origin, 'https://platform.example');
  assert.equal(url.searchParams.get('view'), 'provision');
  assert.equal(url.searchParams.get('binding_intent'), 'bind_original');
  assert.equal(url.searchParams.get('binding_path'), 'app');
  assert.equal(url.searchParams.get('binding_path_locked'), '1');
  assert.equal(url.searchParams.has('device'), false);
  assert.equal(url.hash, '');
});
