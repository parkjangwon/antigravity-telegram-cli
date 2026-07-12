import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { AGYGRAM_VERSION } from '../src/version.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('package, shrinkwrap, runtime, and CLI expose one release version', async () => {
  const [packageJson, shrinkwrap, cli] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'npm-shrinkwrap.json'), 'utf8').then(JSON.parse),
    execFileAsync(process.execPath, [path.join(root, 'bin', 'agygram.js'), '--version']),
  ]);

  assert.equal(AGYGRAM_VERSION, '0.3.2');
  assert.equal(packageJson.version, AGYGRAM_VERSION);
  assert.equal(shrinkwrap.version, AGYGRAM_VERSION);
  assert.equal(shrinkwrap.packages[''].version, AGYGRAM_VERSION);
  assert.equal(cli.stdout.trim(), AGYGRAM_VERSION);
  assert.equal(cli.stderr, '');
});
