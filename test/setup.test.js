import assert from 'node:assert/strict';
import test from 'node:test';

import { _private } from '../src/setup.js';

test('setup argument parser accepts onboarding paths and rejects duplicates', () => {
  assert.deepEqual(_private.parseArgs([
    '--config-file', '/tmp/agygram.env',
    '--data-dir', '/tmp/agygram-data',
    '--workspace-dir', '/tmp/workspace',
    '--agy-bin', '/usr/local/bin/agy',
    '--skip-telegram-discovery',
  ]), {
    configFile: '/tmp/agygram.env',
    dataDir: '/tmp/agygram-data',
    workspaceDir: '/tmp/workspace',
    agyBin: '/usr/local/bin/agy',
    discoverTelegram: false,
    interactive: true,
  });

  assert.throws(
    () => _private.parseArgs(['--config-file', '/tmp/a', '--config-file', '/tmp/b']),
    /Duplicate option/u,
  );
});

test('setup env writer updates existing values without exposing shell controls', () => {
  const text = [
    'BOT_TOKEN=',
    'ALLOWED_CHAT_IDS=1',
    '# comment',
    '',
  ].join('\n');

  const updated = _private.setEnvValue(
    _private.setEnvValue(text, 'BOT_TOKEN', '123456:abcdefghijklmnopqrstuvwxyz'),
    'WORKSPACE_DIR',
    "/home/dev/project's",
  );

  assert.match(updated, /BOT_TOKEN='123456:abcdefghijklmnopqrstuvwxyz'/u);
  assert.match(updated, /WORKSPACE_DIR="\/home\/dev\/project's"/u);
  assert.throws(() => _private.envLiteral('bad\nvalue'), /control characters/u);
});

test('setup chooses the newest private Telegram update for auto-detect', () => {
  const message = _private.latestPrivateUpdate([
    {
      update_id: 1,
      message: {
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 10 },
      },
    },
    {
      update_id: 2,
      message: {
        chat: { id: 123, type: 'private' },
        from: { id: 123, first_name: 'Old' },
      },
    },
    {
      update_id: 3,
      message: {
        chat: { id: 456, type: 'private' },
        from: { id: 456, first_name: 'New' },
      },
    },
  ]);

  assert.equal(message.chat.id, 456);
  assert.equal(message.from.first_name, 'New');
});
