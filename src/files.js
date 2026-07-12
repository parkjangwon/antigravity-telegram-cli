import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const uploadStorageStates = new Map();

function uploadStorageState(uploadsDir) {
  const key = path.resolve(uploadsDir);
  let state = uploadStorageStates.get(key);
  if (!state) {
    state = {
      reservations: new Map(),
      lockTail: Promise.resolve(),
    };
    uploadStorageStates.set(key, state);
  }
  return state;
}

async function withStorageLock(state, operation) {
  const previous = state.lockTail;
  let unlock;
  state.lockTail = new Promise((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
  }
}

function safeFilename(name) {
  let base = path.basename(String(name || 'upload.bin'))
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^\.+$/, 'upload.bin')
    .slice(0, 120);
  const stem = base.split('.')[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) base = `_${base}`;
  return base || 'upload.bin';
}

function safeScopeId(value) {
  const scopeId = String(value ?? '').normalize('NFKC');
  if (
    !scopeId ||
    scopeId === '.' ||
    scopeId === '..' ||
    scopeId.length > 200 ||
    !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/.test(scopeId)
  ) {
    throw new Error('Invalid upload scope');
  }
  return scopeId;
}

function abortError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function createCombinedAbort(signal, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Upload timeout must be a positive number');
  }

  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(abortError(signal));
  };

  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('Telegram file download timed out', 'TimeoutError'));
    }
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function waitForAbortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(signal));

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function inspectDirectory(directory) {
  let size = 0;
  let lastModifiedMs = 0;
  let hasPart = false;
  const stack = [directory];

  while (stack.length > 0) {
    const current = stack.pop();
    let currentStat;
    let entries;
    try {
      [currentStat, entries] = await Promise.all([
        lstat(current),
        readdir(current, { withFileTypes: true }),
      ]);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    lastModifiedMs = Math.max(lastModifiedMs, currentStat.mtimeMs);

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      let entryStat;
      try {
        entryStat = await lstat(entryPath);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }

      lastModifiedMs = Math.max(lastModifiedMs, entryStat.mtimeMs);
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) stack.push(entryPath);
      else if (entryStat.isFile()) {
        size += entryStat.size;
        if (entry.name.endsWith('.part')) hasPart = true;
      }
    }
  }

  return { size, lastModifiedMs, hasPart };
}

async function collectUploadEntries(uploadsDir) {
  let rootEntries;
  try {
    rootEntries = await readdir(uploadsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { entries: [], scopeDirectories: [] };
    throw error;
  }

  const entries = [];
  const scopeDirectories = [];
  for (const rootEntry of rootEntries) {
    const scopePath = path.join(uploadsDir, rootEntry.name);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) continue;
    scopeDirectories.push(scopePath);

    let scopeEntries;
    try {
      scopeEntries = await readdir(scopePath, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }

    for (const entry of scopeEntries) {
      const entryPath = path.join(scopePath, entry.name);
      let metadata;
      try {
        metadata = await lstat(entryPath);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (metadata.isSymbolicLink()) continue;

      if (metadata.isDirectory()) {
        const details = await inspectDirectory(entryPath);
        entries.push({ path: entryPath, directory: true, ...details });
      } else if (metadata.isFile()) {
        // Compatibility with uploads written before per-job directories existed.
        entries.push({
          path: entryPath,
          directory: false,
          size: metadata.size,
          lastModifiedMs: metadata.mtimeMs,
          hasPart: entry.name.endsWith('.part'),
        });
      }
    }
  }

  return { entries, scopeDirectories };
}

function storageQuotaError(message = 'Upload storage quota is currently exhausted') {
  const error = new Error(message);
  error.code = 'UPLOAD_STORAGE_QUOTA';
  return error;
}

async function cleanupUploadEntries(
  uploadsDir,
  {
    retentionMs,
    maxTotalBytes,
    activeLeaseMaxAgeMs,
    protectedPaths = new Set(),
    quotaExcludedPaths = new Set(),
  },
) {
  if ((retentionMs !== Number.POSITIVE_INFINITY && (!Number.isFinite(retentionMs) || retentionMs < 0)) ||
      (maxTotalBytes !== Number.POSITIVE_INFINITY && (!Number.isFinite(maxTotalBytes) || maxTotalBytes < 0)) ||
      !Number.isFinite(activeLeaseMaxAgeMs) || activeLeaseMaxAgeMs < 0) {
    throw new Error('Upload retention and quota values must be non-negative numbers');
  }

  const normalizedProtectedPaths = new Set([...protectedPaths].map((entry) => path.resolve(entry)));
  const normalizedExcludedPaths = new Set([...quotaExcludedPaths].map((entry) => path.resolve(entry)));
  const { entries, scopeDirectories } = await collectUploadEntries(uploadsDir);
  let remainingBytes = entries.reduce((total, entry) => total + entry.size, 0);
  let accountedBytes = entries.reduce(
    (total, entry) => total + (normalizedExcludedPaths.has(path.resolve(entry.path)) ? 0 : entry.size),
    0,
  );
  let reclaimedBytes = 0;
  let removedEntries = 0;
  const removed = new Set();
  const now = Date.now();
  const cutoff = Number.isFinite(retentionMs) ? now - retentionMs : Number.NEGATIVE_INFINITY;
  const isProtected = (entry) => normalizedProtectedPaths.has(path.resolve(entry.path));
  const isQuotaExcluded = (entry) => normalizedExcludedPaths.has(path.resolve(entry.path));
  const hasFreshLease = (entry) =>
    entry.hasPart && now - entry.lastModifiedMs < activeLeaseMaxAgeMs;

  const removeEntry = async (entry) => {
    if (removed.has(entry.path)) return;
    try {
      await rm(entry.path, { recursive: entry.directory, force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    removed.add(entry.path);
    remainingBytes = Math.max(0, remainingBytes - entry.size);
    if (!isQuotaExcluded(entry)) accountedBytes = Math.max(0, accountedBytes - entry.size);
    reclaimedBytes += entry.size;
    removedEntries += 1;
  };

  for (const entry of entries) {
    if (entry.lastModifiedMs <= cutoff && !isProtected(entry) && !hasFreshLease(entry)) {
      await removeEntry(entry);
    }
  }

  if (Number.isFinite(maxTotalBytes) && accountedBytes > maxTotalBytes) {
    const oldestFirst = entries
      // A crash can leave a .part lease behind. Only a fresh lease is allowed
      // to reserve quota; stale leases are ordinary eviction candidates.
      .filter((entry) =>
        !removed.has(entry.path) &&
        !isProtected(entry) &&
        !isQuotaExcluded(entry) &&
        !hasFreshLease(entry))
      .sort((left, right) => left.lastModifiedMs - right.lastModifiedMs || left.path.localeCompare(right.path));
    for (const entry of oldestFirst) {
      if (accountedBytes <= maxTotalBytes) break;
      await removeEntry(entry);
    }
  }

  for (const scopeDirectory of scopeDirectories) {
    // Non-recursive removal only succeeds when cleanup left the scope empty.
    await rmdir(scopeDirectory).catch(() => {});
  }

  return { removedEntries, reclaimedBytes, remainingBytes, accountedBytes };
}

async function reserveUploadStorage(
  uploadsDir,
  jobDirectory,
  requestedBytes,
  { retentionMs, maxTotalBytes, activeLeaseMaxAgeMs },
) {
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) {
    throw new Error('Upload reservation must be a non-negative safe integer');
  }
  const state = uploadStorageState(uploadsDir);
  const token = randomUUID();

  await withStorageLock(state, async () => {
    const reservedBytes = [...state.reservations.values()]
      .reduce((total, reservation) => total + reservation.bytes, 0);
    const availableForCommittedFiles = Number.isFinite(maxTotalBytes)
      ? maxTotalBytes - reservedBytes - requestedBytes
      : Number.POSITIVE_INFINITY;
    if (availableForCommittedFiles < 0) throw storageQuotaError();

    const activePaths = new Set(
      [...state.reservations.values()].map((reservation) => reservation.jobDirectory),
    );
    const cleanup = await cleanupUploadEntries(uploadsDir, {
      retentionMs,
      maxTotalBytes: availableForCommittedFiles,
      activeLeaseMaxAgeMs,
      protectedPaths: activePaths,
      quotaExcludedPaths: activePaths,
    });
    if (cleanup.accountedBytes > availableForCommittedFiles) {
      throw storageQuotaError('Upload storage quota is currently exhausted by active jobs');
    }

    state.reservations.set(token, {
      bytes: requestedBytes,
      jobDirectory: path.resolve(jobDirectory),
    });
  });

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await withStorageLock(state, async () => {
      state.reservations.delete(token);
    });
  };
}

export async function downloadTelegramFile(
  ctx,
  { fileId, fileName, fileSize },
  {
    uploadsDir,
    maxBytes,
    signal,
    scopeId = String(ctx.chat.id),
    timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    retentionMs = Number.POSITIVE_INFINITY,
    maxTotalBytes = Number.POSITIVE_INFINITY,
    activeLeaseMaxAgeMs = 2 * 60 * 60 * 1_000,
  },
) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('Upload size limit must be a positive number');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Upload timeout must be a positive number');
  }
  if (maxTotalBytes !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0)) {
    throw new Error('Upload storage quota must be a non-negative safe integer');
  }
  if (Number.isFinite(fileSize) && fileSize > maxBytes) {
    throw new Error(`파일이 제한(${Math.floor(maxBytes / 1_000_000)} MB)을 초과합니다.`);
  }

  const scopeDirectory = path.join(uploadsDir, safeScopeId(scopeId));
  const jobDirectory = path.join(scopeDirectory, `${Date.now()}-${randomUUID()}`);
  const finalPath = path.join(jobDirectory, safeFilename(fileName));
  const temporaryPath = `${finalPath}.part`;
  const leasePath = path.join(jobDirectory, '.active.part');
  const abortContext = createCombinedAbort(signal, timeoutMs);
  const hasDeclaredSize = Number.isSafeInteger(fileSize) && fileSize >= 0;
  const reservedBytes = hasDeclaredSize ? fileSize : maxBytes;
  let releaseReservation;

  try {
    // This process is protected by the application-wide single-instance lock.
    // Reserving under a process-local mutex therefore closes the check/write race
    // between concurrent Telegram downloads without needing a portable file lock.
    releaseReservation = await reserveUploadStorage(
      uploadsDir,
      jobDirectory,
      reservedBytes,
      { retentionMs, maxTotalBytes, activeLeaseMaxAgeMs },
    );
    await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
    await writeFile(leasePath, '', { flag: 'wx', mode: 0o600 });
    const getFileLink = async () => {
      if (typeof ctx.telegram.callApi !== 'function') {
        return ctx.telegram.getFileLink(fileId);
      }
      const file = await ctx.telegram.callApi(
        'getFile',
        { file_id: fileId },
        { signal: abortContext.signal },
      );
      if (!file?.file_path) throw new Error('Telegram file metadata did not include a download path');
      // Passing the resolved metadata prevents getFileLink() from making a
      // second high-level API request that cannot receive an AbortSignal.
      return ctx.telegram.getFileLink(file);
    };
    const link = await waitForAbortable(
      Promise.resolve().then(getFileLink),
      abortContext.signal,
    );
    const response = await waitForAbortable(
      fetch(link, { redirect: 'follow', signal: abortContext.signal }),
      abortContext.signal,
    );
    if (!response.ok || !response.body) {
      throw new Error(`Telegram file download failed (${response.status})`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`파일이 제한(${Math.floor(maxBytes / 1_000_000)} MB)을 초과합니다.`);
    }
    if (Number.isFinite(contentLength) && contentLength > reservedBytes) {
      throw new Error('Telegram file exceeded its declared size');
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) callback(new Error('File exceeded the configured upload limit'));
        else if (received > reservedBytes) callback(new Error('Telegram file exceeded its declared size'));
        else callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
      { signal: abortContext.signal },
    );
    await rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    // Remove the whole job directory so a failed transfer cannot leak a .part file
    // or accidentally become visible through a later --add-dir invocation.
    await rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    abortContext.cleanup();
    await releaseReservation?.();
  }
}

export async function cleanupExpiredUploads(
  uploadsDir,
  {
    retentionMs = Number.POSITIVE_INFINITY,
    maxTotalBytes = Number.POSITIVE_INFINITY,
    activeLeaseMaxAgeMs = 2 * 60 * 60 * 1_000,
  } = {},
) {
  const state = uploadStorageState(uploadsDir);
  return withStorageLock(state, async () => {
    const reservations = [...state.reservations.values()];
    const reservedBytes = reservations.reduce((total, reservation) => total + reservation.bytes, 0);
    const activePaths = new Set(reservations.map((reservation) => reservation.jobDirectory));
    const committedQuota = Number.isFinite(maxTotalBytes)
      ? Math.max(0, maxTotalBytes - reservedBytes)
      : Number.POSITIVE_INFINITY;
    const { accountedBytes: _accountedBytes, ...result } = await cleanupUploadEntries(uploadsDir, {
      retentionMs,
      maxTotalBytes: committedQuota,
      activeLeaseMaxAgeMs,
      protectedPaths: activePaths,
      quotaExcludedPaths: activePaths,
    });
    return result;
  });
}

export async function clearChatUploads(uploadsDir, chatId) {
  await rm(path.join(uploadsDir, safeScopeId(chatId)), { recursive: true, force: true });
}

export async function releaseUploadLease(filePath) {
  await rm(path.join(path.dirname(filePath), '.active.part'), { force: true });
}

export const _private = {
  createCombinedAbort,
  safeFilename,
  safeScopeId,
  waitForAbortable,
};
