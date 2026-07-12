#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

import { loadConfig } from '../src/config.js';
import { manageService, preflightServiceInstall } from '../src/service/index.js';
import {
  parseFileRunnerArguments,
  resolveRuntimeEnvFile,
  resolveServiceDataDir,
} from '../src/service/runtime-paths.js';
import { assertRuntimeFilesystemTrust } from '../src/runtime-trust.js';
import { setupCommand } from '../src/setup.js';
import { AGYGRAM_VERSION } from '../src/version.js';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `agygram — Antigravity Telegram CLI operations

Usage:
  agygram setup [--config-file <path>] [--data-dir <path>] [--workspace-dir <path>] [--agy-bin <path>]
  agygram doctor [--config-file <path>] [--data-dir <path>]
  agygram service install [--dry-run] [--config-file <path>] [--data-dir <path>]
  agygram service uninstall [--dry-run] [--config-file <path>] [--data-dir <path>]
  agygram service status [--dry-run] [--config-file <path>] [--data-dir <path>]

Options:
  --dry-run               Print native service definition and argv; change nothing
  --platform <os>         darwin, linux, or win32 (dry-run only)
  --project-dir <path>    Absolute project directory (mainly packaging/testing)
  --node <path>           Absolute Node.js executable path
  --config-file <path>    Absolute config file (default: project/.env)
  --data-dir <path>       Absolute runtime data directory (overrides DATA_DIR)
  --workspace-dir <path>  Absolute workspace directory for agy work
  --agy-bin <path>        Absolute agy executable path for setup
  --home <path>           Target user's absolute home path (cross-OS dry-run)
  --uid <number>          Target macOS uid (cross-OS dry-run)
  --windows-user <id>     Target DOMAIN\\user (cross-OS dry-run)
  --no-linger             Linux: do not enable boot/logout persistence
  -v, --version           Print the installed agygram version
  -h, --help              Show this help

The service always runs as the current user so agy can access that user's OAuth
credentials. Run "agygram doctor" before installation.
`;

function parseOptions(args) {
  const result = {
    dryRun: false,
    platform: undefined,
    projectDir: PROJECT_DIR,
    nodePath: process.execPath,
    enableLinger: true,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (seen.has(item)) throw new Error(`Duplicate option: ${item}`);
    seen.add(item);
    if (item === '--dry-run') result.dryRun = true;
    else if (item === '--no-linger') result.enableLinger = false;
    else if ([
      '--platform',
      '--project-dir',
      '--node',
      '--config-file',
      '--data-dir',
      '--home',
      '--uid',
      '--windows-user',
    ].includes(item)) {
      const value = args[index + 1];
      if (value == null || value.startsWith('--')) {
        throw new Error(`Missing value after ${item}`);
      }
      index += 1;
      if (item === '--platform') result.platform = value;
      else if (item === '--project-dir') result.projectDir = value;
      else if (item === '--node') result.nodePath = value;
      else if (item === '--config-file') result.envFile = value;
      else if (item === '--data-dir') result.dataDir = value;
      else if (item === '--home') result.homeDir = value;
      else if (item === '--windows-user') result.windowsUserId = value;
      else {
        const uid = Number(value);
        if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`Invalid uid: ${value}`);
        result.uid = uid;
      }
    } else throw new Error(`Unknown option: ${item}`);
  }
  parseFileRunnerArguments([
    ...(result.dataDir ? ['--data-dir', result.dataDir] : []),
    ...(result.envFile ? ['--config-file', result.envFile] : []),
  ], result.platform ?? process.platform);
  return result;
}

const SERVICE_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
];

// Only application configuration is imported from the selected env file. In particular,
// Node/loader startup controls such as NODE_OPTIONS, LD_PRELOAD and DYLD_*
// must never reach the doctor child process.
const SERVICE_CONFIG_KEYS = new Set([
  'AGY_AUTH_CHECK_TIMEOUT_MS',
  'AGY_AUTH_TIMEOUT_MS',
  'AGY_BIN',
  'AGY_CAPTURE_RUN_METADATA',
  'AGY_ENV_ALLOWLIST',
  'AGY_KEEP_RUN_LOGS',
  'AGY_MAX_OUTPUT_BYTES',
  'AGY_QUEUE_TIMEOUT_MS',
  'AGY_RUN_LOG_DIR',
  'AGY_RUN_LOG_MAX_STORAGE_BYTES',
  'AGY_RUN_LOG_RETENTION_HOURS',
  'AGY_TIMEOUT_MS',
  'ALLOW_UNSANDBOXED_AUTO_APPROVE',
  'ALLOW_UNSANDBOXED_RUNS',
  'ALLOWED_CHAT_ID',
  'ALLOWED_CHAT_IDS',
  'ALLOWED_USER_IDS',
  'ALLOWED_WORKSPACE_ROOTS',
  'AUTH_FORCE_REMOTE',
  'AUTH_PRIVATE_ONLY',
  'BOT_TOKEN',
  'DATA_DIR',
  'DEFAULT_MODE',
  'DEFAULT_SANDBOX',
  'HISTORY_MAX_CHARS',
  'HISTORY_MAX_TURNS',
  'JOB_FILE',
  'JOB_HISTORY_LIMIT',
  'JOB_JOURNAL_MAX_BYTES',
  'JOB_RESPONSE_MAX_CHARS',
  'MAX_AGY_JOBS_GLOBAL_PER_WINDOW',
  'MAX_AGY_JOBS_PER_USER_PER_WINDOW',
  'MAX_AGY_RUN_LOG_FILE_BYTES',
  'MAX_AGY_RUN_LOG_STORAGE_BYTES',
  'MAX_AGY_RUNTIME_MINUTES_GLOBAL_PER_DAY',
  'MAX_AGY_RUNTIME_MINUTES_PER_USER_PER_DAY',
  'MAX_CONCURRENT_AGY',
  'MAX_INLINE_RESPONSE_CHARS',
  'MAX_PENDING_AGY_JOBS',
  'MAX_PENDING_AGY_JOBS_PER_USER',
  'MAX_REDELIVERY_BYTES',
  'MAX_RESULT_STORAGE_BYTES',
  'MAX_STATE_BYTES',
  'MAX_STATE_SESSIONS',
  'MAX_UPDATE_AGE_SECONDS',
  'MAX_UPLOAD_BYTES',
  'MAX_UPLOAD_STORAGE_BYTES',
  'OWNER_USER_IDS',
  'REQUIRE_USER_ALLOWLIST_FOR_GROUPS',
  'RESULT_RETENTION_HOURS',
  'RESULTS_DIR',
  'SANDBOX_PLAN_APPLY',
  'STATE_FILE',
  'STATE_RETENTION_HOURS',
  'TELEGRAM_UPDATE_DEDUPE_LIMIT',
  'TELEGRAM_UPDATE_DEDUPE_MAX_BYTES',
  'TELEGRAM_UPDATE_DEDUPE_RETENTION_HOURS',
  'TRUSTED_SERVICE_GROUP_GIDS',
  'UPLOAD_RETENTION_HOURS',
  'UPLOADS_DIR',
  'USAGE_FILE',
  'USAGE_RETENTION_DAYS',
  'USAGE_STORE_MAX_BYTES',
  'USAGE_WINDOW_MINUTES',
  'WINDOWS_ACL_VERIFIED',
  'WORKSPACE_DIR',
]);

function loadServiceEnvironment(
  projectDir,
  source = process.env,
  envFile = path.join(projectDir, '.env'),
  { required = false } = {},
) {
  const env = loadServiceManagerEnvironment(source);
  let parsed = {};
  try {
    parsed = dotenv.parse(readFileSync(envFile));
  } catch (error) {
    if (required || error.code !== 'ENOENT') throw error;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (SERVICE_CONFIG_KEYS.has(key)) env[key] = value;
  }
  return env;
}

function loadServiceManagerEnvironment(source = process.env) {
  const env = {};
  for (const key of SERVICE_ENV_KEYS) {
    if (source[key] != null) env[key] = source[key];
  }
  return env;
}

function verifyServiceConfig(projectDir, env, envFile = path.join(projectDir, '.env')) {
  const config = loadConfig(env, projectDir);
  if (!path.isAbsolute(config.agyBin)) {
    throw new Error(
      `agy must resolve to an absolute executable for service operation; set an absolute AGY_BIN in ${envFile}`,
    );
  }
  return config;
}

function buildDoctorArguments({ projectDir, dataDir, envFile }) {
  return [
    '--',
    path.join(projectDir, 'src', 'doctor.js'),
    ...(dataDir ? ['--data-dir', dataDir] : []),
    ...(envFile ? ['--config-file', envFile] : []),
  ];
}

async function runDoctor({
  projectDir = PROJECT_DIR,
  nodePath = process.execPath,
  env = process.env,
  envFile,
  dataDir,
} = {}) {
  return new Promise((resolve, reject) => {
    const childArguments = buildDoctorArguments({ projectDir, dataDir, envFile });
    const child = spawn(nodePath, childArguments, {
      cwd: projectDir,
      env,
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`doctor stopped by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const isHelp = (value) => value === '-h' || value === '--help';
  if (argv.length === 1 && (argv[0] === '-v' || argv[0] === '--version')) {
    process.stdout.write(`${AGYGRAM_VERSION}\n`);
    return 0;
  }
  if (argv.length === 0 || (argv.length === 1 && isHelp(argv[0]))) {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, ...commandArguments] = argv;
  if (command === 'setup') {
    if (commandArguments.length === 1 && isHelp(commandArguments[0])) {
      process.stdout.write(USAGE);
      return 0;
    }
    await setupCommand(commandArguments, { projectDir: PROJECT_DIR });
    return 0;
  }
  if (command === 'doctor') {
    if (commandArguments.length === 1 && isHelp(commandArguments[0])) {
      process.stdout.write(USAGE);
      return 0;
    }
    const doctorOptions = parseFileRunnerArguments(commandArguments);
    return runDoctor(doctorOptions);
  }
  const [action, ...rest] = commandArguments;
  if (
    command === 'service' &&
    ((isHelp(action) && rest.length === 0) ||
      (['install', 'uninstall', 'status'].includes(action) && rest.length === 1 && isHelp(rest[0])))
  ) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command !== 'service' || !['install', 'uninstall', 'status'].includes(action)) {
    throw new Error(`Unknown command: ${argv.join(' ')}`);
  }

  const options = parseOptions(rest);
  const explicitEnvFile = options.envFile != null;
  options.envFile = resolveRuntimeEnvFile({
    projectDir: options.projectDir,
    configuredEnvFile: options.envFile,
    platform: options.platform ?? process.platform,
  });
  if (options.platform && options.platform !== process.platform && !options.dryRun) {
    throw new Error('--platform may only be used with --dry-run');
  }
  if (
    !options.dryRun &&
    (options.homeDir != null || options.uid != null || options.windowsUserId != null)
  ) {
    throw new Error('--home, --uid, and --windows-user may only be used with --dry-run');
  }
  const nativeTarget = options.platform == null || options.platform === process.platform;
  let serviceEnv;
  if (nativeTarget) {
    if (action === 'uninstall') {
      // Service removal must remain possible after the external configuration
      // has been deleted, moved, or made unreadable. Never parse or execute
      // configuration on this path: the native definition is located from the
      // current user's sanitized OS environment and the explicitly pinned data
      // directory supplied by the managed uninstaller.
      options.commandEnvironment = loadServiceManagerEnvironment(process.env);
      serviceEnv = { ...options.commandEnvironment };
    } else {
      if (process.platform !== 'win32') {
        await assertRuntimeFilesystemTrust({
          envFile: options.envFile,
          dataDirectories: [],
        });
      }
      serviceEnv = loadServiceEnvironment(
        options.projectDir,
        process.env,
        options.envFile,
        { required: explicitEnvFile },
      );
      if (process.platform === 'win32') {
        await assertRuntimeFilesystemTrust({
          envFile: options.envFile,
          dataDirectories: [],
          platform: 'win32',
          windowsAclVerified: /^(?:1|true|yes|on)$/iu.test(
            serviceEnv.WINDOWS_ACL_VERIFIED || '',
          ),
        });
      }
    }
    options.environmentPath = serviceEnv.PATH;
    options.env = serviceEnv;
    options.dataDir = resolveServiceDataDir({
      projectDir: options.projectDir,
      configuredDataDir: options.dataDir,
      env: serviceEnv,
    });
    // A command-line data directory is a deliberate higher-priority pin. The
    // doctor child must validate the same layout that the service will use.
    serviceEnv.DATA_DIR = options.dataDir;
  }
  if (action === 'install' && nativeTarget) {
    const serviceConfig = verifyServiceConfig(options.projectDir, serviceEnv, options.envFile);
    options.agyBin = serviceConfig.agyBin;
    options.dataDir = serviceConfig.dataDir;
    options.trustedGroupGids = serviceConfig.trustedServiceGroupGids;
    options.environmentPath = serviceEnv.PATH;
    if (!options.dryRun) {
      // Audit every executable/source/supervisor path before launching the
      // user-selected Node binary or any code from the target checkout.
      await preflightServiceInstall(options);
      const doctorCode = await runDoctor({ ...options, env: serviceEnv });
      if (doctorCode !== 0) {
        throw new Error(`doctor failed with exit code ${doctorCode}; service was not changed`);
      }
    }
  } else if (action === 'install' && options.dryRun) {
    options.previewNote = 'cross-OS structural preview; target environment file and PATH were not read';
  }
  await manageService(action, options);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`agygram: ${error.message}\n`);
      process.exitCode = 1;
    });
}

export const _private = {
  parseOptions,
  buildDoctorArguments,
  runDoctor,
  loadServiceEnvironment,
  loadServiceManagerEnvironment,
  verifyServiceConfig,
  PROJECT_DIR,
  SERVICE_ENV_KEYS,
  SERVICE_CONFIG_KEYS,
  USAGE,
};
