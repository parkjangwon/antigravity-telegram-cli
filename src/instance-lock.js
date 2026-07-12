import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const LOCK_VERSION = 1;
const MAX_LOCK_BYTES = 4_096;
const DEFAULT_MALFORMED_GRACE_MS = 100;

export class InstanceLockError extends Error {
  constructor(message, { code, lockPath, ownerPid = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InstanceLockError';
    this.code = code ?? 'INSTANCE_LOCK_ERROR';
    this.lockPath = lockPath ?? null;
    this.ownerPid = ownerPid;
  }
}

/**
 * Acquire an exclusive, process-level lock.
 *
 * The returned file handle intentionally stays open until release(). A random
 * token in the file prevents an old owner from deleting a replacement lock.
 */
export async function acquireInstanceLock(
  lockPath,
  {
    pid = process.pid,
    token = randomUUID(),
    processAlive = isProcessAlive,
    malformedGraceMs = DEFAULT_MALFORMED_GRACE_MS,
  } = {},
) {
  if (typeof lockPath !== 'string' || lockPath.length === 0) {
    throw new TypeError('lockPath must be a non-empty string');
  }
  if (!isValidPid(pid)) {
    throw new TypeError('pid must be a positive integer');
  }
  if (typeof token !== 'string' || token.length < 8) {
    throw new TypeError('token must be a string with at least 8 characters');
  }
  if (!Number.isFinite(malformedGraceMs) || malformedGraceMs < 0) {
    throw new TypeError('malformedGraceMs must be a non-negative number');
  }

  const resolvedPath = path.resolve(lockPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });

  const owner = {
    version: LOCK_VERSION,
    pid,
    token,
    createdAt: new Date().toISOString(),
  };

  try {
    return await createLock(resolvedPath, owner);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw wrapIoError(error, resolvedPath, 'create');
  }

  let snapshot = await inspectLock(resolvedPath, processAlive);

  // A process that just won open('wx') has a very small window before its JSON
  // payload is written. Give that writer time to finish before treating an
  // empty or partial file as abandoned.
  if (snapshot.kind === 'malformed') {
    const ageMs = Math.max(0, Date.now() - snapshot.stat.mtimeMs);
    const waitMs = Math.max(0, malformedGraceMs - ageMs);
    if (waitMs > 0) {
      await delay(waitMs);
      snapshot = await inspectLock(resolvedPath, processAlive);
    }
  }

  if (snapshot.kind === 'active') {
    throw alreadyRunningError(resolvedPath, snapshot.owner.pid);
  }

  if (snapshot.kind !== 'missing') {
    const removed = await removeUnchangedSnapshot(resolvedPath, snapshot);
    if (!removed) {
      throw new InstanceLockError(
        `Instance lock changed while stale-lock recovery was in progress: ${resolvedPath}`,
        { code: 'INSTANCE_LOCK_RACE', lockPath: resolvedPath },
      );
    }
  }

  // Reclamation is attempted exactly once. If another process wins after it,
  // report the winner instead of deleting a second lock.
  try {
    return await createLock(resolvedPath, owner);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw wrapIoError(error, resolvedPath, 'create');
  }

  const winner = await inspectLock(resolvedPath, processAlive);
  if (winner.kind === 'active') {
    throw alreadyRunningError(resolvedPath, winner.owner.pid);
  }
  throw new InstanceLockError(
    `Another process acquired the instance lock during recovery: ${resolvedPath}`,
    { code: 'INSTANCE_LOCK_RACE', lockPath: resolvedPath },
  );
}

async function createLock(lockPath, owner) {
  let fileHandle;
  try {
    fileHandle = await open(lockPath, 'wx', 0o600);
    await fileHandle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await fileHandle.sync();
    const ownedStat = await fileHandle.stat();
    return makeLockHandle(lockPath, owner, fileHandle, ownedStat);
  } catch (error) {
    if (fileHandle) {
      const ownedStat = await fileHandle.stat().catch(() => null);
      await fileHandle.close().catch(() => {});
      if (ownedStat) await removeOwnedPath(lockPath, owner, ownedStat).catch(() => {});
    }
    throw error;
  }
}

function makeLockHandle(lockPath, owner, fileHandle, ownedStat) {
  let released = false;

  return Object.freeze({
    path: lockPath,
    pid: owner.pid,
    token: owner.token,
    async release() {
      if (released) return false;
      released = true;

      try {
        return await removeOwnedPath(lockPath, owner, ownedStat);
      } finally {
        await fileHandle.close().catch(() => {});
      }
    },
  });
}

async function removeOwnedPath(lockPath, owner, ownedStat) {
  let currentStat;
  let raw;
  try {
    currentStat = await lstat(lockPath);
    if (!sameFileIdentity(ownedStat, currentStat) || !currentStat.isFile()) return false;
    raw = await readFileLimited(lockPath, currentStat);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  const currentOwner = parseOwner(raw);
  if (currentOwner?.pid !== owner.pid || currentOwner?.token !== owner.token) return false;

  // Recheck after reading so an unlink never follows a detected replacement.
  const finalStat = await lstat(lockPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!finalStat || !sameFileIdentity(ownedStat, finalStat)) return false;

  await unlink(lockPath);
  return true;
}

async function inspectLock(lockPath, processAlive) {
  let stat;
  try {
    stat = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    throw wrapIoError(error, lockPath, 'inspect');
  }

  if (!stat.isFile()) {
    return { kind: 'malformed', raw: null, stat };
  }

  let raw;
  try {
    raw = await readFileLimited(lockPath, stat);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    throw wrapIoError(error, lockPath, 'read');
  }

  const finalStat = await lstat(lockPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!finalStat) return { kind: 'missing' };
  if (!sameFileIdentity(stat, finalStat)) {
    return { kind: 'changed', raw, stat };
  }

  const owner = parseOwner(raw);
  if (!owner) return { kind: 'malformed', raw, stat: finalStat };

  let alive;
  try {
    alive = await processAlive(owner.pid);
  } catch (error) {
    throw new InstanceLockError(`Could not verify lock owner PID ${owner.pid}: ${lockPath}`, {
      code: 'INSTANCE_LOCK_PID_CHECK_FAILED',
      lockPath,
      ownerPid: owner.pid,
      cause: error,
    });
  }
  return alive
    ? { kind: 'active', raw, stat: finalStat, owner }
    : { kind: 'stale', raw, stat: finalStat, owner };
}

async function removeUnchangedSnapshot(lockPath, snapshot) {
  if (snapshot.kind === 'changed') return false;

  let currentStat;
  try {
    currentStat = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw wrapIoError(error, lockPath, 'reclaim');
  }

  if (!sameFileIdentity(snapshot.stat, currentStat)) return false;

  if (currentStat.isFile()) {
    const currentRaw = await readFileLimited(lockPath, currentStat).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (currentRaw === null) return true;
    if (currentRaw !== snapshot.raw) return false;
  } else if (!currentStat.isSymbolicLink()) {
    throw new InstanceLockError(`Refusing to remove non-file instance lock path: ${lockPath}`, {
      code: 'INSTANCE_LOCK_UNSAFE_PATH',
      lockPath,
    });
  }

  const finalStat = await lstat(lockPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!finalStat) return true;
  if (!sameFileIdentity(snapshot.stat, finalStat)) return false;

  await unlink(lockPath);
  return true;
}

async function readFileLimited(lockPath, stat) {
  if (stat.size > MAX_LOCK_BYTES) return null;
  return readFile(lockPath, 'utf8');
}

function parseOwner(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const value = JSON.parse(raw);
    if (
      value?.version !== LOCK_VERSION ||
      !isValidPid(value.pid) ||
      typeof value.token !== 'string' ||
      value.token.length < 8
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isValidPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  if (left.ino !== 0 && right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  // Some Windows filesystems report inode 0. Refuse deletion unless the
  // fallback identity also matches exactly.
  return (
    left.dev === right.dev &&
    left.birthtimeMs === right.birthtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.size === right.size
  );
}

function isProcessAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM is the normal cross-user response on POSIX and may also be
    // surfaced by Windows: the process exists, but cannot be signalled.
    if (error?.code === 'EPERM') return true;
    // Unknown platform errors fail closed so a possibly-live lock is kept.
    return true;
  }
}

function alreadyRunningError(lockPath, ownerPid) {
  return new InstanceLockError(
    `Another antigravity-telegram-cli instance is already running (PID ${ownerPid}; lock: ${lockPath})`,
    { code: 'INSTANCE_ALREADY_RUNNING', lockPath, ownerPid },
  );
}

function wrapIoError(error, lockPath, operation) {
  if (error instanceof InstanceLockError) return error;
  return new InstanceLockError(`Could not ${operation} instance lock: ${lockPath}`, {
    code: 'INSTANCE_LOCK_IO',
    lockPath,
    cause: error,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const _private = {
  isProcessAlive,
  parseOwner,
  sameFileIdentity,
};
