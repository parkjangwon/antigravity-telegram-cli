import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runWithUsage, UsageLimitError, UsageStore, _private } from '../src/usage-store.js';

async function fixture({ now = Date.parse('2026-07-12T12:00:00.000Z'), ...options } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-usage-store-'));
  const file = path.join(directory, 'data', 'usage.json');
  const clockState = { now };
  const store = new UsageStore(file, {
    windowMs: 60 * 60 * 1_000,
    maxJobsPerUser: 2,
    maxJobsGlobal: 3,
    dailyRuntimeMsPerUser: 10_000,
    dailyRuntimeMsGlobal: 20_000,
    reservationMs: 1_000,
    retentionDays: 8,
    clock: () => clockState.now,
    ...options,
  });
  await store.init();
  return {
    directory,
    file,
    store,
    clockState,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('init creates a private versioned usage store', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);

  assert.deepEqual(JSON.parse(await readFile(context.file, 'utf8')), {
    version: _private.SCHEMA_VERSION,
    runs: [],
    daily: [],
  });
  if (process.platform !== 'win32') {
    assert.equal((await stat(context.file)).mode & 0o777, 0o600);
  }
});

test('rolling per-user and global job limits are durable and expire by time', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);

  await context.store.reserve({ id: 'job-1', userId: '100' });
  await context.store.finish('job-1', { durationMs: 10, outcome: 'succeeded' });
  await context.store.reserve({ id: 'job-2', userId: '100' });
  await assert.rejects(
    context.store.reserve({ id: 'job-user-blocked', userId: '100' }),
    (error) => error instanceof UsageLimitError && error.code === 'USAGE_USER_JOB_LIMIT',
  );

  await context.store.reserve({ id: 'job-3', userId: '200' });
  await assert.rejects(
    context.store.reserve({ id: 'job-global-blocked', userId: '300' }),
    (error) => error instanceof UsageLimitError && error.code === 'USAGE_GLOBAL_JOB_LIMIT',
  );

  context.clockState.now += 60 * 60 * 1_000 + 1;
  const admitted = await context.store.reserve({ id: 'job-after-window', userId: '100' });
  assert.equal(admitted.userId, '100');
});

test('concurrent reservations cannot race past the durable global limit', async (t) => {
  const context = await fixture({ maxJobsPerUser: 3, maxJobsGlobal: 3 });
  t.after(context.cleanup);
  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) => context.store.reserve({
      id: `concurrent-${index}`,
      userId: String(1_000 + index),
    })),
  );
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 3);
  assert.equal(
    attempts.filter(
      (result) => result.status === 'rejected' && result.reason?.code === 'USAGE_GLOBAL_JOB_LIMIT',
    ).length,
    9,
  );
  assert.equal(context.store.snapshot().runs.length, 3);
});

test('daily budgets account actual finished runtime and active worst-case reservations', async (t) => {
  const context = await fixture({
    maxJobsPerUser: 20,
    maxJobsGlobal: 20,
    reservationMs: 100,
    dailyRuntimeMsPerUser: 250,
    dailyRuntimeMsGlobal: 350,
  });
  t.after(context.cleanup);

  await context.store.reserve({ id: 'first', userId: '100' });
  await context.store.finish('first', { durationMs: 120, outcome: 'failed' });
  await context.store.reserve({ id: 'second', userId: '100' });
  await context.store.finish('second', { durationMs: 100, outcome: 'succeeded' });
  await assert.rejects(
    context.store.reserve({ id: 'user-over-budget', userId: '100' }),
    (error) => error instanceof UsageLimitError && error.code === 'USAGE_USER_RUNTIME_LIMIT',
  );

  await context.store.reserve({ id: 'other-active', userId: '200' });
  await assert.rejects(
    context.store.reserve({ id: 'global-over-budget', userId: '300' }),
    (error) => error instanceof UsageLimitError && error.code === 'USAGE_GLOBAL_RUNTIME_LIMIT',
  );
});

test('restart conservatively charges an unfinished reservation in full', async (t) => {
  const context = await fixture({
    reservationMs: 200,
    dailyRuntimeMsPerUser: 300,
    dailyRuntimeMsGlobal: 1_000,
  });
  t.after(context.cleanup);
  await context.store.reserve({ id: 'crashed-run', userId: '100' });

  context.clockState.now += 1_000;
  const restarted = new UsageStore(context.file, {
    windowMs: 60 * 60 * 1_000,
    maxJobsPerUser: 20,
    maxJobsGlobal: 20,
    reservationMs: 200,
    dailyRuntimeMsPerUser: 300,
    dailyRuntimeMsGlobal: 1_000,
    retentionDays: 8,
    clock: () => context.clockState.now,
  });
  await restarted.init();

  const recovered = restarted.snapshot().runs.find((run) => run.id === 'crashed-run');
  assert.equal(recovered.outcome, 'interrupted');
  assert.equal(recovered.durationMs, 200);
  assert.equal(restarted.snapshot().daily[0].runtimeMs, 200);
  await assert.rejects(
    restarted.reserve({ id: 'blocked-after-crash', userId: '100' }),
    (error) => error instanceof UsageLimitError && error.code === 'USAGE_USER_RUNTIME_LIMIT',
  );
});

test('retention removes enforcement records only after their relevant periods', async (t) => {
  const context = await fixture({
    windowMs: 1_000,
    retentionDays: 2,
    maxJobsPerUser: 10,
    maxJobsGlobal: 10,
  });
  t.after(context.cleanup);
  await context.store.reserve({ id: 'old', userId: '100' });
  await context.store.finish('old', { durationMs: 50, outcome: 'cancelled' });

  context.clockState.now += 3 * _private.DAY_MS;
  await context.store.prune();
  assert.deepEqual(context.store.snapshot(), { version: 1, runs: [], daily: [] });
  assert.deepEqual(JSON.parse(await readFile(context.file, 'utf8')), context.store.snapshot());
});

test('malformed stores and identifiers fail closed', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  await assert.rejects(context.store.reserve({ id: 'x', userId: 'unknown' }), /numeric Telegram/);
  await context.store.reserve({ id: 'duplicate', userId: '100' });
  await assert.rejects(
    context.store.reserve({ id: 'duplicate', userId: '100' }),
    (error) => error instanceof UsageLimitError && error.code === 'USAGE_DUPLICATE',
  );
});

test('runWithUsage never invokes agy after reserve failure and settles every child outcome', async () => {
  let invoked = false;
  const blocked = {
    reserve: async () => {
      throw new Error('usage disk unavailable');
    },
    finish: async () => assert.fail('finish must not run without a reservation'),
  };
  await assert.rejects(
    runWithUsage(blocked, {
      id: 'blocked',
      userId: '100',
      operation: async () => { invoked = true; },
    }),
    /usage disk unavailable/,
  );
  assert.equal(invoked, false);

  const calls = [];
  const store = {
    reserve: async (value) => calls.push(['reserve', value]),
    finish: async (id, value) => calls.push(['finish', id, value]),
  };
  let time = 10;
  const result = await runWithUsage(store, {
    id: 'success',
    userId: '100',
    operation: async () => 'ok',
    monotonicClock: () => (time += 25),
  });
  assert.equal(result, 'ok');
  assert.deepEqual(calls.at(-1), ['finish', 'success', { durationMs: 25, outcome: 'succeeded' }]);

  await assert.rejects(
    runWithUsage(store, {
      id: 'failure',
      userId: '100',
      operation: async () => {
        const error = new Error('cancelled by user');
        error.code = 'AGY_CANCELLED';
        throw error;
      },
      monotonicClock: () => (time += 10),
    }),
    /cancelled by user/,
  );
  assert.deepEqual(calls.at(-1), ['finish', 'failure', { durationMs: 10, outcome: 'cancelled' }]);
});

test('runWithUsage leaves the conservative reservation authoritative when settlement fails', async () => {
  let operationRan = false;
  const store = {
    reserve: async () => {},
    finish: async () => {
      throw new Error('usage settlement failed');
    },
  };
  await assert.rejects(
    runWithUsage(store, {
      id: 'settlement-failure',
      userId: '100',
      operation: async () => {
        operationRan = true;
        return 'result that must not be delivered';
      },
      monotonicClock: () => 1,
    }),
    /usage settlement failed/,
  );
  assert.equal(operationRan, true);
});
