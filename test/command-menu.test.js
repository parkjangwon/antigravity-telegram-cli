import assert from 'node:assert/strict';
import test from 'node:test';

import { BOT_COMMANDS, synchronizeBotCommandMenu } from '../src/command-menu.js';

test('command menu includes only the current bot commands', () => {
  assert.deepEqual(
    BOT_COMMANDS.map(({ command }) => command),
    [
      'start', 'plan', 'apply', 'new', 'model', 'agent', 'mode', 'sandbox',
      'workspace', 'project', 'info', 'status', 'last', 'jobs', 'retry', 'auth',
      'update', 'cancel', 'reset', 'help',
    ],
  );
});

test('command menu replaces default and allowed-chat Korean scopes', async () => {
  const calls = [];
  const bot = {
    telegram: {
      async callApi(method, payload) {
        calls.push({ method, payload });
        return true;
      },
    },
  };

  await synchronizeBotCommandMenu(bot, {
    allowedChatIds: new Set(['123456789']),
  });

  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map(({ method }) => method), [
    'deleteMyCommands', 'setMyCommands', 'deleteMyCommands', 'setMyCommands',
    'deleteMyCommands', 'setMyCommands', 'deleteMyCommands', 'setMyCommands',
  ]);
  assert.deepEqual(calls[0].payload, {});
  assert.equal(calls[1].payload.commands, BOT_COMMANDS);
  assert.deepEqual(calls[2].payload, { language_code: 'ko' });
  assert.deepEqual(calls[4].payload, { scope: { type: 'chat', chat_id: 123456789 } });
  assert.deepEqual(calls[6].payload, {
    scope: { type: 'chat', chat_id: 123456789 },
    language_code: 'ko',
  });
});

test('an unavailable chat scope is logged without blocking startup', async () => {
  const warnings = [];
  const bot = {
    telegram: {
      async callApi(method, payload) {
        if (payload.scope?.chat_id === -100123) throw new Error('chat not found');
        return method === 'setMyCommands';
      },
    },
  };

  await synchronizeBotCommandMenu(bot, {
    allowedChatIds: new Set(['-100123']),
    logger: { warn: (...args) => warnings.push(args) },
  });

  assert.equal(warnings.length, 2);
  assert.equal(warnings[0][1].chatId, '-100123');
});
