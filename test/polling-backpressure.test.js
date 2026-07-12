import assert from 'node:assert/strict';
import test from 'node:test';
import telegrafPolling from '../node_modules/telegraf/lib/core/network/polling.js';

import { stopPollingWithoutOffsetCommit } from '../src/polling-backpressure.js';

const { Polling } = telegrafPolling;

test('durability backpressure stops polling and suppresses offset sync', () => {
  let stops = 0;
  const bot = {
    polling: {
      skipOffsetSync: false,
      stop() {
        stops += 1;
      },
    },
  };

  assert.equal(stopPollingWithoutOffsetCommit(bot), true);
  assert.equal(bot.polling.skipOffsetSync, true);
  assert.equal(stops, 1);
});

test('durability backpressure reports unavailable transports without guessing', () => {
  assert.equal(stopPollingWithoutOffsetCommit({}), false);
  assert.equal(stopPollingWithoutOffsetCommit(null), false);
});

test('Telegraf does not confirm its prefetched batch after durability backpressure', async () => {
  const calls = [];
  const telegram = {
    async callApi(method, payload) {
      calls.push({ method, payload });
      return [{ update_id: 41, message: { text: 'mutating request' } }];
    },
  };
  const polling = new Polling(telegram, []);
  const bot = { polling };
  const capacityError = Object.assign(new Error('dedupe full'), {
    code: 'JOB_UPDATE_LEDGER_FULL',
  });

  await assert.rejects(
    polling.loop(async () => {
      stopPollingWithoutOffsetCommit(bot);
      throw capacityError;
    }),
    (error) => error === capacityError,
  );

  // The first getUpdates fetched update 41. A second call with offset 42 would
  // confirm it; skipOffsetSync keeps that call from ever happening.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.offset, 0);
  assert.equal(polling.skipOffsetSync, true);
});
