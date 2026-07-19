import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _private } from '../src/updater.js';

const commit = '0123456789abcdef0123456789abcdef01234567';

async function writeManagedInstall(root) {
  const releaseName = `v0.3.2-${commit}`;
  const releaseDir = path.join(root, 'releases', releaseName);
  await mkdir(path.join(releaseDir, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'current'), `${releaseName}\n`);
  await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    owner: 'agygram-managed-installer',
    repository: 'parkjangwon/agygram',
    version: '0.3.2',
    tag: 'v0.3.2',
    commit,
    currentRelease: releaseName,
    configFile: path.join(root, 'config', '.env'),
    dataDir: path.join(root, 'data'),
    serviceInstalled: true,
  }, null, 2)}\n`);
  await writeFile(path.join(releaseDir, '.agygram-release.json'), `${JSON.stringify({
    schemaVersion: 1,
    owner: 'agygram-managed-installer',
    repository: 'parkjangwon/agygram',
    version: '0.3.2',
    tag: 'v0.3.2',
    commit,
    releaseName,
  }, null, 2)}\n`);
  await writeFile(path.join(releaseDir, 'scripts', 'install.mjs'), '');
  return releaseDir;
}

test('managed update detection trusts release receipts instead of git remotes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agygram-managed-update-'));
  const releaseDir = await writeManagedInstall(root);

  const detected = await _private.detectManagedInstallation(releaseDir);

  assert.equal(detected.type, 'managed');
  assert.equal(detected.installRoot, root);
  assert.equal(detected.version, '0.3.2');
  assert.equal(detected.serviceInstalled, true);
  assert.deepEqual(_private.managedInstallerArgs(detected), [
    path.join(releaseDir, 'scripts', 'install.mjs'),
    '--install-root',
    root,
    '--config-file',
    path.join(root, 'config', '.env'),
  ]);
});

test('managed update scheduling uses systemd-run on Linux', async () => {
  const calls = [];
  const result = await _private.scheduleManagedUpdate({
    releaseDir: '/opt/agygram/releases/v0.3.2-0123',
    installRoot: '/opt/agygram',
    configFile: '/home/me/.config/agygram/.env',
    serviceInstalled: true,
  }, {
    platform: 'linux',
    runCommand: async (file, args, cwd) => {
      calls.push({ file, args, cwd });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.method, 'systemd-run');
  assert.equal(calls[0].file, 'systemd-run');
  assert.equal(calls[0].cwd, '/opt/agygram/releases/v0.3.2-0123');
  assert.deepEqual(calls[0].args.slice(0, 5), [
    '--user',
    '--collect',
    '--unit',
    result.unit,
    process.execPath,
  ]);
  assert.deepEqual(calls[0].args.slice(-5), [
    '/opt/agygram/releases/v0.3.2-0123/scripts/install.mjs',
    '--install-root',
    '/opt/agygram',
    '--config-file',
    '/home/me/.config/agygram/.env',
  ]);
});

test('source update accepts common official GitHub remote spellings', () => {
  assert.equal(
    _private.normalizeRemote('git@github.com:parkjangwon/agygram.git\n'),
    'https://github.com/parkjangwon/agygram.git',
  );
  assert.equal(
    _private.normalizeRemote('https://github.com/parkjangwon/agygram'),
    'https://github.com/parkjangwon/agygram.git',
  );
});

test('latest release lookup maps transient failures to retryable update-check errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  try {
    await assert.rejects(
      _private.latestRelease(),
      (error) => error?.code === 'UPDATE_CHECK_UNAVAILABLE',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('latest release lookup maps transport failures to retryable update-check errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    await assert.rejects(
      _private.latestRelease(),
      (error) => error?.code === 'UPDATE_CHECK_UNAVAILABLE',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
