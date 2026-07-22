import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

import { appendBoundedLog, installFileConsole } from './file-console.js';
import {
  buildServiceRuntimePaths,
  parseFileRunnerArguments,
  resolveRuntimeEnvFile,
  resolveServiceDataDir,
} from './runtime-paths.js';
import { clearStaleServiceStopRequest } from './stop-request.js';
import { assertRuntimeFilesystemTrust } from '../runtime-trust.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bootstrapIdentity = process.getuid?.() ?? createHash('sha256')
  .update(os.homedir())
  .digest('hex')
  .slice(0, 16);
const bootstrapDirectory = path.join(os.tmpdir(), `agygram-bootstrap-${bootstrapIdentity}`);
const bootstrapLog = path.join(bootstrapDirectory, 'bootstrap.log');
let loggerReady = false;
try {
  const runnerOptions = parseFileRunnerArguments(process.argv.slice(2));
  const envFile = resolveRuntimeEnvFile({
    projectDir,
    configuredEnvFile: runnerOptions.envFile,
  });
  if (process.platform !== 'win32') {
    await assertRuntimeFilesystemTrust({
      envFile,
      dataDirectories: [],
    });
  }
  const serviceEnv = {};
  const environmentResult = dotenv.config({
    path: envFile,
    processEnv: serviceEnv,
    override: true,
    quiet: true,
  });
  if (runnerOptions.envFile && environmentResult.error) throw environmentResult.error;
  if (process.platform === 'win32') {
    await assertRuntimeFilesystemTrust({
      envFile,
      dataDirectories: [],
      platform: 'win32',
      windowsAclVerified: /^(?:1|true|yes|on)$/iu.test(
        serviceEnv.WINDOWS_ACL_VERIFIED || '',
      ),
    });
  }
  const dataDir = resolveServiceDataDir({
    projectDir,
    configuredDataDir: runnerOptions.dataDir,
    env: { ...process.env, ...serviceEnv },
  });
  const runtimePaths = buildServiceRuntimePaths(dataDir);
  process.env.DATA_DIR = dataDir;
  process.env.AGYGRAM_SERVICE_STOP_REQUEST_PATH = runtimePaths.stopRequestPath;
  await clearStaleServiceStopRequest(runtimePaths.stopRequestPath);

  let pinnedEnv = {};
  try {
    pinnedEnv = JSON.parse(readFileSync(
      runtimePaths.environmentPath,
      'utf8',
    ));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const servicePath = pinnedEnv.PATH ?? serviceEnv.PATH;
  if (typeof servicePath === 'string' && servicePath) process.env.PATH = servicePath;
  process.env.NODE_ENV = typeof pinnedEnv.NODE_ENV === 'string'
    ? pinnedEnv.NODE_ENV
    : 'production';
  installFileConsole({ logFile: runtimePaths.logPath });
  loggerReady = true;
  process.on('warning', (warning) => console.warn('Process warning', warning));
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    console.error(`Uncaught exception (${origin})`, error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection', reason);
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
  await import('../index.js');
} catch (error) {
  if (loggerReady) {
    console.error('Fatal service bootstrap error', error);
  } else {
    const line = `${new Date().toISOString()} Fatal service bootstrap error: ${error.stack || error}\n`;
    try {
      mkdirSync(bootstrapDirectory, { recursive: true, mode: 0o700 });
      const directoryInfo = lstatSync(bootstrapDirectory);
      const uid = process.getuid?.();
      if (
        !directoryInfo.isDirectory() ||
        directoryInfo.isSymbolicLink() ||
        (Number.isSafeInteger(uid) && directoryInfo.uid !== uid)
      ) {
        throw new Error('bootstrap log directory is not private to this service user');
      }
      if (process.platform !== 'win32') chmodSync(bootstrapDirectory, 0o700);
      appendBoundedLog(bootstrapLog, line, 1024 * 1024);
      process.stderr.write(`Fatal service bootstrap error; details: ${bootstrapLog}\n`);
    } catch {
      process.stderr.write('Fatal service bootstrap error; fallback logging failed.\n');
    }
  }
  process.exitCode = 1;
}
