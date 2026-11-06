import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { Button, ReadOnlyActions } from '../src/ui.js';

function render(readOnly: boolean, safe = false, disabled = false): string {
  return renderToStaticMarkup(createElement(ReadOnlyActions.Provider, { value: readOnly ? 'Read-only access' : null }, createElement(Button, { readOnlySafe: safe, disabled, children: 'Inspect or save' })));
}

test('read-only workspaces disable actions by default while retaining explicit inspection and pagination', () => {
  assert.match(render(true), /disabled=""/);
  assert.match(render(true), /title="Read-only access"/);
  assert.doesNotMatch(render(true, true), /disabled=""/);
  assert.match(render(true, true, true), /disabled=""/);
  assert.doesNotMatch(render(false), /disabled=""/);
  assert.doesNotMatch(render(true, true), /readOnlySafe|readonlysafe/);
});
