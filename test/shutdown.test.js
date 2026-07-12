import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ActivityClosedError, ActivityTracker } from '../src/activity.js';
import { acquireInstanceLock, InstanceLockError } from '../src/instance-lock.js';
import {
  releaseInstanceLockIfQuiescent,
  waitForLifecycleQuiescence,
} from '../src/shutdown.js';

async function lockFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-shutdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, 'bot.lock');
  return { lockPath, lock: await acquireInstanceLock(lockPath) };
}

test('ActivityTracker drains detached tails and seals new work', async () => {
  const tracker = new ActivityTracker();
  let finish;
  const pending = tracker.trackExisting(new Promise((resolve) => {
    finish = resolve;
  }));
  tracker.close();

  assert.equal(await tracker.waitForIdle(5), false);
  assert.throws(() => tracker.begin(), ActivityClosedError);
  finish();
  await pending;
  assert.equal(await tracker.waitForIdle(20), true);
});

test('instance lock stays live when a task tail or lifecycle transport is not quiescent', async (t) => {
  const { lockPath, lock } = await lockFixture(t);
  const result = await releaseInstanceLockIfQuiescent({
    instanceLock: lock,
    lifecycle: { quiescent: false },
    componentResults: [{
      name: 'background',
      component: { hasAnyActive: () => true },
      idle: false,
    }],
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.retained, true);
  assert.deepEqual(result.live, ['lifecycle', 'background']);
  await assert.rejects(
    acquireInstanceLock(lockPath),
    (error) => error instanceof InstanceLockError && error.code === 'INSTANCE_ALREADY_RUNNING',
  );
  await lock.release();
});

test('instance lock is released only after all shutdown surfaces are idle', async (t) => {
  const { lockPath, lock } = await lockFixture(t);
  const lifecycle = { quiescent: true };
  assert.equal(await waitForLifecycleQuiescence(lifecycle, 5), true);
  const result = await releaseInstanceLockIfQuiescent({
    instanceLock: lock,
    lifecycle,
    componentResults: [
      { name: 'tasks', component: { hasAnyActive: () => false }, idle: true },
      { name: 'background', component: { hasAnyActive: () => false }, idle: true },
    ],
    transportIdle: true,
    transportActive: false,
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.released, true);
  const replacement = await acquireInstanceLock(lockPath);
  await replacement.release();
});
