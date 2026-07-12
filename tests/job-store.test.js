import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JobStore, _private } from '../src/job-store.js';

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-job-store-'));
  const file = path.join(directory, 'data', 'jobs.json');
  const store = new JobStore(file, options);
  await store.init();
  return {
    directory,
    file,
    store,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('init creates a private versioned journal', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);

  const persisted = JSON.parse(await readFile(context.file, 'utf8'));
  assert.deepEqual(persisted, {
    version: _private.SCHEMA_VERSION,
    jobs: [],
    updateTombstones: [],
  });
  if (process.platform !== 'win32') {
    assert.equal((await stat(context.file)).mode & 0o777, 0o600);
  }
});

test('enqueue is idempotent by normalized Telegram update ID and sanitizes payloads', async (t) => {
  const botToken = '123456:very-secret-telegram-token';
  const context = await fixture({ secrets: [botToken] });
  t.after(context.cleanup);

  const cyclic = { prompt: `please hide ${botToken}`, botToken, nested: { password: 'bad' } };
  cyclic.self = cyclic;
  cyclic.big = 42n;
  cyclic.invalid = undefined;

  const first = await context.store.enqueue({
    updateId: 101,
    sessionKey: '123456789:9',
    kind: 'prompt',
    payload: cyclic,
    metadata: {
      audit: {
        actorUserId: '123456789',
        telegramMessageId: '55',
        prompt: `must not copy ${botToken}`,
      },
    },
  });
  const duplicate = await context.store.enqueue({
    updateId: '101',
    sessionKey: 'other-session',
    kind: 'other',
    payload: { ignored: true },
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(first.payload.prompt, 'please hide [REDACTED]');
  assert.equal(first.payload.botToken, '[REDACTED]');
  assert.equal(first.payload.nested.password, '[REDACTED]');
  assert.equal(first.payload.self, '[Circular]');
  assert.equal(first.payload.big, '42');
  assert.equal(Object.hasOwn(first.payload, 'invalid'), false);
  assert.equal(first.metadata.audit.actorUserId, '123456789');
  assert.equal(first.metadata.audit.telegramMessageId, '55');
  assert.equal(Object.hasOwn(first.metadata.audit, 'prompt'), false);
  assert.equal(context.store.listForSession('123456789:9').length, 1);

  const raw = await readFile(context.file, 'utf8');
  assert.equal(raw.includes(botToken), false);
});

test('serialized concurrent enqueues cannot duplicate an update ID', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);

  const jobs = await Promise.all(
    Array.from({ length: 20 }, () => context.store.enqueue({
      updateId: 202,
      sessionKey: 'chat',
      kind: 'prompt',
      payload: {},
    })),
  );

  assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
  assert.equal(context.store.listForSession('chat').length, 1);
});

test('transition enforces lifecycle and stores a bounded response for /last', async (t) => {
  const context = await fixture({ maxResponseChars: 5 });
  t.after(context.cleanup);
  const queued = await context.store.enqueue({ updateId: 1, sessionKey: 'chat', kind: 'plan' });

  const running = await context.store.transition(queued.id, 'running', {
    metadata: { phase: 'agy', authorization: 'must-not-persist' },
  });
  assert.equal(running.status, 'running');
  assert.ok(running.startedAt);
  assert.equal(running.metadata.phase, 'agy');
  assert.equal(running.metadata.authorization, '[REDACTED]');

  const succeeded = await context.store.transition(queued.id, 'succeeded', {
    result: { conversationId: 'conversation-id' },
    responseText: 'abcd😀tail',
    delivered: false,
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.ok(succeeded.finishedAt);
  assert.equal(succeeded.result.responseText, 'abcd');
  assert.equal(succeeded.result.responseTruncated, true);
  assert.equal(succeeded.result.responseOriginalChars, 10);

  // A same-state patch is intentionally legal so delivery can be acknowledged later.
  await context.store.transition(queued.id, 'succeeded', { delivered: true });
  assert.deepEqual(context.store.getLatestResponse('chat'), {
    jobId: queued.id,
    responseText: 'abcd',
    truncated: true,
    delivered: true,
    finishedAt: succeeded.finishedAt,
  });
  await assert.rejects(
    context.store.transition(queued.id, 'running'),
    /Illegal job transition: succeeded -> running/,
  );
});

test('failed and cancelled jobs retain only sanitized errors', async (t) => {
  const secret = 'secret-value-that-must-not-leak';
  const context = await fixture({ secrets: [secret] });
  t.after(context.cleanup);
  const job = await context.store.enqueue({ updateId: 3, sessionKey: 'chat', kind: 'prompt' });
  await context.store.transition(job.id, 'running');
  const failed = await context.store.transition(job.id, 'failed', {
    error: Object.assign(new Error(`agy failed with ${secret}`), { code: 'EAGY' }),
  });

  assert.deepEqual(failed.error, {
    name: 'Error',
    message: 'agy failed with [REDACTED]',
    code: 'EAGY',
  });
  assert.equal(JSON.stringify(failed).includes(secret), false);
  assert.equal(Object.hasOwn(failed.error, 'stack'), false);
});

test('init atomically marks prior queued and running jobs as interrupted', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const queued = await context.store.enqueue({ updateId: 10, sessionKey: 'chat', kind: 'prompt' });
  const running = await context.store.enqueue({ updateId: 11, sessionKey: 'chat', kind: 'prompt' });
  await context.store.transition(running.id, 'running');

  const restarted = new JobStore(context.file);
  await restarted.init();

  for (const id of [queued.id, running.id]) {
    const recovered = restarted.get(id);
    assert.equal(recovered.status, 'interrupted');
    assert.ok(recovered.finishedAt);
    assert.equal(recovered.error.name, 'InterruptedError');
  }
  const persisted = JSON.parse(await readFile(context.file, 'utf8'));
  assert.deepEqual(persisted.jobs.map((job) => job.status), ['interrupted', 'interrupted']);
});

test('init pins active overflow until recovery finishes, then re-prunes with a tombstone', async (t) => {
  const context = await fixture({ maxJobs: 10 });
  t.after(context.cleanup);

  for (let index = 0; index < 11; index += 1) {
    const job = await context.store.enqueue({
      updateId: `recovery-${index}`,
      sessionKey: 'chat',
      kind: 'prompt',
    });
    await context.store.transition(job.id, 'running');
  }

  const restarted = new JobStore(context.file, { maxJobs: 10 });
  await restarted.init();

  const pinned = JSON.parse(await readFile(context.file, 'utf8'));
  assert.equal(pinned.jobs.length, 11);
  assert.equal(pinned.jobs.every((job) => job.status === 'interrupted'), true);
  assert.equal(restarted.restartRecoveryCandidates().length, 11);

  await restarted.releaseRestartRecoveryPins();
  const persisted = JSON.parse(await readFile(context.file, 'utf8'));
  assert.equal(persisted.jobs.length, 10);
  assert.equal(persisted.jobs.every((job) => job.status === 'interrupted'), true);
  assert.equal(persisted.updateTombstones.length, 1);
});

test('enqueueRetry creates a linked attempt and is itself update-idempotent', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);
  const original = await context.store.enqueue({
    updateId: 20,
    sessionKey: 'chat',
    kind: 'apply',
    payload: { prompt: 'try this' },
  });
  await context.store.transition(original.id, 'cancelled', { error: 'stop' });

  const retried = await context.store.enqueueRetry(original.id, 21);
  const duplicate = await context.store.enqueueRetry(original.id, '21', { prompt: 'ignored' });
  assert.equal(duplicate.id, retried.id);
  assert.equal(retried.retryOf, original.id);
  assert.equal(retried.attempt, 2);
  assert.deepEqual(retried.payload, { prompt: 'try this' });
  assert.equal(retried.status, 'queued');

  const auditedRetry = await context.store.enqueueRetry(original.id, 22, undefined, {
    audit: { actorUserId: '200', telegramMessageId: '99' },
  });
  assert.deepEqual(auditedRetry.metadata.audit, {
    actorUserId: '200',
    telegramMessageId: '99',
  });
});

test('maxJobs prunes oldest terminal history but never active work', async (t) => {
  const context = await fixture({ maxJobs: 2 });
  t.after(context.cleanup);

  const first = await context.store.enqueue({ updateId: 30, sessionKey: 'chat', kind: 'prompt' });
  await context.store.transition(first.id, 'running');
  await context.store.transition(first.id, 'succeeded', { responseText: 'first' });
  const second = await context.store.enqueue({ updateId: 31, sessionKey: 'chat', kind: 'prompt' });
  await context.store.transition(second.id, 'running');
  await context.store.transition(second.id, 'succeeded', { responseText: 'second' });
  const third = await context.store.enqueue({ updateId: 32, sessionKey: 'chat', kind: 'prompt' });

  assert.equal(context.store.get(first.id), null);
  assert.deepEqual(context.store.listForSession('chat').map((job) => job.id), [third.id, second.id]);

  // With only active jobs, exceeding the history limit is safer than dropping work.
  const activeOnly = await fixture({ maxJobs: 1 });
  t.after(activeOnly.cleanup);
  await activeOnly.store.enqueue({ updateId: 40, sessionKey: 'chat', kind: 'prompt' });
  await activeOnly.store.enqueue({ updateId: 41, sessionKey: 'chat', kind: 'prompt' });
  assert.equal(activeOnly.store.listForSession('chat', { limit: 10 }).length, 2);
  const raw = JSON.parse(await readFile(activeOnly.file, 'utf8'));
  assert.equal(raw.jobs.length, 2);
});

test('a pruned update remains deduplicated across enqueue and restart', async (t) => {
  const context = await fixture({ maxJobs: 1 });
  t.after(context.cleanup);

  const first = await context.store.enqueue({
    updateId: 'replay-after-prune',
    sessionKey: 'chat',
    kind: 'prompt',
  });
  await context.store.transition(first.id, 'running');
  await context.store.transition(first.id, 'succeeded', { delivered: true });
  const second = await context.store.enqueue({
    updateId: 'next-update',
    sessionKey: 'chat',
    kind: 'prompt',
  });

  assert.equal(context.store.get(first.id), null);
  const tombstone = context.store.getByUpdateId('replay-after-prune');
  assert.equal(tombstone.tombstone, true);
  assert.equal(tombstone.status, 'deduplicated');

  const replay = await context.store.enqueue({
    updateId: 'replay-after-prune',
    sessionKey: 'chat',
    kind: 'prompt',
  });
  assert.equal(replay.tombstone, true);
  assert.deepEqual(
    context.store.listForSession('chat', { limit: 10 }).map((job) => job.id),
    [second.id],
  );

  const restarted = new JobStore(context.file, { maxJobs: 1 });
  await restarted.init();
  assert.equal(restarted.getByUpdateId('replay-after-prune')?.tombstone, true);
});

test('a pre-enqueue rejection is durable and cannot execute after restart', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);

  const rejected = await context.store.markUpdateSeen('admission-rejected', {
    decision: 'rejected',
  });
  assert.equal(rejected.tombstone, true);
  assert.equal(rejected.decision, 'rejected');

  const replay = await context.store.enqueue({
    updateId: 'admission-rejected',
    sessionKey: 'chat',
    kind: 'apply',
  });
  assert.equal(replay.tombstone, true);
  assert.equal(context.store.listForSession('chat').length, 0);

  const restarted = new JobStore(context.file);
  await restarted.init();
  const afterRestart = await restarted.enqueue({
    updateId: 'admission-rejected',
    sessionKey: 'chat',
    kind: 'apply',
  });
  assert.equal(afterRestart.tombstone, true);
  assert.equal(restarted.listForSession('chat').length, 0);
});

test('ten thousand consecutive rejected update IDs compact into one durable range', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-job-range-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'jobs.json');
  const firstUpdateId = 500_000;
  const updateTombstones = Array.from({ length: 10_000 }, (_, index) => ({
    updateId: String(firstUpdateId + index),
    prunedAt: new Date().toISOString(),
    decision: 'rejected',
  }));
  await writeFile(file, JSON.stringify({ version: 2, jobs: [], updateTombstones }));

  const store = new JobStore(file, { maxUpdateTombstones: 2 });
  await store.init();

  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(persisted.updateTombstones.map((entry) => ({
    firstUpdateId: entry.firstUpdateId,
    lastUpdateId: entry.lastUpdateId,
    decision: entry.decision,
  })), [{
    firstUpdateId: '500000',
    lastUpdateId: '509999',
    decision: 'rejected',
  }]);
  assert.equal(store.getByUpdateId(500_000)?.tombstone, true);
  assert.equal(store.getByUpdateId(505_000)?.tombstone, true);
  assert.equal(store.getByUpdateId(509_999)?.tombstone, true);
  assert.equal(store.getByUpdateId(510_000), null);
  assert.ok((await stat(file)).size < 1_000);
});

test('rejected ranges preserve an accepted ID gap and sparse IDs remain bounded', async (t) => {
  const context = await fixture({ maxUpdateTombstones: 2 });
  t.after(context.cleanup);
  const accepted = await context.store.enqueue({
    updateId: 700_001,
    sessionKey: 'chat',
    kind: 'prompt',
  });

  await context.store.markUpdateSeen(700_000, { decision: 'rejected' });
  await context.store.markUpdateSeen(700_002, { decision: 'rejected' });
  await context.store.markUpdateSeen(700_003, { decision: 'rejected' });

  assert.equal(context.store.getByUpdateId(700_000)?.tombstone, true);
  assert.equal(context.store.getByUpdateId(700_001)?.id, accepted.id);
  assert.equal(context.store.getByUpdateId(700_001)?.tombstone, undefined);
  assert.equal(context.store.getByUpdateId(700_002)?.tombstone, true);
  assert.equal(context.store.getByUpdateId(700_003)?.tombstone, true);

  const persisted = JSON.parse(await readFile(context.file, 'utf8'));
  assert.deepEqual(
    persisted.updateTombstones.map((entry) => [entry.firstUpdateId, entry.lastUpdateId]),
    [['700000', '700000'], ['700002', '700003']],
  );
  await assert.rejects(
    context.store.markUpdateSeen(700_005, { decision: 'rejected' }),
    (error) => error.code === 'JOB_UPDATE_LEDGER_FULL',
  );
  assert.equal(context.store.getByUpdateId(700_005), null);
});

test('a slow lower update survives a higher rejection and process restart', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);

  // Update 800100 has begun slow pre-enqueue preparation but has not made a
  // durable claim. A parallel Telegraf batch handler rejects update 800101.
  await context.store.markUpdateSeen(800_101, { decision: 'rejected' });
  assert.equal(context.store.getByUpdateId(800_100), null);
  assert.equal(context.store.getByUpdateId(800_101)?.tombstone, true);

  // The process crashes before 800100 enqueues. Telegram redelivery after
  // restart must still be allowed because exact intervals never infer gaps.
  const restarted = new JobStore(context.file);
  await restarted.init();
  const lower = await restarted.enqueue({
    updateId: 800_100,
    sessionKey: 'chat',
    kind: 'prompt',
  });
  assert.ok(lower.id);
  assert.equal(lower.tombstone, undefined);
  assert.equal(restarted.getByUpdateId(800_100)?.id, lower.id);
  assert.equal(restarted.getByUpdateId(800_101)?.decision, 'rejected');
});

test('fresh tombstone capacity fails closed instead of reopening an update ID', async (t) => {
  const context = await fixture({ maxJobs: 1, maxUpdateTombstones: 1 });
  t.after(context.cleanup);

  const first = await context.store.enqueue({ updateId: 'cap-1', sessionKey: 'chat' });
  await context.store.transition(first.id, 'running');
  await context.store.transition(first.id, 'succeeded', { delivered: true });
  const second = await context.store.enqueue({ updateId: 'cap-2', sessionKey: 'chat' });
  await context.store.transition(second.id, 'running');
  await context.store.transition(second.id, 'succeeded', { delivered: true });

  await assert.rejects(
    context.store.enqueue({ updateId: 'cap-3', sessionKey: 'chat' }),
    (error) => error.code === 'JOB_UPDATE_LEDGER_FULL',
  );
  assert.equal(context.store.getByUpdateId('cap-1')?.tombstone, true);
  assert.equal(context.store.getByUpdateId('cap-3'), null);
});

test('expired tombstones are reclaimed and permit a genuinely old update ID', async (t) => {
  const context = await fixture({ maxJobs: 1 });
  t.after(context.cleanup);

  const first = await context.store.enqueue({ updateId: 'expired-id', sessionKey: 'chat' });
  await context.store.transition(first.id, 'running');
  await context.store.transition(first.id, 'succeeded', { delivered: true });
  await context.store.enqueue({ updateId: 'newer-id', sessionKey: 'chat' });

  const persisted = JSON.parse(await readFile(context.file, 'utf8'));
  persisted.updateTombstones[0].prunedAt = '2000-01-01T00:00:00.000Z';
  await writeFile(context.file, `${JSON.stringify(persisted, null, 2)}\n`);

  const restarted = new JobStore(context.file, {
    maxJobs: 1,
    updateTombstoneRetentionMs: 1_000,
  });
  await restarted.init();
  assert.equal(restarted.getByUpdateId('expired-id'), null);
  const accepted = await restarted.enqueue({ updateId: 'expired-id', sessionKey: 'chat' });
  assert.equal(accepted.tombstone, undefined);
  assert.ok(accepted.id);
});

test('a leased completion survives another concurrent completion until delivery finishes', async (t) => {
  const context = await fixture({ maxJobs: 10 });
  t.after(context.cleanup);

  const jobs = [];
  for (let index = 0; index < 11; index += 1) {
    const job = await context.store.enqueue({
      updateId: `active-${index}`,
      sessionKey: 'chat',
      kind: 'prompt',
    });
    await context.store.transition(job.id, 'running');
    jobs.push(job);
  }

  const release = context.store.acquireLease(jobs[0].id);
  const completed = await context.store.transition(jobs[0].id, 'succeeded', {
    responseText: 'done',
    delivered: false,
  });
  assert.equal(context.store.get(completed.id)?.status, 'succeeded');

  // Without an operation-lifetime lease, completing B would prune terminal A
  // because the 10-record history is already occupied by 11 active jobs.
  await context.store.transition(jobs[1].id, 'succeeded', {
    responseText: 'other',
    delivered: false,
  });
  assert.equal(context.store.get(completed.id)?.status, 'succeeded');

  const delivered = await context.store.transition(completed.id, 'succeeded', { delivered: true });
  assert.equal(delivered.result.delivered, true);
  assert.equal(context.store.get(completed.id)?.result.delivered, true);

  // Releasing the operation lease makes the completed record eligible again;
  // abandoned undelivered records are therefore not pinned forever.
  await release();
  await context.store.enqueue({
    updateId: 'post-release',
    sessionKey: 'chat',
    kind: 'prompt',
  });
  assert.equal(context.store.get(completed.id), null);

  const persisted = JSON.parse(await readFile(context.file, 'utf8'));
  assert.equal(persisted.jobs.some((job) => job.id === completed.id), false);
  assert.equal(persisted.jobs.length, 10);
});

test('maxBytes bounds terminal response history independently of job count', async (t) => {
  const context = await fixture({ maxJobs: 20, maxBytes: 2_000, maxResponseChars: 1_000 });
  t.after(context.cleanup);

  for (let index = 0; index < 4; index += 1) {
    const job = await context.store.enqueue({
      updateId: `quota-${index}`,
      sessionKey: 'chat',
      kind: 'prompt',
    });
    const release = context.store.acquireLease(job.id);
    await context.store.transition(job.id, 'running');
    await context.store.transition(job.id, 'succeeded', { responseText: 'x'.repeat(900) });
    await release();
  }

  assert.ok((await stat(context.file)).size <= 2_000);
  assert.ok(context.store.listForSession('chat', { limit: 20 }).length < 4);
});

test('a failed atomic persist never changes in-memory state', async (t) => {
  const context = await fixture();
  t.after(context.cleanup);

  const dataDirectory = path.dirname(context.file);
  await rm(dataDirectory, { recursive: true });
  await writeFile(dataDirectory, 'blocks temporary files');

  await assert.rejects(
    context.store.enqueue({ updateId: 50, sessionKey: 'chat', kind: 'prompt' }),
  );
  assert.equal(context.store.getByUpdateId(50), null);
  assert.equal(context.store.latestForSession('chat'), null);
});

test('version 1 journals migrate to tombstoned version 2 without reopening pruned updates', async (t) => {
  const context = await fixture({ maxJobs: 2 });
  t.after(context.cleanup);
  const first = await context.store.enqueue({
    updateId: 'legacy-first',
    sessionKey: 'chat',
    kind: 'prompt',
  });
  await context.store.transition(first.id, 'running');
  await context.store.transition(first.id, 'succeeded', { delivered: true });
  await context.store.enqueue({
    updateId: 'legacy-second',
    sessionKey: 'chat',
    kind: 'prompt',
  });

  const current = JSON.parse(await readFile(context.file, 'utf8'));
  await writeFile(context.file, `${JSON.stringify({ version: 1, jobs: current.jobs }, null, 2)}\n`);

  const migrated = new JobStore(context.file, { maxJobs: 1 });
  await migrated.init();
  const persisted = JSON.parse(await readFile(context.file, 'utf8'));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.jobs.length, 1);
  assert.deepEqual(
    persisted.updateTombstones.map((entry) => entry.updateId),
    ['legacy-first'],
  );
  assert.equal(migrated.getByUpdateId('legacy-first')?.tombstone, true);
});

test('future or malformed schemas fail closed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-job-store-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'jobs.json');
  await writeFile(file, JSON.stringify({ version: 999, jobs: [] }));

  await assert.rejects(new JobStore(file).init(), /expected version 2/);
});
