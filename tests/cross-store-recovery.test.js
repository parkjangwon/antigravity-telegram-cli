import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JobStore } from '../src/job-store.js';
import { reconcileCrossStoreRecovery, _private } from '../src/recovery.js';
import { ResultStore } from '../src/results.js';
import { StateStore } from '../src/state.js';

async function openStores(root, { maxJobs = 500 } = {}) {
  const state = new StateStore(
    path.join(root, 'sessions.json'),
    { workspaceDir: root, mode: 'plan', sandbox: true },
  );
  const results = new ResultStore(path.join(root, 'results'), {
    maxResultBytes: 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
    retentionMs: 60_000,
  });
  const jobs = new JobStore(path.join(root, 'jobs.json'), { maxJobs });
  await state.init();
  await results.init({ cleanup: false });
  await jobs.init();
  return { state, results, jobs };
}

async function runningJob(stores, {
  updateId = 1,
  sessionKey = '123:4',
  kind = 'apply',
} = {}) {
  const job = await stores.jobs.enqueue({
    updateId,
    sessionKey,
    kind,
    payload: {
      type: 'request',
      prompt: 'make the requested change',
      executionContext: {
        mode: kind === 'plan' ? 'plan' : 'accept-edits',
        sandbox: true,
      },
    },
  });
  await stores.jobs.transition(job.id, 'running');
  return stores.jobs.get(job.id);
}

function committedLastRun(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: 'succeeded',
    mode: job.payload.executionContext.mode,
    sandbox: true,
    startedAt: job.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: 25,
    responseText: null,
    deliveryStatus: 'pending',
    errorCode: null,
  };
}

test('restart after state commit recovers the same job as succeeded with native continuity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-cross-store-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await openStores(root);
  await first.state.ensure('123:4');
  const job = await runningJob(first, { kind: 'plan' });
  await first.results.save(job.id, 'completed plan');
  await first.state.update('123:4', (session) => ({
    ...session,
    conversationId: 'native-conversation',
    projectId: 'native-project',
    newProject: false,
    lastRun: committedLastRun(job),
  }));
  // Crash here: JobStore never received its succeeded transition.

  const restarted = await openStores(root);
  assert.equal(restarted.jobs.get(job.id).status, 'interrupted');
  const summary = await reconcileCrossStoreRecovery(restarted);

  assert.deepEqual(summary, {
    candidates: 1,
    recovered: 1,
    recoveredIncomplete: 0,
    unresolved: 0,
    removedOrphans: 0,
  });
  const recovered = restarted.jobs.get(job.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.result.delivered, false);
  assert.equal(recovered.result.recoveryIncomplete, false);
  assert.equal(recovered.metadata.phase, 'delivery-pending');
  assert.equal(await restarted.results.read(job.id), 'completed plan');
  assert.equal(restarted.state.get('123:4').conversationId, 'native-conversation');
  assert.equal(restarted.state.get('123:4').projectId, 'native-project');
});

test('restart after result commit recovers without native continuity and cannot duplicate edits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-cross-store-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await openStores(root);
  await first.state.update('123:4', (session) => ({
    ...session,
    conversationId: 'pre-run-conversation',
    projectId: 'pre-run-project',
    newProject: false,
    model: 'chosen-model',
    history: [{ role: 'user', content: 'old turn', at: new Date().toISOString() }],
  }));
  const job = await runningJob(first);
  await first.results.save(job.id, 'edits already completed');
  // Crash here: neither state continuity nor journal success was committed.

  const restarted = await openStores(root);
  const summary = await reconcileCrossStoreRecovery(restarted);
  const session = restarted.state.get('123:4');
  const recovered = restarted.jobs.get(job.id);

  assert.equal(summary.recoveredIncomplete, 1);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.result.recoveryIncomplete, true);
  assert.equal(recovered.result.delivered, false);
  assert.equal(session.lastRun.id, job.id);
  assert.equal(session.lastRun.deliveryStatus, 'pending');
  assert.equal(session.lastRun.errorCode, _private.RECOVERY_INCOMPLETE);
  assert.equal(session.conversationId, null);
  assert.equal(session.projectId, null);
  assert.equal(session.newProject, true);
  assert.deepEqual(session.history, []);
  assert.equal(session.model, 'chosen-model');
  assert.equal(await restarted.results.read(job.id), 'edits already completed');

  // A recovered mutating job is terminal success, so /retry cannot create a
  // second attempt that repeats already-applied edits.
  await assert.rejects(
    restarted.jobs.enqueueRetry(job.id, 'duplicate-update'),
    /status succeeded cannot be retried/,
  );
  assert.equal(restarted.jobs.listForSession('123:4', { limit: 10 }).length, 1);

  const secondRestart = await openStores(root);
  assert.equal((await reconcileCrossStoreRecovery(secondRestart)).candidates, 0);
  assert.equal(secondRestart.jobs.get(job.id).status, 'succeeded');
});

test('crash after recovery state commit is completed idempotently on the next startup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-cross-store-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await openStores(root);
  await first.state.ensure('123:4');
  const job = await runningJob(first);
  await first.results.save(job.id, 'durable result');

  const restarted = await openStores(root);
  const crashAfterState = {
    get: (...args) => restarted.state.get(...args),
    update: async (...args) => {
      await restarted.state.update(...args);
      throw new Error('simulated process crash after durable state rename');
    },
  };
  await assert.rejects(
    reconcileCrossStoreRecovery({ ...restarted, state: crashAfterState }),
    /simulated process crash/,
  );
  assert.equal(restarted.jobs.get(job.id).status, 'interrupted');
  assert.equal(
    restarted.state.get('123:4').lastRun.errorCode,
    _private.RECOVERY_INCOMPLETE,
  );

  const secondRestart = await openStores(root);
  const summary = await reconcileCrossStoreRecovery(secondRestart);
  assert.equal(summary.recoveredIncomplete, 1);
  assert.equal(secondRestart.jobs.get(job.id).status, 'succeeded');
  assert.equal(await secondRestart.results.read(job.id), 'durable result');
});

test('missing result stays interrupted while an impossible queued result is removed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-cross-store-fail-closed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await openStores(root);
  await first.state.ensure('123:4');
  const running = await runningJob(first, { updateId: 10 });
  const queued = await first.jobs.enqueue({
    updateId: 11,
    sessionKey: '123:5',
    kind: 'prompt',
    payload: {},
  });
  await first.results.save(queued.id, 'untrusted same-name artifact');

  const restarted = await openStores(root);
  const summary = await reconcileCrossStoreRecovery(restarted);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.removedOrphans, 1);
  assert.equal(restarted.jobs.get(running.id).status, 'interrupted');
  assert.equal(restarted.jobs.get(queued.id).status, 'interrupted');
  assert.deepEqual(restarted.jobs.restartRecoveryCandidates(), []);
  await assert.rejects(restarted.results.acquire(queued.id), (error) => error.code === 'ENOENT');
});

test('all crash candidates are reconciled before history compaction can prune one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-cross-store-overflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await openStores(root, { maxJobs: 10 });
  const created = [];
  for (let index = 0; index < 11; index += 1) {
    const sessionKey = String(200 + index);
    await first.state.ensure(sessionKey);
    const job = await runningJob(first, {
      updateId: 100 + index,
      sessionKey,
      kind: 'apply',
    });
    await first.results.save(job.id, `completed-${index}`);
    created.push({ job, sessionKey, index });
  }

  const restarted = await openStores(root, { maxJobs: 10 });
  assert.equal(restarted.jobs.restartRecoveryCandidates().length, 11);
  const summary = await reconcileCrossStoreRecovery(restarted);
  assert.equal(summary.recovered, 11);
  assert.equal(summary.recoveredIncomplete, 11);
  assert.equal(restarted.jobs.restartRecoveryCandidates().length, 0);

  let retainedJobs = 0;
  for (const { job, sessionKey, index } of created) {
    const journal = restarted.jobs.get(job.id);
    if (journal) {
      retainedJobs += 1;
      assert.equal(journal.status, 'succeeded');
    }
    assert.equal(restarted.state.get(sessionKey).lastRun.id, job.id);
    assert.equal(await restarted.results.read(job.id), `completed-${index}`);
    assert.match(
      restarted.jobs.getByUpdateId(100 + index).status,
      /^(succeeded|deduplicated)$/u,
    );
    await assert.rejects(
      restarted.jobs.enqueueRetry(job.id, `retry-${index}`),
      /Unknown job|status succeeded cannot be retried/,
    );
  }
  assert.equal(retainedJobs, 10);
});
