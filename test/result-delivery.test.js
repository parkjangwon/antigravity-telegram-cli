import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ResultStore } from '../src/results.js';
import { sendAgyResponseFile } from '../src/telegram.js';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('an in-flight Telegram file delivery cannot be evicted by a concurrent result save', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-result-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mib = 1024 * 1024;
  const store = await new ResultStore(root, {
    maxResultBytes: mib,
    maxTotalBytes: mib,
    retentionMs: 10_000,
  }).init();
  const first = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const second = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const firstText = 'a'.repeat(700 * 1024);
  const lease = await store.saveAndAcquire(first, firstText);
  const uploadStarted = deferred();
  const finishUpload = deferred();
  let receivedBytes = 0;
  const ctx = {
    chat: { id: 42 },
    telegram: {
      callApi: async (_method, payload) => {
        uploadStarted.resolve();
        await finishUpload.promise;
        for await (const chunk of payload.document.source) receivedBytes += chunk.length;
        return { message_id: 1 };
      },
    },
  };

  const delivery = sendAgyResponseFile(ctx, lease.file);
  await uploadStarted.promise;
  await assert.rejects(
    store.save(second, 'b'.repeat(700 * 1024)),
    (error) => error.code === 'RESULT_QUOTA_EXCEEDED',
  );
  assert.equal(await store.read(first), firstText);

  finishUpload.resolve();
  await delivery;
  assert.equal(receivedBytes, Buffer.byteLength(firstText));
  await lease.release();

  await store.save(second, 'b'.repeat(700 * 1024));
  await assert.rejects(store.read(first), /ENOENT/);
});
