import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target');
if (targetIndex < 0 || !args[targetIndex + 1]) throw new Error('Usage: init-deployment.mjs --target <directory> [--dry-run]');
const target = resolve(args[targetIndex + 1]);
const dryRun = args.includes('--dry-run');
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['docker-compose.yml', 'env.example'];
for (const name of files) {
  const destination = resolve(target, name === 'env.example' ? '.env.example' : name);
  if (!destination.startsWith(`${target}\\`) && !destination.startsWith(`${target}/`)) throw new Error('Target path escaped');
  try { await stat(destination); throw new Error(`Refusing to overwrite ${destination}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(`${dryRun ? 'WOULD_CREATE' : 'CREATE'} ${destination}`);
  if (!dryRun) { await mkdir(target, { recursive: true }); await cp(resolve(skillRoot, 'assets', name), destination, { errorOnExist: true, force: false }); }
}

