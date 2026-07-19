import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseEnvironmentAllowlist } from './environment.js';

// Reserve ample room for each pretty-printed tombstone plus array/schema
// framing. Telegram update IDs are much shorter than the store's generic
// string limit, but this headroom keeps capacity validation independent of the
// current compact tombstone representation.
const TOMBSTONE_BYTES_PER_ENTRY = 192;
const TOMBSTONE_LEDGER_FIXED_OVERHEAD_BYTES = 4 * 1024;

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer from ${min} to ${max}, received: ${value}`);
  }
  return parsed;
}

function parseVersionTriplet(value, name, fallback) {
  const normalized = String(value ?? fallback).trim();
  const match = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) {
    throw new Error(`${name} must be a semantic version triplet like 1.1.1`);
  }
  const numbers = match.slice(1).map((part) => Number(part));
  if (!numbers.every(Number.isSafeInteger)) {
    throw new Error(`${name} must be a semantic version triplet like 1.1.1`);
  }
  return `${numbers[0]}.${numbers[1]}.${numbers[2]}`;
}

function parseIdSet(value, name, { required = false } = {}) {
  const values = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (required && values.length === 0) {
    throw new Error(`${name} is required`);
  }
  if (values.some((item) => !/^-?\d+$/.test(item))) {
    throw new Error(`${name} must contain only comma-separated numeric Telegram IDs`);
  }
  return new Set(values);
}

function parseGidSet(value) {
  const values = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.some((item) => !/^\d+$/.test(item) || !Number.isSafeInteger(Number(item)))) {
    throw new Error('TRUSTED_SERVICE_GROUP_GIDS must contain comma-separated non-negative integers');
  }
  return new Set(values.map(Number));
}

function detectAgyBinary(
  env,
  {
    platform = process.platform,
    homeDir = os.homedir(),
    pathApi = path,
    exists = existsSync,
  } = {},
) {
  if (env.AGY_BIN) {
    const configured = env.AGY_BIN.trim();
    if (!configured) throw new Error('AGY_BIN must not be empty');
    if (/[\\/]/.test(configured) && !path.isAbsolute(configured)) {
      throw new Error('AGY_BIN must be an absolute path or a bare command name');
    }
    return configured;
  }

  const executable = platform === 'win32' ? 'agy.exe' : 'agy';
  const candidates = [
    pathApi.join(homeDir, '.local', 'bin', executable),
    pathApi.join(homeDir, 'bin', executable),
    platform === 'win32' && env.LOCALAPPDATA
      ? pathApi.join(env.LOCALAPPDATA, 'agy', 'bin', executable)
      : null,
    platform === 'win32' && env.LOCALAPPDATA
      ? pathApi.join(env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin', executable)
      : null,
    platform === 'darwin' ? pathApi.join('/opt/homebrew/bin', executable) : null,
    platform !== 'win32' ? pathApi.join('/usr/local/bin', executable) : null,
  ].filter(Boolean);

  return candidates.find((candidate) => exists(candidate)) ?? 'agy';
}

function parsePathList(value, baseDir) {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(baseDir, item));
}

const MANAGED_FILE_PATHS = [
  ['STATE_FILE', 'stateFile'],
  ['JOB_FILE', 'jobFile'],
  ['USAGE_FILE', 'usageFile'],
];

const MANAGED_CLEANUP_DIRECTORIES = [
  ['UPLOADS_DIR', 'uploadsDir'],
  ['RESULTS_DIR', 'resultsDir'],
  ['AGY_RUN_LOG_DIR', 'agyRunLogDir'],
];

function isStrictDescendant(parent, candidate, pathApi) {
  const relative = pathApi.relative(parent, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relative);
}

function pathsOverlap(left, right, pathApi) {
  return pathApi.relative(left, right) === ''
    || isStrictDescendant(left, right, pathApi)
    || isStrictDescendant(right, left, pathApi);
}

function validateManagedStorageLayout(layout, pathApi = path) {
  const dataDir = layout.dataDir;
  if (typeof dataDir !== 'string' || !pathApi.isAbsolute(dataDir)) {
    throw new Error('DATA_DIR must resolve to an absolute path');
  }

  const managed = [...MANAGED_FILE_PATHS, ...MANAGED_CLEANUP_DIRECTORIES].map(
    ([environmentName, property]) => {
      const value = layout[property];
      if (typeof value !== 'string' || !pathApi.isAbsolute(value)) {
        throw new Error(`${environmentName} must resolve to an absolute path`);
      }
      if (!isStrictDescendant(dataDir, value, pathApi)) {
        throw new Error(`${environmentName} must be a strict descendant of DATA_DIR`);
      }
      return { environmentName, property, value };
    },
  );

  const files = managed.filter(({ property }) =>
    MANAGED_FILE_PATHS.some(([, fileProperty]) => fileProperty === property));
  for (let leftIndex = 0; leftIndex < files.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < files.length; rightIndex += 1) {
      if (pathApi.relative(files[leftIndex].value, files[rightIndex].value) === '') {
        throw new Error(
          `${files[leftIndex].environmentName} and ${files[rightIndex].environmentName} must reference different files`,
        );
      }
    }
  }

  const cleanupDirectories = managed.filter(({ property }) =>
    MANAGED_CLEANUP_DIRECTORIES.some(([, directoryProperty]) => directoryProperty === property));
  for (let leftIndex = 0; leftIndex < cleanupDirectories.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cleanupDirectories.length; rightIndex += 1) {
      if (pathsOverlap(
        cleanupDirectories[leftIndex].value,
        cleanupDirectories[rightIndex].value,
        pathApi,
      )) {
        throw new Error(
          `${cleanupDirectories[leftIndex].environmentName} and ${cleanupDirectories[rightIndex].environmentName} must not overlap`,
        );
      }
    }
  }

  for (const file of files) {
    for (const directory of cleanupDirectories) {
      if (pathsOverlap(file.value, directory.value, pathApi)) {
        throw new Error(
          `${file.environmentName} and ${directory.environmentName} must not overlap`,
        );
      }
    }
  }
}

export function loadConfig(env = process.env, baseDir = process.cwd()) {
  const botToken = env.BOT_TOKEN?.trim();
  if (!botToken) throw new Error('BOT_TOKEN is required');

  const defaultMode = env.DEFAULT_MODE?.trim() || 'plan';
  if (!['accept-edits', 'plan'].includes(defaultMode)) {
    throw new Error('DEFAULT_MODE must be accept-edits or plan');
  }

  const platformDefaultDataDir =
    process.platform === 'win32' && env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, 'agygram', 'data')
      : 'data';
  const dataDir = path.resolve(baseDir, env.DATA_DIR || platformDefaultDataDir);
  const stateFile = path.resolve(baseDir, env.STATE_FILE || path.join(dataDir, 'sessions.json'));
  const jobFile = path.resolve(baseDir, env.JOB_FILE || path.join(dataDir, 'jobs.json'));
  const usageFile = path.resolve(baseDir, env.USAGE_FILE || path.join(dataDir, 'usage.json'));
  const uploadsDir = path.resolve(baseDir, env.UPLOADS_DIR || path.join(dataDir, 'uploads'));
  const resultsDir = path.resolve(baseDir, env.RESULTS_DIR || path.join(dataDir, 'results'));
  const agyRunLogDir = path.resolve(
    baseDir,
    env.AGY_RUN_LOG_DIR || path.join(dataDir, 'runtime', 'agy'),
  );
  validateManagedStorageLayout({
    dataDir,
    stateFile,
    jobFile,
    usageFile,
    uploadsDir,
    resultsDir,
    agyRunLogDir,
  });
  const workspaceDir = path.resolve(baseDir, env.WORKSPACE_DIR || path.join(dataDir, 'workspace'));
  const configuredRoots = parsePathList(env.ALLOWED_WORKSPACE_ROOTS, baseDir);
  const allowedChatIds = parseIdSet(
    env.ALLOWED_CHAT_IDS || env.ALLOWED_CHAT_ID,
    'ALLOWED_CHAT_IDS',
    { required: true },
  );
  const allowedUserIds = parseIdSet(env.ALLOWED_USER_IDS, 'ALLOWED_USER_IDS');
  const configuredOwnerUserIds = parseIdSet(env.OWNER_USER_IDS, 'OWNER_USER_IDS');
  const requireUserAllowlistForGroups = parseBoolean(
    env.REQUIRE_USER_ALLOWLIST_FOR_GROUPS,
    true,
  );
  const groupChatAllowed = [...allowedChatIds].some((chatId) => chatId.startsWith('-'));
  if (
    requireUserAllowlistForGroups &&
    groupChatAllowed &&
    allowedUserIds.size === 0
  ) {
    throw new Error('ALLOWED_USER_IDS is required when a group chat is allowed');
  }

  if ([...configuredOwnerUserIds].some((userId) => userId.startsWith('-'))) {
    throw new Error('OWNER_USER_IDS must contain positive Telegram user IDs');
  }

  // ALLOWED_USER_IDS, when present, is a global sender filter in the bot
  // middleware. Without it, a private chat ID is also its sole user ID.
  const authorizedUserIds = allowedUserIds.size > 0
    ? new Set(allowedUserIds)
    : new Set([...allowedChatIds].filter((chatId) => !chatId.startsWith('-')));
  const ownerUserIds = new Set(configuredOwnerUserIds);
  if (ownerUserIds.size === 0) {
    const [onlyChatId] = allowedChatIds;
    const canInferPrivateOwner =
      allowedChatIds.size === 1 &&
      !groupChatAllowed &&
      authorizedUserIds.size === 1 &&
      authorizedUserIds.has(onlyChatId);
    if (!canInferPrivateOwner) {
      throw new Error(
        'OWNER_USER_IDS is required when multiple users or a group chat is allowed',
      );
    }
    ownerUserIds.add(onlyChatId);
  }

  const unauthorizedOwners = [...ownerUserIds].filter(
    (userId) => !authorizedUserIds.has(userId),
  );
  if (unauthorizedOwners.length > 0) {
    throw new Error('OWNER_USER_IDS must be included in the allowed Telegram users');
  }

  const maxUploadBytes = parseInteger(env.MAX_UPLOAD_BYTES, 20_000_000, {
    min: 1_024,
    max: 20_000_000,
  });
  const maxUploadStorageBytes = parseInteger(
    env.MAX_UPLOAD_STORAGE_BYTES,
    200 * 1024 * 1024,
    {
      min: 1_024,
      max: 100 * 1024 * 1024 * 1024,
    },
  );
  if (maxUploadStorageBytes < maxUploadBytes) {
    throw new Error('MAX_UPLOAD_STORAGE_BYTES must be at least MAX_UPLOAD_BYTES');
  }
  const stateRetentionHours = parseInteger(env.STATE_RETENTION_HOURS, 24 * 30, {
    min: 24,
    max: 24 * 365,
  });
  const resultRetentionHours = parseInteger(env.RESULT_RETENTION_HOURS, 24, {
    min: 1,
    max: 24 * 30,
  });
  if (resultRetentionHours > stateRetentionHours) {
    throw new Error('RESULT_RETENTION_HOURS must not exceed STATE_RETENTION_HOURS');
  }

  const allowUnsandboxedRuns = parseBoolean(env.ALLOW_UNSANDBOXED_RUNS, false);
  const allowUnsandboxedAutoApprove = parseBoolean(env.ALLOW_UNSANDBOXED_AUTO_APPROVE, false);
  if (allowUnsandboxedAutoApprove && !allowUnsandboxedRuns) {
    throw new Error('ALLOW_UNSANDBOXED_AUTO_APPROVE requires ALLOW_UNSANDBOXED_RUNS=true');
  }
  const authPrivateOnly = parseBoolean(env.AUTH_PRIVATE_ONLY, true);
  if (!authPrivateOnly) {
    throw new Error('AUTH_PRIVATE_ONLY cannot be disabled; OAuth is restricted to an owner private chat');
  }

  const agyTimeoutMs = parseInteger(env.AGY_TIMEOUT_MS, 330_000, {
    min: 10_000,
    max: 3_600_000,
  });
  const agyMinVersion = parseVersionTriplet(env.AGY_MIN_VERSION, 'AGY_MIN_VERSION', '1.1.1');
  const enforceAgyMinVersion = parseBoolean(env.AGY_ENFORCE_MIN_VERSION, false);
  const usageWindowMinutes = parseInteger(env.USAGE_WINDOW_MINUTES, 60, {
    min: 1,
    max: 24 * 60,
  });
  const maxAgyJobsPerUserPerWindow = parseInteger(
    env.MAX_AGY_JOBS_PER_USER_PER_WINDOW,
    20,
    { min: 1, max: 10_000 },
  );
  const maxAgyJobsGlobalPerWindow = parseInteger(
    env.MAX_AGY_JOBS_GLOBAL_PER_WINDOW,
    100,
    { min: 1, max: 100_000 },
  );
  if (maxAgyJobsGlobalPerWindow < maxAgyJobsPerUserPerWindow) {
    throw new Error('MAX_AGY_JOBS_GLOBAL_PER_WINDOW must be at least the per-user limit');
  }
  const maxAgyRuntimeMinutesPerUserPerDay = parseInteger(
    env.MAX_AGY_RUNTIME_MINUTES_PER_USER_PER_DAY,
    120,
    { min: 1, max: 365 * 24 * 60 },
  );
  const maxAgyRuntimeMinutesGlobalPerDay = parseInteger(
    env.MAX_AGY_RUNTIME_MINUTES_GLOBAL_PER_DAY,
    480,
    { min: 1, max: 365 * 24 * 60 },
  );
  if (maxAgyRuntimeMinutesGlobalPerDay < maxAgyRuntimeMinutesPerUserPerDay) {
    throw new Error('MAX_AGY_RUNTIME_MINUTES_GLOBAL_PER_DAY must be at least the per-user budget');
  }
  const maxAgyRuntimeMsPerUserPerDay = maxAgyRuntimeMinutesPerUserPerDay * 60 * 1_000;
  const maxAgyRuntimeMsGlobalPerDay = maxAgyRuntimeMinutesGlobalPerDay * 60 * 1_000;
  if (maxAgyRuntimeMsPerUserPerDay < agyTimeoutMs) {
    throw new Error('The per-user daily runtime budget must cover at least one AGY_TIMEOUT_MS reservation');
  }
  if (maxAgyRuntimeMsGlobalPerDay < agyTimeoutMs) {
    throw new Error('The global daily runtime budget must cover at least one AGY_TIMEOUT_MS reservation');
  }

  const jobHistoryLimit = parseInteger(env.JOB_HISTORY_LIMIT, 100, {
    min: 10,
    max: 1_000,
  });
  const jobJournalMaxBytes = parseInteger(
    env.JOB_JOURNAL_MAX_BYTES,
    16 * 1024 * 1024,
    { min: 1024 * 1024, max: 256 * 1024 * 1024 },
  );
  const maxUpdateAgeSeconds = parseInteger(env.MAX_UPDATE_AGE_SECONDS, 300, {
    min: 30,
    max: 86_400,
  });
  const agyQueueTimeoutMs = parseInteger(env.AGY_QUEUE_TIMEOUT_MS, 600_000, {
    min: 10_000,
    max: 3_600_000,
  });
  const agyQueueOverloadThresholdPercent = parseInteger(
    env.AGY_QUEUE_OVERLOAD_THRESHOLD_PERCENT,
    75,
    { min: 10, max: 100 },
  );
  const agyQueueOverloadTimeoutMs = parseInteger(env.AGY_QUEUE_OVERLOAD_TIMEOUT_MS, 120_000, {
    min: 10_000,
    max: 3_600_000,
  });
  if (agyQueueOverloadTimeoutMs > agyQueueTimeoutMs) {
    throw new Error('AGY_QUEUE_OVERLOAD_TIMEOUT_MS must not exceed AGY_QUEUE_TIMEOUT_MS');
  }
  const maxPendingAgyJobs = parseInteger(env.MAX_PENDING_AGY_JOBS, 16, {
    min: 1,
    max: 256,
  });
  const updateTombstoneRetentionHours = parseInteger(
    env.TELEGRAM_UPDATE_DEDUPE_RETENTION_HOURS,
    48,
    { min: 1, max: 24 * 365 },
  );
  const updateTombstoneRetentionMs = updateTombstoneRetentionHours * 60 * 60 * 1_000;
  const maxSupportedUpdateTombstones = 1_000_000;
  const maxUpdateTombstones = parseInteger(env.TELEGRAM_UPDATE_DEDUPE_LIMIT, 10_000, {
    min: 1,
    max: maxSupportedUpdateTombstones,
  });
  const maxUpdateTombstoneBytes = parseInteger(
    env.TELEGRAM_UPDATE_DEDUPE_MAX_BYTES,
    4 * 1024 * 1024,
    { min: 1_024, max: 256 * 1024 * 1024 },
  );
  if (updateTombstoneRetentionMs / 1_000 <= maxUpdateAgeSeconds) {
    throw new Error(
      'TELEGRAM_UPDATE_DEDUPE_RETENTION_HOURS must exceed MAX_UPDATE_AGE_SECONDS',
    );
  }
  if (jobHistoryLimit < maxPendingAgyJobs) {
    throw new Error('JOB_HISTORY_LIMIT must be at least MAX_PENDING_AGY_JOBS');
  }
  const retainedUsageWindows = Math.ceil(
    (updateTombstoneRetentionHours * 60) / usageWindowMinutes,
  );
  const minimumUpdateTombstones = Math.max(
    jobHistoryLimit + maxPendingAgyJobs,
    retainedUsageWindows * maxAgyJobsGlobalPerWindow + maxPendingAgyJobs,
  );
  if (minimumUpdateTombstones > maxSupportedUpdateTombstones) {
    throw new Error(
      `TELEGRAM_UPDATE_DEDUPE_LIMIT requires ${minimumUpdateTombstones} entries for the configured retention/rate, exceeding the supported maximum of ${maxSupportedUpdateTombstones}`,
    );
  }
  if (maxUpdateTombstones < minimumUpdateTombstones) {
    throw new Error(
      `TELEGRAM_UPDATE_DEDUPE_LIMIT must be at least ${minimumUpdateTombstones} for the configured history, pending work, retention, and global job rate`,
    );
  }
  if (maxUpdateTombstoneBytes > jobJournalMaxBytes) {
    throw new Error(
      'TELEGRAM_UPDATE_DEDUPE_MAX_BYTES must not exceed JOB_JOURNAL_MAX_BYTES',
    );
  }
  const minimumUpdateTombstoneBytes =
    minimumUpdateTombstones * TOMBSTONE_BYTES_PER_ENTRY +
    TOMBSTONE_LEDGER_FIXED_OVERHEAD_BYTES;
  if (maxUpdateTombstoneBytes < minimumUpdateTombstoneBytes) {
    throw new Error(
      `TELEGRAM_UPDATE_DEDUPE_MAX_BYTES must be at least ${minimumUpdateTombstoneBytes} for ${minimumUpdateTombstones} required dedupe entries`,
    );
  }

  return {
    botToken,
    allowedChatIds,
    allowedUserIds,
    ownerUserIds,
    requireUserAllowlistForGroups,
    authPrivateOnly,
    windowsAclVerified: parseBoolean(env.WINDOWS_ACL_VERIFIED, false),
    trustedServiceGroupGids: parseGidSet(env.TRUSTED_SERVICE_GROUP_GIDS),
    agyBin: detectAgyBinary(env),
    agyEnvironmentAllowlist: parseEnvironmentAllowlist(env.AGY_ENV_ALLOWLIST),
    dataDir,
    stateFile,
    maxStateSessions: parseInteger(env.MAX_STATE_SESSIONS, 500, { min: 1, max: 10_000 }),
    maxStateBytes: parseInteger(env.MAX_STATE_BYTES, 16 * 1024 * 1024, {
      min: 1024 * 1024,
      max: 256 * 1024 * 1024,
    }),
    stateRetentionHours,
    jobFile,
    usageFile,
    usageWindowMs: usageWindowMinutes * 60 * 1_000,
    maxAgyJobsPerUserPerWindow,
    maxAgyJobsGlobalPerWindow,
    maxAgyRuntimeMsPerUserPerDay,
    maxAgyRuntimeMsGlobalPerDay,
    usageRetentionDays: parseInteger(env.USAGE_RETENTION_DAYS, 8, { min: 2, max: 365 }),
    usageStoreMaxBytes: parseInteger(env.USAGE_STORE_MAX_BYTES, 4 * 1024 * 1024, {
      min: 64 * 1024,
      max: 256 * 1024 * 1024,
    }),
    jobHistoryLimit,
    jobResponseMaxChars: parseInteger(env.JOB_RESPONSE_MAX_CHARS, 64 * 1024, {
      min: 1_024,
      max: 64 * 1024,
    }),
    jobJournalMaxBytes,
    updateTombstoneRetentionMs,
    maxUpdateTombstones,
    maxUpdateTombstoneBytes,
    uploadsDir,
    resultsDir,
    resultRetentionHours,
    maxResultStorageBytes: parseInteger(env.MAX_RESULT_STORAGE_BYTES, 200 * 1024 * 1024, {
      min: 1024 * 1024,
      max: 10 * 1024 * 1024 * 1024,
    }),
    agyRunLogDir,
    agyRunLogRetentionHours: parseInteger(env.AGY_RUN_LOG_RETENTION_HOURS, 24, {
      min: 1,
      max: 24 * 30,
    }),
    maxAgyRunLogStorageBytes: parseInteger(
      env.MAX_AGY_RUN_LOG_STORAGE_BYTES || env.AGY_RUN_LOG_MAX_STORAGE_BYTES,
      50 * 1024 * 1024,
      { min: 1_024, max: 10 * 1024 * 1024 * 1024 },
    ),
    maxAgyRunLogFileBytes: parseInteger(env.MAX_AGY_RUN_LOG_FILE_BYTES, 4 * 1024 * 1024, {
      min: 256 * 1024,
      max: 50 * 1024 * 1024,
    }),
    workspaceDir,
    allowedWorkspaceRoots: [workspaceDir, ...configuredRoots],
    agyTimeoutMs,
    agyMinVersion,
    enforceAgyMinVersion,
    authCheckTimeoutMs: parseInteger(env.AGY_AUTH_CHECK_TIMEOUT_MS, 30_000, {
      min: 2_000,
      max: 300_000,
    }),
    authTimeoutMs: parseInteger(env.AGY_AUTH_TIMEOUT_MS, 900_000, {
      min: 60_000,
      max: 3_600_000,
    }),
    agyMaxOutputBytes: parseInteger(env.AGY_MAX_OUTPUT_BYTES, 2 * 1024 * 1024, {
      min: 16 * 1024,
      max: 50 * 1024 * 1024,
    }),
    captureAgyRunMetadata: parseBoolean(env.AGY_CAPTURE_RUN_METADATA, true),
    keepAgyRunLogs: parseBoolean(env.AGY_KEEP_RUN_LOGS, false),
    defaultMode,
    defaultSandbox: parseBoolean(env.DEFAULT_SANDBOX, true),
    sandboxPlanApply: parseBoolean(env.SANDBOX_PLAN_APPLY, true),
    allowUnsandboxedRuns,
    allowUnsandboxedAutoApprove,
    historyMaxTurns: parseInteger(env.HISTORY_MAX_TURNS, 20, { min: 0, max: 100 }),
    historyMaxChars: parseInteger(env.HISTORY_MAX_CHARS, 24_000, { min: 0, max: 24_000 }),
    maxConcurrentAgy: parseInteger(env.MAX_CONCURRENT_AGY, 1, { min: 1, max: 16 }),
    maxUpdateAgeSeconds,
    agyQueueTimeoutMs,
    agyQueueOverloadThresholdPercent,
    agyQueueOverloadTimeoutMs,
    maxPendingAgyJobs,
    maxPendingAgyJobsPerUser: parseInteger(env.MAX_PENDING_AGY_JOBS_PER_USER, 3, {
      min: 1,
      max: 32,
    }),
    maxUploadBytes,
    uploadRetentionHours: parseInteger(env.UPLOAD_RETENTION_HOURS, 24, {
      min: 1,
      max: 24 * 30,
    }),
    maxUploadStorageBytes,
    maxInlineResponseChars: parseInteger(env.MAX_INLINE_RESPONSE_CHARS, 20_000, {
      min: 1_000,
      max: 100_000,
    }),
    maxRedeliveryBytes: parseInteger(env.MAX_REDELIVERY_BYTES, 5 * 1024 * 1024, {
      min: 64 * 1024,
      max: 10 * 1024 * 1024,
    }),
    authForceRemote: parseBoolean(env.AUTH_FORCE_REMOTE, true),
  };
}

export const _private = {
  parseBoolean,
  parseInteger,
  parseIdSet,
  parseGidSet,
  detectAgyBinary,
  parsePathList,
  validateManagedStorageLayout,
};
