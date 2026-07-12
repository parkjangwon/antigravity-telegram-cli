import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AGYGRAM_VERSION } from '../src/version.js';

const root = path.resolve(import.meta.dirname, '..');
const parseJson = (name) => readFile(path.join(root, name), 'utf8').then(JSON.parse);
const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

const [packageJson, shrinkwrap, changelog] = await Promise.all([
  parseJson('package.json'),
  parseJson('npm-shrinkwrap.json'),
  readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
]);

assert.match(AGYGRAM_VERSION, semverPattern, 'release version must be strict stable SemVer');
assert.equal(packageJson.version, AGYGRAM_VERSION, 'package.json version mismatch');
assert.equal(shrinkwrap.version, AGYGRAM_VERSION, 'shrinkwrap version mismatch');
assert.equal(shrinkwrap.packages[''].version, AGYGRAM_VERSION, 'root package version mismatch');
assert.match(
  changelog,
  new RegExp(`^## ${AGYGRAM_VERSION.replaceAll('.', '\\.')}(?:\\s|—)`, 'mu'),
  'CHANGELOG is missing the release heading',
);

const bootstrapSources = new Map();
for (const [name, pattern] of [
  ['install.sh', /^BOOTSTRAP_VERSION=(?:['"])?([^'"\s]+)(?:['"])?$/mu],
  ['install.ps1', /\$bootstrapVersion\s*=\s*['"]([^'"]+)['"]/iu],
]) {
  const source = await readFile(path.join(root, name), 'utf8');
  bootstrapSources.set(name, source);
  const embedded = source.match(pattern)?.[1];
  assert.equal(embedded, AGYGRAM_VERSION, `${name} bootstrap version mismatch`);
}

const shellHelper = bootstrapSources.get('install.sh')
  .match(/<<'AGYGRAM_BOOTSTRAP'\r?\n([\s\S]*?)\r?\nAGYGRAM_BOOTSTRAP(?:\r?\n|$)/u)?.[1];
const powershellHelper = bootstrapSources.get('install.ps1')
  .match(/\$helperSource\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@(?:\r?\n|$)/iu)?.[1];
assert.ok(shellHelper, 'install.sh embedded helper is missing');
assert.ok(powershellHelper, 'install.ps1 embedded helper is missing');
assert.equal(powershellHelper, shellHelper, 'POSIX and PowerShell bootstrap helpers differ');
const helperCheck = spawnSync(
  process.execPath,
  ['--check', '--input-type=module'],
  { input: shellHelper, encoding: 'utf8' },
);
assert.equal(
  helperCheck.status,
  0,
  `embedded bootstrap helper syntax failed: ${helperCheck.stderr || helperCheck.stdout}`,
);

if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(
    process.env.GITHUB_REF_NAME,
    `v${AGYGRAM_VERSION}`,
    'Git tag must exactly match package version',
  );
}

console.log(`Release metadata OK: v${AGYGRAM_VERSION}`);
