import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const scripts = resolve(import.meta.dirname, '..', 'scripts');
const skillRoot = resolve(import.meta.dirname, '..');

async function fixture(name) {
  return mkdtemp(resolve(tmpdir(), `voicecan-skill-${name}-`));
}

test('installation workflow requires an explicit user choice before preflight', async () => {
  const skill = await readFile(resolve(skillRoot, 'SKILL.md'), 'utf8');
  const methods = await readFile(resolve(skillRoot, 'references', 'installation-methods.md'), 'utf8');
  const choiceIndex = skill.indexOf('wait for the user to explicitly select one');
  const preflightIndex = skill.indexOf('scripts/preflight.mjs --method');
  assert.ok(choiceIndex >= 0 && preflightIndex > choiceIndex);
  assert.match(skill, /Do not infer or default from host capabilities/);
  assert.match(methods, /install\.sh \| bash/);
  assert.match(methods, /install-node\.sh \| bash/);
  assert.match(methods, /Never use the user's `node`, `npm`, nvm, Homebrew Node/);
  await assert.rejects(
    execute(process.execPath, [resolve(scripts, 'preflight.mjs')]),
    /Choose an installation method first/,
  );
});

test('deployment initializer composes into empty Node and Python repositories', async () => {
  for (const [name, manifest, content] of [
    ['node', 'package.json', '{"private":true}\n'],
    ['python', 'pyproject.toml', '[project]\nname="fixture"\n'],
  ]) {
    const target = await fixture(name);
    await writeFile(resolve(target, manifest), content);
    const dryRun = await execute(process.execPath, [resolve(scripts, 'init-deployment.mjs'), '--target', target, '--dry-run']);
    assert.match(dryRun.stdout, /WOULD_CREATE .*docker-compose\.yml/);
    await execute(process.execPath, [resolve(scripts, 'init-deployment.mjs'), '--target', target]);
    assert.match(await readFile(resolve(target, 'docker-compose.yml'), 'utf8'), /service_completed_successfully/);
    assert.equal(await readFile(resolve(target, manifest), 'utf8'), content);
  }
});

test('deployment initializer refuses to overwrite an existing service', async () => {
  const target = await fixture('existing');
  await writeFile(resolve(target, 'docker-compose.yml'), 'services: {}\n');
  await assert.rejects(
    execute(process.execPath, [resolve(scripts, 'init-deployment.mjs'), '--target', target]),
    /Refusing to overwrite/,
  );
  assert.equal(await readFile(resolve(target, 'docker-compose.yml'), 'utf8'), 'services: {}\n');
});

async function fetchFixture(status) {
  const target = await fixture(`fetch-${status}`);
  const preload = resolve(target, 'fetch-fixture.mjs');
  await writeFile(preload, `globalThis.fetch=async(url)=>{const path=new URL(url).pathname;if(Number(process.env.VOICECAN_FIXTURE_STATUS)!==200||path==='/health/ready')return new Response('',{status:Number(process.env.VOICECAN_FIXTURE_STATUS)});return Response.json({success:true,data:{status:'ready'}})};\n`);
  return { preload, environment: { ...process.env, VOICECAN_FIXTURE_STATUS: String(status) } };
}

test('fixture-safe smoke accepts the health contract without touching devices', async () => {
  const fixture = await fetchFixture(200);
  const result = await execute(process.execPath, ['--import', pathToFileURL(fixture.preload).href, resolve(scripts, 'smoke-test.mjs'), '--url', 'http://fixture.invalid'], { env: fixture.environment });
  assert.match(result.stdout, /Real device binding and external messages were not attempted/);
});

test('fault fixture makes smoke fail closed on readiness', async () => {
  const fixture = await fetchFixture(503);
  await assert.rejects(
    execute(process.execPath, ['--import', pathToFileURL(fixture.preload).href, resolve(scripts, 'smoke-test.mjs'), '--url', 'http://fixture.invalid'], { env: fixture.environment }),
    /Readiness failed with HTTP 503/,
  );
});

test('doctor validates the supported runtime contract and pinned protocol-runtime artifact', async () => {
  const target = await fixture('doctor');
  const preload = resolve(target, 'doctor-fixture.mjs');
  await writeFile(preload, `Object.defineProperty(process.versions,'node',{value:'24.15.0'});globalThis.fetch=async(url)=>Response.json({success:true,data:{status:new URL(url).pathname.includes('setup')?'ready':'ok'}});\n`);
  const root = resolve(import.meta.dirname, '..', '..', '..');
  const result = await execute(process.execPath, [
    '--import', pathToFileURL(preload).href,
    resolve(scripts, 'doctor.mjs'),
    '--url', 'http://localhost:8787',
    '--core-lock', resolve(root, 'core-artifacts.lock.json'),
  ]);
  assert.match(result.stdout, /OK Node\.js >=24\.15 <25/);
  assert.match(result.stdout, /OK Protocol-runtime artifact digest/);
  assert.match(result.stdout, /OK Core ABI contract/);
});
