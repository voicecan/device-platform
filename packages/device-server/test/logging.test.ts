import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { RollingFileStream, consoleLogLevel } from '../src/logging.js';

test('console logging suppresses info while respecting stricter levels', () => {
  assert.equal(consoleLogLevel('debug'), 'warn');
  assert.equal(consoleLogLevel('info'), 'warn');
  assert.equal(consoleLogLevel('warn'), 'warn');
  assert.equal(consoleLogLevel('error'), 'error');
  assert.equal(consoleLogLevel('silent'), 'silent');
});

test('rolling file log bounds size and retained file count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voicecan-logging-'));
  try {
    const path = join(directory, 'device-server.log');
    const stream = new RollingFileStream(path, 80, 3);
    for (let index = 0; index < 8; index += 1) stream.write(`${index}:${'x'.repeat(32)}\n`);
    stream.end();
    await finished(stream);
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, ['device-server.log', 'device-server.log.1', 'device-server.log.2']);
    assert.match(await readFile(path, 'utf8'), /^6:.*\n7:/s);
    assert.match(await readFile(`${path}.2`, 'utf8'), /^2:.*\n3:/s);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
