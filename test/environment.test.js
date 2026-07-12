import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgyEnvironment,
  parseEnvironmentAllowlist,
  sanitizeExecutablePath,
} from '../src/environment.js';

test('agy child environment fails closed for bot and cloud secrets', () => {
  const env = buildAgyEnvironment({
    PATH: '/bin',
    HOME: '/home/bot',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/dbus',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
    BOT_TOKEN: 'telegram-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    CUSTOM_BUILD_FLAG: 'enabled',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/dbus');
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.BOT_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.CUSTOM_BUILD_FLAG, undefined);
});

test('agy child environment passes only explicitly named non-control-plane variables', () => {
  const names = parseEnvironmentAllowlist(
    'CUSTOM_BUILD_FLAG, GITHUB_TOKEN, BOT_TOKEN, TELEGRAM_API_ID, ALLOWED_CHAT_IDS, OWNER_USER_IDS, DISCORD_BOT_TOKEN, SSH_AUTH_SOCK',
  );
  const env = buildAgyEnvironment(
    {
      CUSTOM_BUILD_FLAG: 'enabled',
      GITHUB_TOKEN: 'explicit-token',
      BOT_TOKEN: 'never',
      TELEGRAM_API_ID: 'never',
      ALLOWED_CHAT_IDS: 'never',
      OWNER_USER_IDS: 'never',
      DISCORD_BOT_TOKEN: 'never',
      SSH_AUTH_SOCK: 'never',
    },
    names,
  );
  assert.equal(env.CUSTOM_BUILD_FLAG, 'enabled');
  assert.equal(env.GITHUB_TOKEN, 'explicit-token');
  assert.equal(env.BOT_TOKEN, undefined);
  assert.equal(env.TELEGRAM_API_ID, undefined);
  assert.equal(env.ALLOWED_CHAT_IDS, undefined);
  assert.equal(env.OWNER_USER_IDS, undefined);
  assert.equal(env.DISCORD_BOT_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, 'never');
});

test('agy child environment denies common bot secrets case-insensitively', () => {
  const env = buildAgyEnvironment(
    {
      custom_bot_secret: 'never',
      Slack_Signing_Secret: 'never',
      MATRIX_ACCESS_TOKEN: 'never',
      BUILD_API_KEY: 'allowed-when-explicit',
    },
    ['custom_bot_secret', 'Slack_Signing_Secret', 'MATRIX_ACCESS_TOKEN', 'BUILD_API_KEY'],
  );
  assert.equal(env.custom_bot_secret, undefined);
  assert.equal(env.Slack_Signing_Secret, undefined);
  assert.equal(env.MATRIX_ACCESS_TOKEN, undefined);
  assert.equal(env.BUILD_API_KEY, 'allowed-when-explicit');
});

test('agy child environment never passes loader or shell startup injection', () => {
  const env = buildAgyEnvironment(
    {
      NODE_OPTIONS: '--require=/tmp/inject.cjs',
      LD_PRELOAD: '/tmp/inject.so',
      DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
      BASH_ENV: '/tmp/inject.sh',
    },
    ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV'],
  );
  assert.deepEqual(env, {});
});

test('agy PATH removes relative and current-workspace executable search entries', () => {
  assert.equal(
    sanitizeExecutablePath('.:/usr/local/bin:relative:/usr/bin::/usr/local/bin', 'linux'),
    '/usr/local/bin:/usr/bin',
  );
  assert.equal(
    sanitizeExecutablePath('.;C:\\Windows\\System32;tools;\\rooted;"D:\\Safe Bin"', 'win32'),
    'C:\\Windows\\System32;D:\\Safe Bin',
  );
});
