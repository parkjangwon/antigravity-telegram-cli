import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { uninstallManagedInstallation } from '../scripts/uninstall.mjs';

const OWNER = 'agygram-managed-installer';
const REPOSITORY = 'parkjangwon/agygram';
const VERSION = '0.2.0';
const COMMIT = 'a'.repeat(40);
const RELEASE = `v${VERSION}-${COMMIT}`;
const NOW = '2026-07-12T00:00:00.000Z';

async function privateDirectory(target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(target, 0o700);
}

async function privateFile(target, body, mode = 0o600) {
  await writeFile(target, body, { mode });
  if (process.platform !== 'win32') await chmod(target, mode);
}

function digest(body) {
  return createHash('sha256').update(body).digest('hex');
}

async function fixture(t, { serviceInstalled = true } = {}) {
  const realTmp = await realpath(os.tmpdir());
  const base = await mkdtemp(path.join(realTmp, 'agygram-uninstall-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = path.join(base, 'home');
  const installRoot = path.join(base, 'custom-manager');
  const configFile = path.join(base, 'external-config', 'bot.env');
  const dataDir = path.join(base, 'external-data');
  const workspaceDir = path.join(base, 'external-workspace');
  const releasesDir = path.join(installRoot, 'releases');
  const releaseRoot = path.join(releasesDir, RELEASE);
  const launcherDirectory = path.join(installRoot, 'bin');
  for (const directory of [
    homeDir,
    installRoot,
    path.dirname(configFile),
    dataDir,
    workspaceDir,
    releasesDir,
    releaseRoot,
    path.join(releaseRoot, 'bin'),
    launcherDirectory,
  ]) await privateDirectory(directory);
  await privateFile(configFile, 'BOT_TOKEN=test-only\n');
  await privateFile(path.join(dataDir, 'keep.txt'), 'runtime data\n');
  await privateFile(path.join(workspaceDir, 'keep.txt'), 'workspace data\n');
  await privateFile(path.join(installRoot, '.agygram-managed-root.json'), `${JSON.stringify({
    schemaVersion: 1,
    owner: OWNER,
    repository: REPOSITORY,
    installRoot,
    createdAt: NOW,
  })}\n`);
  await privateFile(path.join(releaseRoot, '.agygram-release.json'), `${JSON.stringify({
    schemaVersion: 1,
    owner: OWNER,
    repository: REPOSITORY,
    version: VERSION,
    tag: `v${VERSION}`,
    commit: COMMIT,
    releaseName: RELEASE,
    archiveSha256: 'b'.repeat(64),
    installedAt: NOW,
  })}\n`);
  await privateFile(path.join(releaseRoot, 'package.json'), `${JSON.stringify({
    name: 'agygram',
    version: VERSION,
    repository: { type: 'git', url: `git+https://github.com/${REPOSITORY}.git` },
  })}\n`);
  await privateFile(path.join(releaseRoot, 'bin', 'agygram.js'), '#!/usr/bin/env node\n', 0o700);

  const jsLauncher = '#!/usr/bin/env node\n';
  const nativeName = process.platform === 'win32' ? 'agygram.cmd' : 'agygram';
  const nativeLauncher = process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n';
  const launchers = [
    { path: path.join(launcherDirectory, 'agygram.mjs'), body: jsLauncher },
    { path: path.join(launcherDirectory, nativeName), body: nativeLauncher },
  ];
  for (const launcher of launchers) await privateFile(launcher.path, launcher.body, 0o700);
  const manifest = {
    schemaVersion: 1,
    owner: OWNER,
    repository: REPOSITORY,
    version: VERSION,
    tag: `v${VERSION}`,
    commit: COMMIT,
    currentRelease: RELEASE,
    previousRelease: null,
    configFile,
    dataDir,
    workspaceDir,
    serviceInstalled,
    serviceEnvironment: {
      xdgConfigHome: process.platform === 'linux' ? path.join(base, 'installed-xdg-config') : null,
    },
    launcher: {
      directory: launcherDirectory,
      files: launchers.map((launcher) => ({
        path: launcher.path,
        kind: 'file',
        sha256: digest(launcher.body),
      })),
    },
    installedAt: NOW,
    updatedAt: NOW,
  };
  await privateFile(path.join(installRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await privateFile(path.join(installRoot, 'current'), `${RELEASE}\n`);
  return {
    base,
    homeDir,
    installRoot,
    configFile,
    dataDir,
    workspaceDir,
    releaseRoot,
    manifest,
    launcherPath: launchers[0].path,
  };
}

function dependencies(context, overrides = {}) {
  return {
    testMode: true,
    homeDir: context.homeDir,
    env: {
      ...process.env,
      // Deliberately unrelated to the receipt: changing XDG after install must
      // not invalidate custom external paths recorded by the installer.
      XDG_DATA_HOME: path.join(context.base, 'different-xdg-data'),
      XDG_CONFIG_HOME: path.join(context.base, 'different-xdg-config'),
    },
    uid: process.getuid?.(),
    allowRoot: process.getuid?.() === 0,
    output() {},
    warning() {},
    processAlive() { return false; },
    ...overrides,
  };
}

test('managed uninstall stops the service first and preserves all external state', async (t) => {
  const context = await fixture(t);
  const calls = [];
  const result = await uninstallManagedInstallation(
    { installRoot: context.installRoot },
    dependencies(context, {
      async runServiceUninstall(spec) {
        calls.push(spec);
        await lstat(context.releaseRoot);
        assert.equal((JSON.parse(await readFile(path.join(context.installRoot, 'manifest.json')))).serviceInstalled, true);
      },
    }),
  );

  assert.equal(result.removed, true);
  assert.equal(result.version, VERSION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].releaseRoot, context.releaseRoot);
  assert.equal(calls[0].configFile, context.configFile);
  assert.equal(calls[0].dataDir, context.dataDir);
  assert.deepEqual(calls[0].serviceEnvironment, context.manifest.serviceEnvironment);
  await assert.rejects(lstat(context.installRoot), { code: 'ENOENT' });
  assert.equal(await readFile(context.configFile, 'utf8'), 'BOT_TOKEN=test-only\n');
  assert.equal(await readFile(path.join(context.dataDir, 'keep.txt'), 'utf8'), 'runtime data\n');
  assert.equal(await readFile(path.join(context.workspaceDir, 'keep.txt'), 'utf8'), 'workspace data\n');
});

test('service removal failure preserves the managed installation', async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    uninstallManagedInstallation(
      { installRoot: context.installRoot },
      dependencies(context, {
        async runServiceUninstall() {
          throw new Error('service manager unavailable');
        },
      }),
    ),
    /managed files were preserved: service manager unavailable/u,
  );
  assert.equal((JSON.parse(await readFile(path.join(context.installRoot, 'manifest.json')))).serviceInstalled, true);
  await lstat(context.releaseRoot);
  await lstat(context.launcherPath);
});

test('a stale installer PID lock is recovered and repeated uninstall is idempotent', async (t) => {
  const context = await fixture(t, { serviceInstalled: false });
  await privateFile(path.join(context.installRoot, '.install.lock'), `${JSON.stringify({
    schemaVersion: 1,
    owner: OWNER,
    pid: 2_147_000_000,
    hostname: os.hostname(),
    token: randomUUID(),
    createdAt: NOW,
  })}\n`);
  const deps = dependencies(context);
  const first = await uninstallManagedInstallation({ installRoot: context.installRoot }, deps);
  const second = await uninstallManagedInstallation({ installRoot: context.installRoot }, deps);
  assert.equal(first.removed, true);
  assert.equal(second.removed, false);
});

test('service-absence receipt makes crash cleanup resumable without executing missing code', async (t) => {
  const context = await fixture(t, { serviceInstalled: true });
  await privateFile(path.join(context.installRoot, '.agygram-uninstall.json'), `${JSON.stringify({
    schemaVersion: 1,
    owner: OWNER,
    repository: REPOSITORY,
    version: VERSION,
    commit: COMMIT,
    currentRelease: RELEASE,
    serviceAbsent: true,
    createdAt: NOW,
  })}\n`);
  await Promise.all([
    rm(path.join(context.installRoot, 'bin'), { recursive: true, force: true }),
    rm(path.join(context.installRoot, 'releases'), { recursive: true, force: true }),
    rm(path.join(context.installRoot, 'current'), { force: true }),
  ]);
  const result = await uninstallManagedInstallation(
    { installRoot: context.installRoot },
    dependencies(context, {
      async runServiceUninstall() {
        assert.fail('a durable service-absence receipt must prevent code execution');
      },
    }),
  );
  assert.equal(result.removed, true);
  await assert.rejects(lstat(context.installRoot), { code: 'ENOENT' });
});

test('explicit root ignores changed XDG defaults and missing external state does not block removal', async (t) => {
  const context = await fixture(t, { serviceInstalled: false });
  await Promise.all([
    rm(context.configFile, { force: true }),
    rm(context.dataDir, { recursive: true, force: true }),
    rm(context.workspaceDir, { recursive: true, force: true }),
  ]);
  const result = await uninstallManagedInstallation(
    { installRoot: context.installRoot },
    dependencies(context, {
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      env: {
        HOME: context.homeDir,
        XDG_DATA_HOME: 'relative-data-is-ignored-for-explicit-root',
        XDG_CONFIG_HOME: 'relative-config-is-ignored-for-explicit-root',
      },
    }),
  );
  assert.equal(result.removed, true);
  await assert.rejects(lstat(context.installRoot), { code: 'ENOENT' });
});

test('modified launcher receipt is refused before service mutation', async (t) => {
  const context = await fixture(t);
  await privateFile(context.launcherPath, 'modified\n', 0o700);
  let serviceCalls = 0;
  await assert.rejects(
    uninstallManagedInstallation(
      { installRoot: context.installRoot },
      dependencies(context, {
        async runServiceUninstall() { serviceCalls += 1; },
      }),
    ),
    /launcher was modified/u,
  );
  assert.equal(serviceCalls, 0);
  await lstat(context.releaseRoot);
});

test('interrupted state-written transaction is made service-absent and fully removed', async (t) => {
  const context = await fixture(t, { serviceInstalled: false });
  await privateFile(path.join(context.installRoot, 'transaction.json'), `${JSON.stringify({
    schemaVersion: 1,
    owner: OWNER,
    repository: REPOSITORY,
    phase: 'state-written',
    previousManifest: null,
    targetManifest: context.manifest,
    previousServiceActive: false,
    configRollback: {
      path: context.configFile,
      existed: true,
      beforeBase64: Buffer.from('BOT_TOKEN=test-only\n').toString('base64'),
      afterSha256: digest('BOT_TOKEN=test-only\n'),
    },
    createdAt: NOW,
    updatedAt: NOW,
  })}\n`);
  const calls = [];
  const result = await uninstallManagedInstallation(
    { installRoot: context.installRoot },
    dependencies(context, {
      async runServiceUninstall(spec) { calls.push(spec); },
    }),
  );
  assert.equal(result.removed, true);
  assert.equal(result.recoveredTransaction, true);
  assert.equal(calls.length, 1, 'target service is checked across the state-written crash window');
  assert.equal(calls[0].releaseRoot, context.releaseRoot);
  await assert.rejects(lstat(context.installRoot), { code: 'ENOENT' });
  await lstat(context.dataDir);
  await lstat(context.workspaceDir);
});

test('unmanaged roots and install-root symlinks are refused', { skip: process.platform === 'win32' }, async (t) => {
  const context = await fixture(t, { serviceInstalled: false });
  await rm(path.join(context.installRoot, 'manifest.json'));
  await privateFile(path.join(context.installRoot, 'unrelated.txt'), 'keep\n');
  await assert.rejects(
    uninstallManagedInstallation({ installRoot: context.installRoot }, dependencies(context)),
    /unmanaged directory/u,
  );
  assert.equal(await readFile(path.join(context.installRoot, 'unrelated.txt'), 'utf8'), 'keep\n');

  const target = path.join(context.base, 'symlink-target');
  const link = path.join(context.base, 'symlink-root');
  await privateDirectory(target);
  await symlink(target, link, 'dir');
  await assert.rejects(
    uninstallManagedInstallation({ installRoot: link }, dependencies(context)),
    /not a regular directory/u,
  );
  await lstat(target);
});

test('marker-only crash recovery requires an exact root ownership receipt', async (t) => {
  const context = await fixture(t, { serviceInstalled: false });
  await Promise.all([
    rm(path.join(context.installRoot, 'bin'), { recursive: true, force: true }),
    rm(path.join(context.installRoot, 'releases'), { recursive: true, force: true }),
    rm(path.join(context.installRoot, 'current'), { force: true }),
    rm(path.join(context.installRoot, 'manifest.json'), { force: true }),
  ]);
  const recovered = await uninstallManagedInstallation(
    { installRoot: context.installRoot },
    dependencies(context),
  );
  assert.equal(recovered.removed, false);
  await assert.rejects(lstat(context.installRoot), { code: 'ENOENT' });

  const unmarked = path.join(context.base, 'empty-unmarked');
  await privateDirectory(unmarked);
  await assert.rejects(
    uninstallManagedInstallation({ installRoot: unmarked }, dependencies(context)),
    /managed manifest is missing/u,
  );
  await lstat(unmarked);
});

test('a detached final-cleanup root converges without touching sibling state', async (t) => {
  const context = await fixture(t, { serviceInstalled: false });
  await Promise.all([
    rm(path.join(context.installRoot, 'bin'), { recursive: true, force: true }),
    rm(path.join(context.installRoot, 'releases'), { recursive: true, force: true }),
    rm(path.join(context.installRoot, 'current'), { force: true }),
    rm(path.join(context.installRoot, 'manifest.json'), { force: true }),
  ]);
  await privateFile(path.join(context.installRoot, '.install.lock'), `${JSON.stringify({
    schemaVersion: 1,
    owner: OWNER,
    pid: 2_147_000_000,
    hostname: os.hostname(),
    token: randomUUID(),
    createdAt: NOW,
  })}\n`);
  const detached = path.join(
    path.dirname(context.installRoot),
    `.${path.basename(context.installRoot)}.agygram-uninstalling`,
  );
  await rename(context.installRoot, detached);
  const result = await uninstallManagedInstallation(
    { installRoot: context.installRoot },
    dependencies(context),
  );
  assert.equal(result.removed, false);
  await assert.rejects(lstat(detached), { code: 'ENOENT' });
  await lstat(context.dataDir);
  await lstat(context.workspaceDir);
});
