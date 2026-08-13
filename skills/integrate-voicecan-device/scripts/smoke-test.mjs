const args = process.argv.slice(2);
const index = args.indexOf('--url');
if (index < 0 || !args[index + 1]) throw new Error('Usage: smoke-test.mjs --url <server-url>');
const base = new URL(args[index + 1]);
const ready = await fetch(new URL('/health/ready', base), { signal: AbortSignal.timeout(5_000) });
if (!ready.ok) throw new Error(`Readiness failed with HTTP ${ready.status}`);
const setup = await fetch(new URL('/api/v1/setup/status', base), { signal: AbortSignal.timeout(5_000) });
const payload = await setup.json();
if (!setup.ok || !payload.success) throw new Error('Setup status contract failed');
console.log(`OK fixture-safe smoke; setup=${payload.data.status}`);
console.log('Real device binding and external messages were not attempted.');

