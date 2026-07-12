import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _private, acquireInstanceLock, InstanceLockError } from '../src/instance-lock.js';

async function withTempDir(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-instance-lock-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('acquires a private lock, rejects a live owner, and releases idempotently', async () => {
  await withTempDir(async (root) => {
    const lockPath = path.join(root, 'bot.lock');
    const lock = await acquireInstanceLock(lockPath);

    const payload = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(payload.pid, process.pid);
    assert.equal(payload.token, lock.token);
    if (process.platform !== 'win32') {
      assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
    }

    await assert.rejects(
      acquireInstanceLock(lockPath),
      (error) =>
        error instanceof InstanceLockError &&
        error.code === 'INSTANCE_ALREADY_RUNNING' &&
        error.ownerPid === process.pid,
    );

    assert.equal(await lock.release(), true);
    assert.equal(await lock.release(), false);
    await assert.rejects(stat(lockPath), { code: 'ENOENT' });
  });
});

test('reclaims one stale PID lock', async () => {
  await withTempDir(async (root) => {
    const lockPath = path.join(root, 'bot.lock');
    await writeFile(
      lockPath,
      JSON.stringify({ version: 1, pid: 987654, token: 'stale-owner-token', createdAt: new Date().toISOString() }),
    );

    const lock = await acquireInstanceLock(lockPath, { processAlive: () => false });
    const payload = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(payload.pid, process.pid);
    assert.equal(payload.token, lock.token);
    assert.notEqual(payload.token, 'stale-owner-token');
    await lock.release();
  });
});

test('reclaims a malformed abandoned lock after the configured grace period', async () => {
  await withTempDir(async (root) => {
    const lockPath = path.join(root, 'bot.lock');
    await writeFile(lockPath, '{partial');

    const lock = await acquireInstanceLock(lockPath, { malformedGraceMs: 0 });
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, lock.token);
    await lock.release();
  });
});

test('release never removes a lock whose ownership token changed', async () => {
  await withTempDir(async (root) => {
    const lockPath = path.join(root, 'bot.lock');
    const lock = await acquireInstanceLock(lockPath);
    const replacement = {
      version: 1,
      pid: process.pid,
      token: 'replacement-owner-token',
      createdAt: new Date().toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(replacement));

    assert.equal(await lock.release(), false);
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), replacement);
    await unlink(lockPath);
  });
});

test('stale recovery preserves a lock changed during the PID check', async () => {
  await withTempDir(async (root) => {
    const lockPath = path.join(root, 'bot.lock');
    await writeFile(
      lockPath,
      JSON.stringify({ version: 1, pid: 111111, token: 'observed-owner-token', createdAt: new Date().toISOString() }),
    );
    const replacement = {
      version: 1,
      pid: 222222,
      token: 'replacement-owner-token',
      createdAt: new Date().toISOString(),
    };

    await assert.rejects(
      acquireInstanceLock(lockPath, {
        processAlive: async () => {
          await writeFile(lockPath, JSON.stringify(replacement));
          return false;
        },
      }),
      (error) => error instanceof InstanceLockError && error.code === 'INSTANCE_LOCK_RACE',
    );
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), replacement);
  });
});

test('PID probes treat EPERM as alive and ESRCH as dead', () => {
  const failWith = (code) => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };

  assert.equal(_private.isProcessAlive(123, () => failWith('EPERM')), true);
  assert.equal(_private.isProcessAlive(123, () => failWith('ESRCH')), false);
  assert.equal(_private.isProcessAlive(123, () => failWith('UNKNOWN_PLATFORM_ERROR')), true);
});
