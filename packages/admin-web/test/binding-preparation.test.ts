import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBindingGroup, webBindingStep } from '../src/binding-preparation-state.js';

test('a single ownership group is selected without a separate setup step', () => {
  assert.equal(selectBindingGroup([{ id: 'personal' }], ''), 'personal');
});

test('multiple ownership groups require an explicit selection', () => {
  assert.equal(selectBindingGroup([{ id: 'personal' }, { id: 'team' }], ''), '');
  assert.equal(selectBindingGroup([{ id: 'personal' }, { id: 'team' }], 'team'), 'team');
});

test('an unavailable selected group does not silently move binding to another group', () => {
  assert.equal(selectBindingGroup([{ id: 'other' }], 'previous'), '');
  assert.equal(selectBindingGroup([], ''), '');
});

test('device configuration alone never displays completed binding', () => {
  assert.equal(webBindingStep(false, 0, false), 0);
  assert.equal(webBindingStep(true, 1, false), 1);
  assert.equal(webBindingStep(true, 2, false), 2);
  assert.equal(webBindingStep(true, 3, true), 2);
  assert.equal(webBindingStep(true, 3, false), 3);
});
