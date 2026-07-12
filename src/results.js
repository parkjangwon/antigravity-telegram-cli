import { randomUUID } from 'node:crypto';
import { open, lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[0-9a-f-]{8,64}$/i;
const RESULT_FILE = /^([0-9a-f-]{8,64})\.txt$/i;
const RESULT_TEMP_FILE = /^([0-9a-f-]{8,64})\.txt\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/i;
const LEGACY_RESULT_TEMP_FILE = /^([0-9a-f-]{8,64})\.txt\.\d+\.part$/i;

export function isResultTemporaryFileName(name) {
  return typeof name === 'string' &&
    (RESULT_TEMP_FILE.test(name) || LEGACY_RESULT_TEMP_FILE.test(name));
}

function resultPath(directory, jobId) {
  const id = String(jobId || '');
  if (!SAFE_ID.test(id)) throw new Error('Invalid result job ID');
  return path.join(directory, `${id}.txt`);
}

async function syncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Opening or syncing a directory is unsupported on Windows and on some
    // filesystems. The file itself is still fsynced before the atomic rename.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(file, text) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.part`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await syncDirectoryBestEffort(path.dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export class ResultStore {
  #directory;
  #maxResultBytes;
  #maxTotalBytes;
  #retentionMs;
  #leases = new Map();
  #writeChain = Promise.resolve();

  constructor(directory, {
    maxResultBytes = 2 * 1024 * 1024,
    maxTotalBytes = 200 * 1024 * 1024,
    retentionMs = 24 * 60 * 60 * 1_000,
  } = {}) {
    for (const [name, value] of Object.entries({ maxResultBytes, maxTotalBytes, retentionMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
    }
    if (maxResultBytes > maxTotalBytes) {
      throw new RangeError('maxResultBytes must not exceed maxTotalBytes');
    }
    this.#directory = path.resolve(directory);
    this.#maxResultBytes = maxResultBytes;
    this.#maxTotalBytes = maxTotalBytes;
    this.#retentionMs = retentionMs;
  }

  async init({ cleanup = true } = {}) {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (cleanup) await this.cleanup();
    return this;
  }

  async save(jobId, text) {
    return this.#save(jobId, text, { acquire: false });
  }

  /**
   * Persist a result and pin it before another queued cleanup can run.
   *
   * Callers must await `release()`. This is used by result delivery so a
   * concurrent save cannot evict the file between persistence and Telegram
   * opening/finishing the upload.
   */
  async saveAndAcquire(jobId, text) {
    return this.#save(jobId, text, { acquire: true });
  }

  async #save(jobId, text, { acquire }) {
    return this.#enqueueWrite(async () => {
      const id = String(jobId || '');
      const file = resultPath(this.#directory, id);
      const value = String(text ?? '');
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > this.#maxResultBytes) {
        const error = new Error(`Result exceeds the per-result limit (${bytes} bytes)`);
        error.code = 'RESULT_TOO_LARGE';
        throw error;
      }
      if (this.#leases.has(id)) {
        const error = new Error('Cannot replace a result while it is in use');
        error.code = 'RESULT_IN_USE';
        throw error;
      }
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await atomicWrite(file, value);
      const cleanup = await this.#cleanup({ protectedJobId: id });
      if (cleanup.remainingBytes > this.#maxTotalBytes) {
        // Existing active readers/deliveries win over the new result. Rolling
        // the new file back avoids deleting a result that Telegram is still
        // consuming (and also behaves correctly on Windows, where an opened
        // file commonly cannot be unlinked).
        await rm(file, { force: true });
        const error = new Error('Result storage quota cannot accommodate this result');
        error.code = 'RESULT_QUOTA_EXCEEDED';
        throw error;
      }
      if (!acquire) return undefined;
      const info = await stat(file);
      return this.#createLease(id, { file, size: info.size, mtimeMs: info.mtimeMs });
    });
  }

  async read(jobId) {
    const lease = await this.acquire(jobId);
    try {
      return await readFile(lease.file, 'utf8');
    } finally {
      await lease.release();
    }
  }

  /**
   * Atomically acquire a descriptor lease with respect to save/remove/cleanup.
   * The returned file remains protected until its idempotent `release()` has
   * completed.
   */
  async acquire(jobId) {
    return this.#enqueueWrite(async () => {
      const id = String(jobId || '');
      const descriptor = await this.#describe(id);
      return this.#createLease(id, descriptor);
    });
  }

  async #describe(jobId) {
    const file = resultPath(this.#directory, jobId);
    const info = await stat(file);
    if (info.size > this.#maxResultBytes) throw new Error('Stored result exceeds the configured limit');
    return { file, size: info.size, mtimeMs: info.mtimeMs };
  }

  async remove(jobId) {
    return this.#enqueueWrite(() => {
      const id = String(jobId || '');
      if (this.#leases.has(id)) {
        const error = new Error('Cannot remove a result while it is in use');
        error.code = 'RESULT_IN_USE';
        throw error;
      }
      return rm(resultPath(this.#directory, id), { force: true });
    });
  }

  async cleanup({ protectedJobId = null, now = Date.now() } = {}) {
    return this.#enqueueWrite(() => this.#cleanup({ protectedJobId, now }));
  }

  async #cleanup({ protectedJobId = null, now = Date.now() } = {}) {
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return { removedFiles: 0, removedBytes: 0, remainingBytes: 0 };
      throw error;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const resultMatch = RESULT_FILE.exec(entry.name);
      const temporary = isResultTemporaryFileName(entry.name);
      if (!resultMatch && !temporary) continue;
      const file = path.join(this.#directory, entry.name);
      const info = await lstat(file).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) {
        files.push({
          file,
          id: resultMatch?.[1] || null,
          temporary,
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      }
    }
    let remainingBytes = files.reduce((total, file) => total + file.size, 0);
    let removedBytes = 0;
    let removedFiles = 0;
    const removed = new Set();
    const removeFile = async (file) => {
      if (
        (!file.temporary && (file.id === protectedJobId || this.#leases.has(file.id)))
        || removed.has(file.file)
      ) return;
      await rm(file.file, { force: true });
      removed.add(file.file);
      removedFiles += 1;
      removedBytes += file.size;
      remainingBytes = Math.max(0, remainingBytes - file.size);
    };
    for (const file of files) {
      if (now - file.mtimeMs >= this.#retentionMs) await removeFile(file);
    }
    for (const file of files
      .filter((entry) => !removed.has(entry.file))
      .sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (remainingBytes <= this.#maxTotalBytes) break;
      await removeFile(file);
    }
    return { removedFiles, removedBytes, remainingBytes };
  }

  #createLease(jobId, descriptor) {
    this.#leases.set(jobId, (this.#leases.get(jobId) || 0) + 1);
    let releasePromise = null;
    return Object.freeze({
      ...descriptor,
      release: () => {
        if (!releasePromise) {
          releasePromise = this.#enqueueWrite(() => {
            const count = this.#leases.get(jobId) || 0;
            if (count <= 1) this.#leases.delete(jobId);
            else this.#leases.set(jobId, count - 1);
          });
        }
        return releasePromise;
      },
    });
  }

  #enqueueWrite(operation) {
    const result = this.#writeChain.then(operation, operation);
    this.#writeChain = result.catch(() => {});
    return result;
  }
}
