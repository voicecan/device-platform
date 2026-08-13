import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStdioCapabilityChannel, toolList } from '../src/index.js';

test('stdio MCP derives a deterministic least-privilege tool list', () => {
  const tools = toolList(new Set(['devices:read', 'recordings:read']));
  assert.deepEqual(tools.map((tool) => tool.name), ['voicecan.devices.list', 'voicecan.devices.get', 'voicecan.devices.get_capabilities', 'voicecan.recordings.search', 'voicecan.recordings.get']);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
  assert.equal(JSON.stringify(tools).includes('VOICECAN_APPLICATION_TOKEN'), false);
  assert.equal(JSON.stringify(tools).includes('download_url'), false);
});

test('stdio MCP rejects REST credentials instead of bypassing the Application channel', () => {
  assert.doesNotThrow(() => assertStdioCapabilityChannel({ channel: 'mcp_stdio' }));
  assert.throws(() => assertStdioCapabilityChannel({ channel: 'rest' }), /mcp_stdio_token/);
});
