import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _private } from '../scripts/install.mjs';

const OWNER = 'agygram-managed-installer';
const REPOSITORY = 'parkjangwon/antigravity-telegram-cli';

test('managed installer parses setup mode as an explicit onboarding option', () => {
  const options = _private.parseOptions([
    '--version', '0.2.0',
    '--commit', 'a'.repeat(40),
    '--setup',
    '--no-service',
  ]);

  assert.equal(options.setup, true);
  assert.equal(options.noService, true);
  assert.equal(options.version, '0.2.0');
});

function manifest(root, version, commit, configFile, { previousRelease = null } = {}) {
  const currentRelease = `v${version}-${commit}`;
  const launcherDir = path.join(root, 'bin');
  return {
    schemaVersion: 1,
    owner: OWNER,
    repository: REPOSITORY,
    version,
    tag: `v${version}`,
    commit,
    currentRelease,
    previousRelease,
    configFile,
    configSha256: null,
    dataDir: path.join(root, '..', 'data'),
    workspaceDir: path.join(root, '..', 'workspace'),
    serviceEnvironment: { xdgConfigHome: null },
    serviceInstalled: false,
    launcher: {
      directory: launcherDir,
      files: [
        { path: path.join(launcherDir, 'agygram.mjs'), kind: 'file', sha256: '1'.repeat(64) },
        {
          path: path.join(launcherDir, process.platform === 'win32' ? 'agygram.cmd' : 'agygram'),
          kind: 'file',
          sha256: '2'.repeat(64),
        },
      ],
    },
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('state-written journal converges to previous config and pointer', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agygram-installer-recovery-'));
  const root = path.join(base, 'manager');
  const configFile = path.join(base, '.env');
  await mkdir(path.join(root, 'bin'), { recursive: true });
  try {
    const before = 'BOT_TOKEN=before\n';
    const after = 'BOT_TOKEN=after\n';
    await writeFile(configFile, after, { mode: 0o600 });
    const previous = manifest(root, '0.1.0', 'a'.repeat(40), configFile);
    const target = manifest(root, '0.2.0', 'b'.repeat(40), configFile, {
      previousRelease: previous.currentRelease,
    });
    await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(target)}\n`);
    await writeFile(path.join(root, 'current'), `${target.currentRelease}\n`);
    await writeFile(path.join(root, 'transaction.json'), `${JSON.stringify({
      schemaVersion: 1,
      owner: OWNER,
      repository: REPOSITORY,
      phase: 'state-written',
      previousManifest: previous,
      targetManifest: target,
      previousServiceActive: false,
      configRollback: {
        path: configFile,
        existed: true,
        beforeBase64: Buffer.from(before).toString('base64'),
        afterSha256: createHash('sha256').update(after).digest('hex'),
      },
      launcherApply: [
        {
          path: path.join(root, 'bin', 'agygram.mjs'),
          mode: 0o700,
          bodyBase64: Buffer.from('#!/usr/bin/env node\n').toString('base64'),
        },
        {
          path: path.join(root, 'bin', process.platform === 'win32' ? 'agygram.cmd' : 'agygram'),
          mode: 0o700,
          bodyBase64: Buffer.from(process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n').toString('base64'),
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })}\n`);

    const calls = [];
    await _private.recoverInterruptedTransaction(root, {
      invoke: async (release, action) => {
        calls.push({ release, action });
        return true;
      },
    });

    assert.equal(await readFile(configFile, 'utf8'), before);
    assert.equal((await readFile(path.join(root, 'current'), 'utf8')).trim(), previous.currentRelease);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')), previous);
    await assert.rejects(readFile(path.join(root, 'transaction.json')), { code: 'ENOENT' });
    assert.deepEqual(calls.map(({ action }) => action), ['uninstall']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
