import assert from 'node:assert/strict';
import test from 'node:test';

import { AdmissionController, AdmissionError } from '../src/admission.js';

test('admission atomically enforces session, actor, and global pending limits', () => {
  const admission = new AdmissionController({ maxTotal: 3, maxPerUser: 2 });
  const releaseA = admission.reserve({ token: 'a', sessionKey: 'chat:1', userId: 'user-a' });
  assert.throws(
    () => admission.reserve({ token: 'same-session', sessionKey: 'chat:1', userId: 'user-b' }),
    (error) => error instanceof AdmissionError && error.code === 'SESSION_JOB_LIMIT',
  );
  const releaseB = admission.reserve({ token: 'b', sessionKey: 'chat:2', userId: 'user-a' });
  assert.throws(
    () => admission.reserve({ token: 'user-limit', sessionKey: 'chat:3', userId: 'user-a' }),
    (error) => error.code === 'USER_JOB_LIMIT',
  );
  const releaseC = admission.reserve({ token: 'c', sessionKey: 'chat:3', userId: 'user-b' });
  assert.throws(
    () => admission.reserve({ token: 'global', sessionKey: 'chat:4', userId: 'user-c' }),
    (error) => error.code === 'GLOBAL_JOB_LIMIT',
  );
  assert.equal(admission.size, 3);
  assert.equal(releaseA(), true);
  assert.equal(releaseA(), false);
  assert.equal(releaseB(), true);
  assert.equal(releaseC(), true);
  assert.equal(admission.size, 0);
});

test('already-active sessions and duplicate admission tokens fail closed', () => {
  const admission = new AdmissionController({ maxTotal: 2, maxPerUser: 2 });
  assert.throws(
    () => admission.reserve({ token: 'x', sessionKey: 's', userId: 'u', sessionAlreadyActive: true }),
    (error) => error.code === 'SESSION_JOB_LIMIT',
  );
  const release = admission.reserve({ token: 'x', sessionKey: 's', userId: 'u' });
  assert.throws(
    () => admission.reserve({ token: 'x', sessionKey: 'other', userId: 'u' }),
    (error) => error.code === 'DUPLICATE_ADMISSION',
  );
  release();
});

test('session cancellation aborts a reservation but retains capacity until handoff releases it', async () => {
  const admission = new AdmissionController({ maxTotal: 1, maxPerUser: 1 });
  const reservation = admission.reserve({ token: 'x', sessionKey: 's', userId: 'u' });

  assert.equal(typeof reservation, 'function');
  assert.equal(reservation.release, reservation);
  assert.equal(reservation.signal.aborted, false);
  assert.equal(admission.cancel('s'), true);
  assert.equal(admission.cancel('s'), false);
  assert.equal(reservation.signal.aborted, true);
  assert.equal(reservation.signal.reason.code, 'ADMISSION_CANCELLED');
  assert.equal(admission.size, 1);
  assert.equal(await admission.waitForIdle(1), false);

  reservation.release();
  assert.equal(await admission.waitForIdle(1), true);
});

test('close seals admission, cancels all reservations, and waits for their owners to drain', async () => {
  const admission = new AdmissionController({ maxTotal: 2, maxPerUser: 2 });
  const first = admission.reserve({ token: 'a', sessionKey: 's1', userId: 'u' });
  const second = admission.reserve({ token: 'b', sessionKey: 's2', userId: 'u' });
  const idle = admission.waitForIdle(100);

  assert.equal(admission.close(), true);
  assert.equal(admission.close(), false);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.throws(
    () => admission.reserve({ token: 'c', sessionKey: 's3', userId: 'u' }),
    (error) => error instanceof AdmissionError && error.code === 'ADMISSION_CLOSED',
  );

  first.release();
  assert.equal(admission.size, 1);
  second.release();
  assert.equal(await idle, true);
});
