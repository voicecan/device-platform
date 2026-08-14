import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = resolve('packages/device-server/src/cli.ts');

function execute(home: string, args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', input, env: { ...process.env, VOICECAN_HOME: home, VOICECAN_LOG_LEVEL: 'silent' } });
}

test('AI CLI exposes stable JSON, persistent profiles, dry-run and Admin MCP discovery', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'voicecan-cli-ai-'));
  t.after(async () => rm(home, { recursive: true, force: true }));

  const preview = execute(home, ['onboard', '--dry-run', '--output', 'json']);
  assert.equal(preview.status, 0, preview.stderr);
  const previewEnvelope = JSON.parse(preview.stdout);
  assert.equal(previewEnvelope.ok, true);
  assert.equal(previewEnvelope.command, 'onboard');
  assert.equal(previewEnvelope.data.migration, 'would_run');
  await assert.rejects(stat(join(home, 'default', 'config.json')), { code: 'ENOENT' });

  const absentStatus = execute(home, ['service', 'status', '--output', 'json']);
  assert.equal(absentStatus.status, 0, absentStatus.stderr);
  assert.equal(JSON.parse(absentStatus.stdout).data.installed, false);
  await assert.rejects(stat(join(home, 'default', 'config.json')), { code: 'ENOENT' });

  const capabilities = execute(home, ['capabilities', '--output', 'json']);
  assert.equal(capabilities.status, 0, capabilities.stderr);
  const capabilityEnvelope = JSON.parse(capabilities.stdout);
  assert.ok(capabilityEnvelope.data.capabilities.some((item: { name: string }) => item.name === 'device.bind.prepare'));
  assert.ok(capabilityEnvelope.data.capabilities.some((item: { name: string }) => item.name === 'admin-mcp.stdio'));

  const migrated = execute(home, ['migrate', '--output', 'json']);
  assert.equal(migrated.status, 0, migrated.stderr);
  const migrationEnvelope = JSON.parse(migrated.stdout);
  assert.match(migrationEnvelope.data.database, /voicecan-cli-ai-.*[\\/]default[\\/]data[\\/]device-platform\.sqlite$/);
  await stat(join(home, 'default', 'config.json'));
  await stat(join(home, 'default', 'data', 'device-platform.sqlite'));
  const stored = JSON.parse(await readFile(join(home, 'default', 'config.json'), 'utf8'));
  assert.equal(stored.server.public_base_url, 'http://127.0.0.1:8787');

  const mcp = execute(home, ['admin-mcp', 'stdio'], [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n'));
  assert.equal(mcp.status, 0, mcp.stderr);
  const responses = mcp.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, '@voicecan/device-platform-admin');
  assert.ok(responses[1].result.tools.some((tool: { name: string }) => tool.name === 'voicecan.admin.devices.bind_prepare'));
  assert.ok(responses[1].result.tools.every((tool: { annotations: { destructiveHint: boolean } }) => tool.annotations.destructiveHint === false));
});
