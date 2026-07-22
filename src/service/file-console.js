import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export function rotateLogFile(logFile, maxBytes = DEFAULT_MAX_BYTES) {
  let size;
  try {
    size = statSync(logFile).size;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (size < maxBytes) return false;

  const previous = `${logFile}.1`;
  if (size > maxBytes) truncateSync(logFile, maxBytes);
  rmSync(previous, { force: true });
  renameSync(logFile, previous);
  return true;
}

function forceRotateLogFile(logFile) {
  const previous = `${logFile}.1`;
  try {
    rmSync(previous, { force: true });
    renameSync(logFile, previous);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function fileSize(logFile) {
  try {
    return statSync(logFile).size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export function formatLogLine(level, args, now = new Date()) {
  const entry = {
    time: now.toISOString(),
    level: level === 'log' ? 'info' : level,
    pid: process.pid,
    msg: util.format(...args),
  };
  return `${JSON.stringify(entry)}\n`;
}

export function appendBoundedLog(logFile, value, maxBytes = DEFAULT_MAX_BYTES) {
  if (!path.isAbsolute(logFile)) throw new Error('logFile must be absolute');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('maxBytes must be a positive integer');
  }
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path.dirname(logFile), 0o700);
  let body = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (body.length > maxBytes) body = body.subarray(0, maxBytes);
  rotateLogFile(logFile, maxBytes);
  const currentSize = fileSize(logFile);
  if (currentSize > 0 && currentSize + body.length > maxBytes) {
    forceRotateLogFile(logFile);
  }
  appendFileSync(logFile, body, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(logFile, 0o600);
}

/**
 * Keep one bounded, user-private log while retaining the original console
 * methods for interactive diagnostics.
 */
export function installFileConsole({
  logFile,
  maxBytes = DEFAULT_MAX_BYTES,
  target = console,
} = {}) {
  if (!path.isAbsolute(logFile)) throw new Error('logFile must be absolute');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('maxBytes must be a positive integer');
  }
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path.dirname(logFile), 0o700);
  rotateLogFile(logFile, maxBytes);
  try {
    chmodSync(logFile, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let currentSize = fileSize(logFile);

  const originals = new Map();
  const levels = ['debug', 'info', 'log', 'warn', 'error'];
  for (const level of levels) {
    const original = target[level].bind(target);
    originals.set(level, target[level]);
    target[level] = (...args) => {
      try {
        let body = Buffer.from(formatLogLine(level, args), 'utf8');
        if (body.length > maxBytes) {
          body = body.subarray(0, maxBytes);
        }
        if (currentSize > 0 && currentSize + body.length > maxBytes) {
          forceRotateLogFile(logFile);
          currentSize = 0;
        }
        appendFileSync(logFile, body, { mode: 0o600 });
        currentSize += body.length;
      } catch (error) {
        original(`Unable to append service log: ${error.message}`);
      }
      original(...args);
    };
  }

  return () => {
    for (const [level, original] of originals) target[level] = original;
  };
}

export const _private = { DEFAULT_MAX_BYTES, fileSize, forceRotateLogFile };
