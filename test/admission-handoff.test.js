import assert from 'node:assert/strict';
import test from 'node:test';

import { handoffAdmittedJob } from '../src/admission-handoff.js';
import { AdmissionController } from '../src/admission.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('cancel during delayed snapshot prevents durable enqueue and task registration', async () => {
  const snapshot = deferred();
  const admission = new AdmissionController();
  const reservation = admission.reserve({ token: 'job', sessionKey: 'chat', userId: 'user' });
  let enqueueCalls = 0;
  let startCalls = 0;

  const handoff = handoffAdmittedJob({
    reservation,
    preparePayload: () => snapshot.promise,
    enqueueJob: async () => {
      enqueueCalls += 1;
      return { id: 'journal' };
    },
    cancelQueuedJob: async () => assert.fail('no journal exists to cancel'),
    startJob: () => {
      startCalls += 1;
    },
  });

  assert.equal(admission.cancel('chat'), true);
  snapshot.resolve({ prompt: 'never run' });
  const result = await handoff;

  assert.equal(result.cancelled, true);
  assert.equal(result.job, null);
  assert.equal(enqueueCalls, 0);
  assert.equal(startCalls, 0);
  assert.equal(admission.size, 0);
});

test('cancel during delayed durable enqueue marks the created journal cancelled and never starts it', async () => {
  const enqueueStarted = deferred();
  const enqueued = deferred();
  const admission = new AdmissionController();
  const reservation = admission.reserve({ token: 'job', sessionKey: 'chat', userId: 'user' });
  const transitions = [];
  let startCalls = 0;

  const handoff = handoffAdmittedJob({
    reservation,
    preparePayload: async () => ({ prompt: 'never run' }),
    enqueueJob: async () => {
      enqueueStarted.resolve();
      return enqueued.promise;
    },
    cancelQueuedJob: async (job, reason) => {
      transitions.push({ id: job.id, status: 'cancelled', code: reason.code });
    },
    startJob: () => {
      startCalls += 1;
    },
  });

  await enqueueStarted.promise;
  admission.close();
  enqueued.resolve({ id: 'journal-after-shutdown' });
  const result = await handoff;

  assert.equal(result.cancelled, true);
  assert.deepEqual(transitions, [{
    id: 'journal-after-shutdown',
    status: 'cancelled',
    code: 'ADMISSION_CANCELLED',
  }]);
  assert.equal(startCalls, 0);
  assert.equal(admission.size, 0);
});

test('successful handoff keeps the reservation until detached execution settles', async () => {
  const execution = deferred();
  const admission = new AdmissionController();
  const reservation = admission.reserve({ token: 'job', sessionKey: 'chat', userId: 'user' });

  const result = await handoffAdmittedJob({
    reservation,
    preparePayload: async () => ({ prompt: 'run' }),
    enqueueJob: async () => ({ id: 'journal' }),
    cancelQueuedJob: async () => assert.fail('successful handoff must not cancel'),
    startJob: () => execution.promise,
  });

  assert.equal(result.cancelled, false);
  assert.equal(admission.size, 1);
  execution.resolve('done');
  assert.equal(await result.execution, 'done');
  assert.equal(admission.size, 0);
});
