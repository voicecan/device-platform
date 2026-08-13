import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const stage = valueAfter('--stage') ?? 'preview';
const dossierPath = valueAfter('--dossier');
const evidenceDirectory = valueAfter('--evidence-dir');
const jsonOutput = args.includes('--json');

if (!['preview', 'beta', 'ga'].includes(stage)) throw new Error('--stage must be preview, beta, or ga');
if (!dossierPath) throw new Error('--dossier is required');
if (!evidenceDirectory) throw new Error('--evidence-dir is required');

const previewGates = Array.from({ length: 14 }, (_, index) => `DP-${String(index + 1).padStart(2, '0')}`);
const betaGates = Array.from({ length: 10 }, (_, index) => `BETA-${String(index + 1).padStart(2, '0')}`);
const gaGates = Array.from({ length: 5 }, (_, index) => `GA-${String(index + 1).padStart(2, '0')}`);
const requiredGates = stage === 'preview' ? previewGates : stage === 'beta' ? [...previewGates, ...betaGates] : [...previewGates, ...betaGates, ...gaGates];
const issues = [];
const check = (condition, code, message) => { if (!condition) issues.push({ code, message }); };
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const parseJson = async (path, code) => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { issues.push({ code, message: `${path}: ${error instanceof Error ? error.message : String(error)}` }); return null; }
};

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
check(process.version === 'v24.19.0', 'NODE_UNSUPPORTED', `release requires exact Node.js v24.19.0; found ${process.version}`);
check(await exists(resolve(root, 'LICENSE')) || await exists(resolve(root, 'LICENSE.md')), 'LICENSE_MISSING', 'an approved LICENSE file is required for external release');
check(await exists(resolve(root, 'NOTICE')) || await exists(resolve(root, 'NOTICE.md')), 'NOTICE_MISSING', 'a reviewed NOTICE inventory is required for external release');

const evidenceRoot = resolve(evidenceDirectory);
const checksumPath = resolve(evidenceRoot, 'checksums.sha256');
const sbomPath = resolve(evidenceRoot, 'sbom.cdx.json');
const manifestPath = resolve(evidenceRoot, 'release-manifest.json');
check(await exists(checksumPath), 'CHECKSUMS_MISSING', 'checksums.sha256 is missing from the release evidence directory');
check(await exists(sbomPath), 'SBOM_MISSING', 'sbom.cdx.json is missing from the release evidence directory');
const manifest = await parseJson(manifestPath, 'MANIFEST_INVALID');
if (manifest) {
  check(manifest.release_eligible === true, 'MANIFEST_INELIGIBLE', 'release manifest was generated in an ineligible environment');
  check(manifest.repository_commit === commit, 'MANIFEST_COMMIT_MISMATCH', `manifest commit ${manifest.repository_commit ?? '<missing>'} does not match ${commit}`);
  check(manifest.package === packageJson.version, 'MANIFEST_VERSION_MISMATCH', `manifest version ${manifest.package ?? '<missing>'} does not match ${packageJson.version}`);
}

const dossier = await parseJson(resolve(dossierPath), 'DOSSIER_INVALID');
if (dossier) {
  check(dossier.schema_version === 1, 'DOSSIER_SCHEMA_UNSUPPORTED', 'dossier schema_version must be 1');
  check(dossier.candidate?.commit === commit, 'DOSSIER_COMMIT_MISMATCH', `dossier candidate commit must match ${commit}`);
  check(dossier.candidate?.version === packageJson.version, 'DOSSIER_VERSION_MISMATCH', `dossier candidate version must match ${packageJson.version}`);
  for (const gateId of requiredGates) {
    const gate = dossier.gates?.[gateId];
    if (gate?.status !== 'pass') {
      issues.push({ code: 'GATE_NOT_PASSED', message: `${gateId} must have status=pass` });
      continue;
    }
    check(Array.isArray(gate?.evidence) && gate.evidence.length > 0 && gate.evidence.every((item) => typeof item === 'string' && item.trim()), 'GATE_EVIDENCE_MISSING', `${gateId} must reference at least one evidence item`);
    check(typeof gate?.approved_by === 'string' && gate.approved_by.trim(), 'GATE_APPROVER_MISSING', `${gateId} must name an accountable approver`);
    check(typeof gate?.approved_at === 'string' && Number.isFinite(Date.parse(gate.approved_at)), 'GATE_APPROVAL_DATE_INVALID', `${gateId} must have an ISO approval timestamp`);
  }
}

const result = {
  schema_version: 1,
  stage,
  release_ready: issues.length === 0,
  candidate: { version: packageJson.version, commit, node: process.version },
  required_gates: requiredGates,
  issues,
};
if (jsonOutput) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  process.stdout.write(`${result.release_ready ? 'GO' : 'NO-GO'} ${stage} release ${packageJson.version} (${commit.slice(0, 12)})\n`);
  for (const issue of issues) process.stdout.write(`- ${issue.code}: ${issue.message}\n`);
}
process.exit(result.release_ready ? 0 : 1);
