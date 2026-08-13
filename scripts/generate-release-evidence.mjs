import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const output = resolve(outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : resolve(root, 'release-evidence'));
const allowUnsupported = args.includes('--allow-unsupported-node');
const supportedNode = process.version === 'v24.19.0';
if (!supportedNode && !allowUnsupported) throw new Error(`Release evidence requires exact Node.js v24.19.0; found ${process.version}`);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const lock = JSON.parse(await readFile(resolve(root, 'core-artifacts.lock.json'), 'utf8'));
const inputs = [
  resolve(root, 'package.json'),
  resolve(root, 'package-lock.json'),
  resolve(root, 'Dockerfile'),
  resolve(root, 'core-artifacts.lock.json'),
  resolve(root, 'node-runtime.lock'),
  resolve(root, 'install.sh'),
  resolve(root, 'install-node.sh'),
  resolve(root, 'deploy/docker-compose.yml'),
  resolve(root, lock.file),
  resolve(root, 'docs/openapi.yaml'),
  ...await filesUnder(resolve(root, 'packages')),
].filter((path) => !path.endsWith('.tsbuildinfo') && !path.endsWith('.d.ts') && !path.endsWith('.d.ts.map') && !path.endsWith('.js.map'));

const unique = [...new Set(inputs)].sort();
const checksums = [];
for (const path of unique) {
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  checksums.push(`${digest}  ${relative(root, path)}`);
}

const sbom = execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx'], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(resolve(output, 'checksums.sha256'), `${checksums.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
await writeFile(resolve(output, 'sbom.cdx.json'), `${JSON.stringify(JSON.parse(sbom), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
await writeFile(resolve(output, 'release-manifest.json'), `${JSON.stringify({
  schema_version: 1,
  generated_at: new Date().toISOString(),
  repository_commit: commit,
  package: JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version,
  node: process.version,
  release_eligible: supportedNode,
  core: lock,
  artifacts: {
    checksums: basename(resolve(output, 'checksums.sha256')),
    sbom: basename(resolve(output, 'sbom.cdx.json')),
  },
  required_external_evidence: ['oci-signature', 'provenance-attestation', 'vulnerability-scan', 'license-approval', 'independent-security-review'],
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`Release evidence generated at ${output}; release_eligible=${supportedNode}\n`);
