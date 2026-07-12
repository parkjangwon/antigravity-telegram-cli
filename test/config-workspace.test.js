import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _private, loadConfig } from '../src/config.js';
import { prepareWorkspaces, resolveWorkspace } from '../src/workspace.js';

const { detectAgyBinary, validateManagedStorageLayout } = _private;

test('Windows discovery checks the official per-user native agy install directory', () => {
  const expected = String.raw`C:\Users\dev\AppData\Local\agy\bin\agy.exe`;
  const discovered = detectAgyBinary(
    { LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local` },
    {
      platform: 'win32',
      homeDir: String.raw`C:\Users\dev`,
      pathApi: path.win32,
      exists: (candidate) => candidate === expected,
    },
  );
  assert.equal(discovered, expected);
});

test('loadConfig parses authorization and security settings', () => {
  const config = loadConfig(
    {
      BOT_TOKEN: 'test-token',
      ALLOWED_CHAT_IDS: '1, -2',
      ALLOWED_USER_IDS: '3',
      OWNER_USER_IDS: '3',
      AGY_BIN: '/opt/agy',
      DEFAULT_MODE: 'plan',
      DEFAULT_SANDBOX: 'yes',
      MAX_CONCURRENT_AGY: '2',
      UPLOAD_RETENTION_HOURS: '48',
      MAX_UPLOAD_STORAGE_BYTES: '314572800',
      AGY_RUN_LOG_RETENTION_HOURS: '12',
      MAX_AGY_RUN_LOG_STORAGE_BYTES: '104857600',
      USAGE_WINDOW_MINUTES: '30',
      MAX_AGY_JOBS_PER_USER_PER_WINDOW: '4',
      MAX_AGY_JOBS_GLOBAL_PER_WINDOW: '9',
      MAX_AGY_RUNTIME_MINUTES_PER_USER_PER_DAY: '60',
      MAX_AGY_RUNTIME_MINUTES_GLOBAL_PER_DAY: '180',
      MAX_UPDATE_AGE_SECONDS: '600',
      TELEGRAM_UPDATE_DEDUPE_RETENTION_HOURS: '72',
      TELEGRAM_UPDATE_DEDUPE_LIMIT: '25000',
      TELEGRAM_UPDATE_DEDUPE_MAX_BYTES: '8388608',
    },
    '/tmp/project',
  );
  assert.deepEqual([...config.allowedChatIds], ['1', '-2']);
  assert.deepEqual([...config.allowedUserIds], ['3']);
  assert.deepEqual([...config.ownerUserIds], ['3']);
  assert.equal(config.agyBin, '/opt/agy');
  assert.equal(config.defaultMode, 'plan');
  assert.equal(config.defaultSandbox, true);
  assert.equal(config.maxConcurrentAgy, 2);
  assert.equal(config.uploadRetentionHours, 48);
  assert.equal(config.maxUploadStorageBytes, 314_572_800);
  assert.equal(config.agyRunLogRetentionHours, 12);
  assert.equal(config.maxAgyRunLogStorageBytes, 104_857_600);
  assert.equal(config.usageWindowMs, 30 * 60 * 1_000);
  assert.equal(config.maxAgyJobsPerUserPerWindow, 4);
  assert.equal(config.maxAgyJobsGlobalPerWindow, 9);
  assert.equal(config.maxAgyRuntimeMsPerUserPerDay, 60 * 60 * 1_000);
  assert.equal(config.maxAgyRuntimeMsGlobalPerDay, 180 * 60 * 1_000);
  assert.equal(config.maxUpdateAgeSeconds, 600);
  assert.equal(config.updateTombstoneRetentionMs, 72 * 60 * 60 * 1_000);
  assert.equal(config.maxUpdateTombstones, 25_000);
  assert.equal(config.maxUpdateTombstoneBytes, 8 * 1024 * 1024);
});

test('loadConfig infers the owner only for one private chat', () => {
  const config = loadConfig(
    { BOT_TOKEN: 'test-token', ALLOWED_CHAT_IDS: '858588087' },
    '/tmp/project',
  );
  assert.deepEqual([...config.ownerUserIds], ['858588087']);
  assert.equal(config.uploadRetentionHours, 24);
  assert.equal(config.maxUploadStorageBytes, 200 * 1024 * 1024);
  assert.equal(config.agyRunLogRetentionHours, 24);
  assert.equal(config.maxAgyRunLogStorageBytes, 50 * 1024 * 1024);
  assert.equal(config.defaultMode, 'plan');
  assert.equal(config.defaultSandbox, true);
  assert.equal(config.allowUnsandboxedRuns, false);
  assert.equal(config.maxAgyJobsPerUserPerWindow, 20);
  assert.equal(config.maxAgyJobsGlobalPerWindow, 100);
  assert.equal(config.maxAgyRuntimeMsPerUserPerDay, 120 * 60 * 1_000);
  assert.equal(config.maxAgyRuntimeMsGlobalPerDay, 480 * 60 * 1_000);
  assert.equal(config.updateTombstoneRetentionMs, 48 * 60 * 60 * 1_000);
  assert.equal(config.maxUpdateTombstones, 10_000);
  assert.equal(config.maxUpdateTombstoneBytes, 4 * 1024 * 1024);
});

test('loadConfig rejects missing or malformed authorization', () => {
  assert.throws(() => loadConfig({ BOT_TOKEN: 'x' }, '/tmp'), /ALLOWED_CHAT_IDS/);
  assert.throws(
    () => loadConfig({ BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: 'not-a-number' }, '/tmp'),
    /numeric Telegram IDs/,
  );
  assert.throws(
    () => loadConfig({ BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: '-100123' }, '/tmp'),
    /ALLOWED_USER_IDS is required/,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '-100123',
      ALLOWED_USER_IDS: '3',
    }, '/tmp'),
    /OWNER_USER_IDS is required/,
  );
  assert.throws(
    () => loadConfig({ BOT_TOKEN: 'x', ALLOWED_CHAT_IDS: '1,2' }, '/tmp'),
    /OWNER_USER_IDS is required/,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      MAX_UPLOAD_BYTES: '2000000',
      MAX_UPLOAD_STORAGE_BYTES: '1000000',
    }, '/tmp'),
    /MAX_UPLOAD_STORAGE_BYTES must be at least MAX_UPLOAD_BYTES/,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1,2',
      OWNER_USER_IDS: 'not-a-number',
    }, '/tmp'),
    /numeric Telegram IDs/,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1,2',
      OWNER_USER_IDS: '9',
    }, '/tmp'),
    /included in the allowed Telegram users/,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      AGY_BIN: './workspace-controlled/agy',
    }, '/tmp'),
    /absolute path or a bare command name/,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      ALLOW_UNSANDBOXED_AUTO_APPROVE: 'true',
    }, '/tmp'),
    /requires ALLOW_UNSANDBOXED_RUNS/,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      AUTH_PRIVATE_ONLY: 'false',
    }, '/tmp'),
    /cannot be disabled/,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      MAX_AGY_JOBS_PER_USER_PER_WINDOW: '5',
      MAX_AGY_JOBS_GLOBAL_PER_WINDOW: '4',
    }, '/tmp'),
    /global.*at least the per-user/i,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      AGY_TIMEOUT_MS: '600000',
      MAX_AGY_RUNTIME_MINUTES_PER_USER_PER_DAY: '5',
    }, '/tmp'),
    /daily runtime budget must cover/i,
  );
});

test('loadConfig rejects inconsistent dedupe, journal, and pending-work limits', () => {
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      MAX_UPDATE_AGE_SECONDS: '3600',
      TELEGRAM_UPDATE_DEDUPE_RETENTION_HOURS: '1',
    }, '/tmp'),
    { message: 'TELEGRAM_UPDATE_DEDUPE_RETENTION_HOURS must exceed MAX_UPDATE_AGE_SECONDS' },
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      JOB_HISTORY_LIMIT: '10',
      MAX_PENDING_AGY_JOBS: '11',
    }, '/tmp'),
    { message: 'JOB_HISTORY_LIMIT must be at least MAX_PENDING_AGY_JOBS' },
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      TELEGRAM_UPDATE_DEDUPE_LIMIT: '4815',
    }, '/tmp'),
    {
      message: 'TELEGRAM_UPDATE_DEDUPE_LIMIT must be at least 4816 for the configured history, pending work, retention, and global job rate',
    },
  );
  assert.equal(
    loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      TELEGRAM_UPDATE_DEDUPE_LIMIT: '4816',
    }, '/tmp').maxUpdateTombstones,
    4816,
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      USAGE_WINDOW_MINUTES: '1',
      MAX_AGY_JOBS_GLOBAL_PER_WINDOW: '100000',
    }, '/tmp'),
    {
      message: 'TELEGRAM_UPDATE_DEDUPE_LIMIT requires 288000016 entries for the configured retention/rate, exceeding the supported maximum of 1000000',
    },
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      JOB_JOURNAL_MAX_BYTES: '1048576',
      TELEGRAM_UPDATE_DEDUPE_MAX_BYTES: '1048577',
    }, '/tmp'),
    { message: 'TELEGRAM_UPDATE_DEDUPE_MAX_BYTES must not exceed JOB_JOURNAL_MAX_BYTES' },
  );
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      TELEGRAM_UPDATE_DEDUPE_MAX_BYTES: '928767',
    }, '/tmp'),
    {
      message: 'TELEGRAM_UPDATE_DEDUPE_MAX_BYTES must be at least 928768 for 4816 required dedupe entries',
    },
  );
  assert.equal(
    loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      TELEGRAM_UPDATE_DEDUPE_MAX_BYTES: '928768',
    }, '/tmp').maxUpdateTombstoneBytes,
    928768,
  );
});

test('managed storage paths stay strictly inside DATA_DIR without constraining workspace', () => {
  const baseDir = '/srv/agygram';
  const dataDir = '/srv/agygram/private-data';
  const workspaceDir = '/srv/source/project';
  const config = loadConfig({
    BOT_TOKEN: 'x',
    ALLOWED_CHAT_IDS: '1',
    DATA_DIR: dataDir,
    WORKSPACE_DIR: workspaceDir,
  }, baseDir);

  assert.equal(config.dataDir, dataDir);
  assert.equal(config.workspaceDir, workspaceDir);
  assert.equal(config.allowedWorkspaceRoots[0], workspaceDir);
  for (const managedPath of [
    config.stateFile,
    config.jobFile,
    config.usageFile,
    config.uploadsDir,
    config.resultsDir,
    config.agyRunLogDir,
  ]) {
    const relative = path.posix.relative(dataDir, managedPath);
    assert.notEqual(relative, '');
    assert.equal(relative.startsWith('../'), false);
    assert.equal(path.posix.isAbsolute(relative), false);
  }
});

test('loadConfig rejects managed storage equal to or escaping DATA_DIR', () => {
  const baseEnvironment = {
    BOT_TOKEN: 'x',
    ALLOWED_CHAT_IDS: '1',
    DATA_DIR: '/srv/agygram/data',
  };
  const invalidPaths = [
    ['STATE_FILE', '/srv/agygram/data'],
    ['JOB_FILE', '/srv/agygram/jobs.json'],
    ['USAGE_FILE', '/srv/agygram/data/../../usage.json'],
    ['UPLOADS_DIR', '/srv/agygram/data'],
    ['RESULTS_DIR', '/srv/agygram/results'],
    ['AGY_RUN_LOG_DIR', '/var/log/agygram'],
  ];

  for (const [name, value] of invalidPaths) {
    assert.throws(
      () => loadConfig({ ...baseEnvironment, [name]: value }, '/srv/agygram'),
      new RegExp(`${name} must be a strict descendant of DATA_DIR`),
    );
  }
});

test('loadConfig rejects duplicate files and destructive managed-directory overlaps', () => {
  const baseEnvironment = {
    BOT_TOKEN: 'x',
    ALLOWED_CHAT_IDS: '1',
    DATA_DIR: '/srv/agygram/data',
  };
  assert.throws(
    () => loadConfig({
      ...baseEnvironment,
      STATE_FILE: '/srv/agygram/data/shared.json',
      JOB_FILE: '/srv/agygram/data/shared.json',
    }, '/srv/agygram'),
    /STATE_FILE and JOB_FILE must reference different files/,
  );
  assert.throws(
    () => loadConfig({
      ...baseEnvironment,
      UPLOADS_DIR: '/srv/agygram/data/artifacts',
      RESULTS_DIR: '/srv/agygram/data/artifacts/results',
    }, '/srv/agygram'),
    /UPLOADS_DIR and RESULTS_DIR must not overlap/,
  );
  assert.throws(
    () => loadConfig({
      ...baseEnvironment,
      STATE_FILE: '/srv/agygram/data/results/sessions.json',
    }, '/srv/agygram'),
    /STATE_FILE and RESULTS_DIR must not overlap/,
  );
});

test('result retention cannot outlive its session-state index', () => {
  assert.throws(
    () => loadConfig({
      BOT_TOKEN: 'x',
      ALLOWED_CHAT_IDS: '1',
      STATE_RETENTION_HOURS: '24',
      RESULT_RETENTION_HOURS: '25',
    }, '/srv/agygram'),
    /RESULT_RETENTION_HOURS must not exceed STATE_RETENTION_HOURS/,
  );
  assert.equal(loadConfig({
    BOT_TOKEN: 'x',
    ALLOWED_CHAT_IDS: '1',
    STATE_RETENTION_HOURS: '24',
    RESULT_RETENTION_HOURS: '24',
  }, '/srv/agygram').resultRetentionHours, 24);
});

test('managed storage validation applies Windows path and case semantics', () => {
  const valid = {
    dataDir: 'C:\\Users\\Dev\\agygram-data',
    stateFile: 'c:\\users\\dev\\agygram-data\\sessions.json',
    jobFile: 'C:\\Users\\Dev\\agygram-data\\jobs.json',
    usageFile: 'C:\\Users\\Dev\\agygram-data\\usage.json',
    uploadsDir: 'C:\\Users\\Dev\\agygram-data\\uploads',
    resultsDir: 'C:\\Users\\Dev\\agygram-data\\results',
    agyRunLogDir: 'C:\\Users\\Dev\\agygram-data\\runtime\\agy',
  };
  assert.doesNotThrow(() => validateManagedStorageLayout(valid, path.win32));

  assert.throws(
    () => validateManagedStorageLayout({
      ...valid,
      stateFile: 'D:\\Elsewhere\\sessions.json',
    }, path.win32),
    /STATE_FILE must be a strict descendant of DATA_DIR/,
  );
  assert.throws(
    () => validateManagedStorageLayout({
      ...valid,
      jobFile: 'C:\\Users\\Dev\\agygram-data\\SESSIONS.JSON',
    }, path.win32),
    /STATE_FILE and JOB_FILE must reference different files/,
  );
  assert.throws(
    () => validateManagedStorageLayout({
      ...valid,
      resultsDir: 'c:\\users\\dev\\AGYGRAM-DATA\\uploads\\results',
    }, path.win32),
    /UPLOADS_DIR and RESULTS_DIR must not overlap/,
  );
});

test('workspace validation resolves symlinks and blocks escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-workspace-'));
  const allowed = path.join(root, 'allowed');
  const child = path.join(allowed, 'child');
  const outside = path.join(root, 'outside');
  try {
    await Promise.all([mkdir(child, { recursive: true }), mkdir(outside, { recursive: true })]);
    const roots = await prepareWorkspaces(allowed, [allowed]);
    assert.equal(await resolveWorkspace('child', { defaultWorkspace: allowed, allowedRoots: roots }), child);

    const link = path.join(allowed, 'escape');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      resolveWorkspace('escape', { defaultWorkspace: allowed, allowedRoots: roots }),
      /outside ALLOWED_WORKSPACE_ROOTS/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
