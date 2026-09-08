import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { Writable } from 'node:stream';
import pino from 'pino';
import { RollingFileStream, consoleLogLevel, LOG_REDACT_PATHS } from '../src/logging.js';

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


test('native tickets, device credentials and proof headers are redacted', () => {
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const logger = pino({ redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' } }, sink);
  logger.info({ body: { ticket: 'secret-ticket', launch_url: 'secret-link', client_public_key: 'secret-key', device_token: 'secret-token' }, req: { headers: { 'x-vc-signature': 'secret-proof', 'x-vc-nonce': 'secret-nonce' } } });
  assert.doesNotMatch(output, /secret-/);
  assert.match(output, /REDACTED/);
  sink.end();
});
