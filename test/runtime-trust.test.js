import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertManagedStorageBoundary,
  assertRuntimeFilesystemTrust,
} from '../src/runtime-trust.js';

test('POSIX runtime trust rejects broad secret/data permissions and symlinks', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-runtime-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envFile = path.join(root, '.env');
  const dataDir = path.join(root, 'data');
  await writeFile(envFile, 'BOT_TOKEN=test', { mode: 0o600 });
  await mkdir(dataDir, { mode: 0o700 });
  await assertRuntimeFilesystemTrust({ envFile, dataDirectories: [dataDir] });

  await chmod(envFile, 0o644);
  await assert.rejects(
    assertRuntimeFilesystemTrust({ envFile, dataDirectories: [dataDir] }),
    /deny group\/other access/,
  );
  await chmod(envFile, 0o600);
  const link = path.join(root, 'linked-data');
  await symlink(dataDir, link, 'dir');
  await assert.rejects(
    assertRuntimeFilesystemTrust({ envFile, dataDirectories: [link] }),
    /must not be a symlink/,
  );
});

test('Windows runtime trust requires explicit ACL attestation', async () => {
  await assert.rejects(
    assertRuntimeFilesystemTrust({ platform: 'win32', windowsAclVerified: false }),
    /ACL verification is required/,
  );
  await assertRuntimeFilesystemTrust({ platform: 'win32', windowsAclVerified: true });
});

test('managed storage cannot follow an internal symlink outside DATA_DIR', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-storage-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const outside = path.join(root, 'outside');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, path.join(dataDir, 'redirect'), 'dir');

  await assert.rejects(
    assertManagedStorageBoundary({
      dataDir,
      files: [path.join(dataDir, 'redirect', 'sessions.json')],
      directories: [dataDir],
    }),
    /escapes DATA_DIR/,
  );
  await assert.rejects(
    assertManagedStorageBoundary({
      dataDir,
      directories: [path.join(dataDir, 'redirect')],
    }),
    /must be a real directory/,
  );
});

test('POSIX runtime trust rejects attacker-writable ancestors', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-runtime-parent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unsafeParent = path.join(root, 'shared');
  const dataDir = path.join(unsafeParent, 'data');
  await mkdir(unsafeParent, { mode: 0o700 });
  await mkdir(dataDir, { mode: 0o700 });
  await chmod(unsafeParent, 0o777);

  await assert.rejects(
    assertRuntimeFilesystemTrust({
      envFile: path.join(root, '.missing-env'),
      dataDirectories: [dataDir],
    }),
    /ancestor is writable by another principal/,
  );
});
