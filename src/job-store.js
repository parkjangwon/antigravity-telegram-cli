import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const DEFAULT_UPDATE_TOMBSTONE_RETENTION_MS = 48 * 60 * 60 * 1_000;
const DEFAULT_MAX_UPDATE_TOMBSTONES = 10_000;
const DEFAULT_MAX_UPDATE_TOMBSTONE_BYTES = 4 * 1024 * 1024;
const REJECTED_TOMBSTONE_BUCKET_MS = 60 * 60 * 1_000;
const RESTART_INTERRUPTION_CODE = 'PROCESS_RESTART';
const RECONCILED_INTERRUPTION_CODE = 'PROCESS_RESTART_RECONCILED';
const RESTART_RECONCILIATION_REASONS = new Set(['result-missing', 'unexpected-result']);
const TOMBSTONE_DECISIONS = new Set(['pruned', 'rejected']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const JOB_STATUSES = new Set(['queued', 'running', ...TERMINAL_STATUSES]);
const LEGAL_TRANSITIONS = new Map([
  ['queued', new Set(['queued', 'running', 'cancelled', 'interrupted'])],
  ['running', new Set(['running', 'succeeded', 'failed', 'cancelled', 'interrupted'])],
  ['succeeded', new Set(['succeeded'])],
  ['failed', new Set(['failed'])],
  ['cancelled', new Set(['cancelled'])],
  ['interrupted', new Set(['interrupted'])],
]);
const SENSITIVE_KEY_SUFFIXES = ['token', 'secret', 'password', 'credential', 'cookie', 'apikey'];
const AUDIT_IDENTIFIER_KEYS = [
  'actorUserId',
  'actorChatId',
  'telegramMessageId',
  'telegramUpdateId',
];

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSensitiveKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'authorization'
    || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function truncateUnicode(value, maxChars) {
  if (value.length <= maxChars) return { value, truncated: false, originalChars: value.length };
  let end = maxChars;
  if (end > 0) {
    const lastCodeUnit = value.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  }
  return { value: value.slice(0, end), truncated: true, originalChars: value.length };
}

function redactString(value, secrets, maxChars) {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.split(secret).join('[REDACTED]');
  return truncateUnicode(redacted, maxChars).value;
}

/**
 * Converts arbitrary values into JSON-safe data while removing common secret fields.
 * Unsupported values are omitted from objects and represented as null in arrays.
 */
function sanitizeJson(
  input,
  { secrets = [], maxStringChars = 256_000, maxDepth = 24 } = {},
) {
  const ancestors = new WeakSet();

  function visit(value, depth, inArray = false) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return redactString(value, secrets, maxStringChars);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
      return inArray ? null : undefined;
    }
    if (value instanceof Date) return value.toISOString();
    if (depth >= maxDepth) return '[MaxDepth]';
    if (ancestors.has(value)) return '[Circular]';

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry) => visit(entry, depth + 1, true));
      }
      if (!isPlainObject(value)) return redactString(String(value), secrets, maxStringChars);

      const result = {};
      for (const [key, entry] of Object.entries(value)) {
        if (isSensitiveKey(key)) {
          result[key] = '[REDACTED]';
          continue;
        }
        const sanitized = visit(entry, depth + 1);
        if (sanitized !== undefined) result[key] = sanitized;
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }

  return visit(input, 0) ?? null;
}

function normalizeUpdateId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError('updateId must be a safe integer or a non-empty string');
  }
  if (!['number', 'bigint', 'string'].includes(typeof value)) {
    throw new TypeError('updateId must be a safe integer or a non-empty string');
  }
  const normalized = String(value).trim();
  if (!normalized) throw new TypeError('updateId must not be empty');
  if (normalized.length > 128) throw new RangeError('updateId must be at most 128 characters');
  return normalized;
}

function normalizeTimestamp(value, name) {
  const normalized = requireShortString(value, name, 100);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${name} must be a valid timestamp`);
  return normalized;
}

function canonicalUpdateInteger(value) {
  return /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;
}

function tombstoneBucketTimestamp(now) {
  const bucketEnd = Math.ceil(now / REJECTED_TOMBSTONE_BUCKET_MS)
    * REJECTED_TOMBSTONE_BUCKET_MS;
  return new Date(bucketEnd).toISOString();
}

function tombstoneRange(tombstone) {
  if (Object.hasOwn(tombstone, 'updateId')) {
    const numeric = canonicalUpdateInteger(tombstone.updateId);
    return numeric === null ? null : { first: numeric, last: numeric };
  }
  const first = canonicalUpdateInteger(tombstone.firstUpdateId);
  const last = canonicalUpdateInteger(tombstone.lastUpdateId);
  return first === null || last === null ? null : { first, last };
}

function tombstoneContains(tombstone, updateId) {
  if (Object.hasOwn(tombstone, 'updateId')) return tombstone.updateId === updateId;
  const numeric = canonicalUpdateInteger(updateId);
  if (numeric === null) return false;
  const range = tombstoneRange(tombstone);
  return range !== null && numeric >= range.first && numeric <= range.last;
}

function tombstoneDuplicate(tombstone, updateId) {
  return {
    id: null,
    updateId,
    status: 'deduplicated',
    tombstone: true,
    prunedAt: tombstone.prunedAt,
    decision: tombstone.decision,
    ...(Object.hasOwn(tombstone, 'firstUpdateId')
      ? {
          firstUpdateId: tombstone.firstUpdateId,
          lastUpdateId: tombstone.lastUpdateId,
        }
      : {}),
  };
}

function requireShortString(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new RangeError(`${name} must be at most ${maxLength} characters`);
  return normalized;
}

function sanitizeError(error, options, fallbackMessage) {
  const source = error instanceof Error
    ? { name: error.name, message: error.message, code: error.code }
    : typeof error === 'string'
      ? { name: 'Error', message: error }
      : isPlainObject(error)
        ? error
        : { name: 'Error', message: fallbackMessage };
  const sanitized = sanitizeJson(source, { ...options, maxStringChars: 8_192 });
  return {
    name: typeof sanitized.name === 'string' ? sanitized.name : 'Error',
    message: typeof sanitized.message === 'string' ? sanitized.message : fallbackMessage,
    ...(typeof sanitized.code === 'string' || typeof sanitized.code === 'number'
      ? { code: sanitized.code }
      : {}),
  };
}

function sanitizeMetadata(input, options) {
  if (!isPlainObject(input)) return {};
  const source = { ...input };
  delete source.audit;
  const sanitized = sanitizeJson(source, options);
  const result = isPlainObject(sanitized) ? sanitized : {};
  if (isPlainObject(input.audit)) {
    const audit = {};
    for (const key of AUDIT_IDENTIFIER_KEYS) {
      const value = input.audit[key];
      if (!['string', 'number', 'bigint'].includes(typeof value)) continue;
      const normalized = String(value).trim();
      if (normalized && normalized.length <= 64) audit[key] = normalized;
    }
    if (Object.keys(audit).length > 0) result.audit = audit;
  }
  return result;
}

function failureFallback(status) {
  if (status === 'cancelled') return 'Job was cancelled';
  if (status === 'interrupted') return 'Job was interrupted by process shutdown';
  return 'Job failed';
}

async function syncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some platforms/filesystems. The file itself
    // was fsynced before rename, so retaining cross-platform support is preferable.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteJson(file, data) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await syncDirectoryBestEffort(path.dirname(file));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Atomic, single-process job journal for Telegram updates.
 *
 * Call `await init()` once before use. All mutation methods are serialized and
 * commit to disk before replacing in-memory state. Re-enqueuing an existing
 * Telegram update ID returns the original job without writing another record.
 */
export class JobStore {
  #file;
  #maxJobs;
  #maxBytes;
  #maxResponseChars;
  #updateTombstoneRetentionMs;
  #maxUpdateTombstones;
  #maxUpdateTombstoneBytes;
  #sanitizeOptions;
  #data = { version: SCHEMA_VERSION, jobs: [], updateTombstones: [] };
  #leases = new Map();
  #restartRecoveryPins = new Set();
  #writeChain = Promise.resolve();
  #initialized = false;

  constructor(
    file,
    {
      maxJobs = 500,
      maxBytes = 16 * 1024 * 1024,
      maxResponseChars = 2 * 1024 * 1024,
      maxPayloadStringChars = 256_000,
      updateTombstoneRetentionMs = DEFAULT_UPDATE_TOMBSTONE_RETENTION_MS,
      maxUpdateTombstones = DEFAULT_MAX_UPDATE_TOMBSTONES,
      maxUpdateTombstoneBytes = DEFAULT_MAX_UPDATE_TOMBSTONE_BYTES,
      secrets = [],
    } = {},
  ) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1) throw new RangeError('maxJobs must be at least 1');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be at least 1');
    if (!Number.isSafeInteger(maxResponseChars) || maxResponseChars < 0) {
      throw new RangeError('maxResponseChars must be a non-negative integer');
    }
    if (!Number.isSafeInteger(maxPayloadStringChars) || maxPayloadStringChars < 1) {
      throw new RangeError('maxPayloadStringChars must be at least 1');
    }
    if (!Number.isSafeInteger(updateTombstoneRetentionMs) || updateTombstoneRetentionMs < 1) {
      throw new RangeError('updateTombstoneRetentionMs must be at least 1');
    }
    if (!Number.isSafeInteger(maxUpdateTombstones) || maxUpdateTombstones < 1) {
      throw new RangeError('maxUpdateTombstones must be at least 1');
    }
    if (!Number.isSafeInteger(maxUpdateTombstoneBytes) || maxUpdateTombstoneBytes < 1) {
      throw new RangeError('maxUpdateTombstoneBytes must be at least 1');
    }
    this.#file = file;
    this.#maxJobs = maxJobs;
    this.#maxBytes = maxBytes;
    this.#maxResponseChars = maxResponseChars;
    this.#updateTombstoneRetentionMs = updateTombstoneRetentionMs;
    this.#maxUpdateTombstones = maxUpdateTombstones;
    this.#maxUpdateTombstoneBytes = maxUpdateTombstoneBytes;
    this.#sanitizeOptions = {
      secrets: [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length >= 6))],
      maxStringChars: maxPayloadStringChars,
    };
  }

  async init() {
    return this.#enqueueWrite(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      let loaded;
      let needsCanonicalWrite = false;
      try {
        const parsed = JSON.parse(await readFile(this.#file, 'utf8'));
        loaded = this.#parse(parsed);
        needsCanonicalWrite = JSON.stringify(parsed) !== JSON.stringify(loaded);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        loaded = { version: SCHEMA_VERSION, jobs: [], updateTombstones: [] };
        await atomicWriteJson(this.#file, loaded);
      }

      const now = new Date().toISOString();
      let recovered = false;
      const next = clone(loaded);
      this.#restartRecoveryPins.clear();
      for (const job of next.jobs) {
        if (job.status === 'queued' || job.status === 'running') {
          const previousStatus = job.status;
          job.status = 'interrupted';
          job.updatedAt = now;
          job.finishedAt = now;
          job.error = {
            name: 'InterruptedError',
            message: failureFallback('interrupted'),
            code: RESTART_INTERRUPTION_CODE,
          };
          job.metadata = {
            ...job.metadata,
            restartRecovery: {
              previousStatus,
              interruptedAt: now,
            },
          };
          recovered = true;
        }
        if (this.#isRestartRecoveryCandidate(job)) this.#restartRecoveryPins.add(job.id);
      }
      // Active jobs become terminal during init, but their cross-store result
      // and state evidence has not been examined yet. Pin every candidate so
      // history/byte compaction cannot destroy one before reconciliation.
      const compacted = this.#compactData(next, [...this.#restartRecoveryPins]);
      const pruned = JSON.stringify(compacted) !== JSON.stringify(next);
      if (recovered || pruned || needsCanonicalWrite) await atomicWriteJson(this.#file, compacted);
      this.#data = compacted;
      this.#initialized = true;
      return this;
    });
  }

  /** Enqueue a Telegram update, or return its existing job when updateId was seen. */
  async enqueue({ updateId, sessionKey, kind = 'prompt', payload = {}, metadata = {} }) {
    const normalizedUpdateId = normalizeUpdateId(updateId);
    const normalizedSessionKey = requireShortString(sessionKey, 'sessionKey', 256);
    const normalizedKind = requireShortString(kind, 'kind', 100);
    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      const existing = this.#findDuplicateByUpdateId(normalizedUpdateId);
      if (existing) return clone(existing);

      const now = new Date().toISOString();
      const job = {
        id: randomUUID(),
        updateId: normalizedUpdateId,
        sessionKey: normalizedSessionKey,
        kind: normalizedKind,
        status: 'queued',
        attempt: 1,
        retryOf: null,
        payload: sanitizeJson(payload, this.#sanitizeOptions),
        metadata: sanitizeMetadata(metadata, this.#sanitizeOptions),
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        queuedAt: now,
        startedAt: null,
        finishedAt: null,
      };
      return this.#commitAdded(job);
    });
  }

  /** Durably suppress a Telegram update that was intentionally rejected pre-enqueue. */
  async markUpdateSeen(updateId, { decision = 'rejected' } = {}) {
    const normalizedUpdateId = normalizeUpdateId(updateId);
    if (!TOMBSTONE_DECISIONS.has(decision)) {
      throw new Error(`Unknown update tombstone decision: ${decision}`);
    }
    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      const existing = this.#findDuplicateByUpdateId(normalizedUpdateId);
      if (existing) return clone(existing);

      const now = Date.now();
      const nextData = clone(this.#data);
      const numericUpdateId = canonicalUpdateInteger(normalizedUpdateId);
      nextData.updateTombstones.push(
        numericUpdateId === null
          ? {
              updateId: normalizedUpdateId,
              prunedAt: decision === 'rejected'
                ? tombstoneBucketTimestamp(now)
                : new Date(now).toISOString(),
              decision,
            }
          : {
              firstUpdateId: normalizedUpdateId,
              lastUpdateId: normalizedUpdateId,
              prunedAt: tombstoneBucketTimestamp(now),
              decision,
            },
      );
      const compacted = this.#compactData(nextData, [], now, {
        failOnTombstoneCapacity: true,
      });
      await atomicWriteJson(this.#file, compacted);
      this.#data = compacted;
      return clone(this.#findDuplicateByUpdateId(normalizedUpdateId));
    });
  }

  /**
   * Create a fresh queued attempt for a failed/cancelled/interrupted job.
   * A supplied payload replaces the original; omit it to reuse the sanitized one.
   */
  async enqueueRetry(originalId, newUpdateId, payload, metadata = {}) {
    const normalizedUpdateId = normalizeUpdateId(newUpdateId);
    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      const duplicate = this.#findDuplicateByUpdateId(normalizedUpdateId);
      if (duplicate) return clone(duplicate);

      const original = this.#data.jobs.find((job) => job.id === originalId);
      if (!original) throw new Error(`Unknown job: ${originalId}`);
      if (!['failed', 'cancelled', 'interrupted'].includes(original.status)) {
        throw new Error(`Job ${originalId} with status ${original.status} cannot be retried`);
      }

      const now = new Date().toISOString();
      const job = {
        id: randomUUID(),
        updateId: normalizedUpdateId,
        sessionKey: original.sessionKey,
        kind: original.kind,
        status: 'queued',
        attempt: original.attempt + 1,
        retryOf: original.id,
        payload: payload === undefined
          ? clone(original.payload)
          : sanitizeJson(payload, this.#sanitizeOptions),
        metadata: sanitizeMetadata(metadata, this.#sanitizeOptions),
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        queuedAt: now,
        startedAt: null,
        finishedAt: null,
      };
      return this.#commitAdded(job, [original.id]);
    });
  }

  /**
   * Move a job through its legal lifecycle and atomically attach metadata/result.
   * Repeating the current status is allowed for idempotent delivery/progress patches.
   */
  async transition(id, status, details = {}) {
    if (!JOB_STATUSES.has(status)) throw new Error(`Unknown job status: ${status}`);
    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      const index = this.#data.jobs.findIndex((job) => job.id === id);
      if (index < 0) throw new Error(`Unknown job: ${id}`);
      const current = this.#data.jobs[index];
      if (!LEGAL_TRANSITIONS.get(current.status).has(status)) {
        throw new Error(`Illegal job transition: ${current.status} -> ${status}`);
      }

      const nextData = clone(this.#data);
      const next = nextData.jobs[index];
      const now = new Date().toISOString();
      const changedStatus = current.status !== status;
      next.status = status;
      next.updatedAt = now;
      if (status === 'running' && !next.startedAt) next.startedAt = now;
      if (TERMINAL_STATUSES.has(status) && !next.finishedAt) next.finishedAt = now;

      if (Object.hasOwn(details, 'metadata')) {
        const metadata = sanitizeMetadata(details.metadata, this.#sanitizeOptions);
        next.metadata = isPlainObject(metadata) ? { ...next.metadata, ...metadata } : next.metadata;
      }

      const hasResult = Object.hasOwn(details, 'result')
        || Object.hasOwn(details, 'responseText')
        || Object.hasOwn(details, 'delivered');
      if (hasResult) {
        const sanitizedResult = this.#sanitizeResult(details.result ?? {});
        const result = isPlainObject(next.result) ? { ...next.result } : {};
        if (isPlainObject(sanitizedResult)) Object.assign(result, sanitizedResult);
        if (Object.hasOwn(details, 'responseText')) {
          const rawResponse = typeof details.responseText === 'string'
            ? redactString(details.responseText, this.#sanitizeOptions.secrets, Number.MAX_SAFE_INTEGER)
            : String(details.responseText ?? '');
          const response = truncateUnicode(rawResponse, this.#maxResponseChars);
          result.responseText = response.value;
          result.responseTruncated = response.truncated;
          result.responseOriginalChars = response.originalChars;
        }
        if (Object.hasOwn(details, 'delivered')) result.delivered = Boolean(details.delivered);
        next.result = result;
      }

      if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
        if (Object.hasOwn(details, 'error') || changedStatus) {
          next.error = sanitizeError(
            Object.hasOwn(details, 'error') ? details.error : undefined,
            this.#sanitizeOptions,
            failureFallback(status),
          );
        }
      } else if (status === 'succeeded') {
        next.error = null;
      }

      const compacted = this.#compactData(nextData, [id]);
      await atomicWriteJson(this.#file, compacted);
      this.#data = compacted;
      return clone(next);
    });
  }

  /**
   * Keep a journal record alive across asynchronous result delivery.
   *
   * Leases are process-local and reference counted. The returned release
   * function is idempotent and persists any pruning that becomes possible once
   * the operation is fully finished. A process crash intentionally drops all
   * leases; init() then converts abandoned active jobs to interrupted records.
   */
  acquireLease(id) {
    this.#assertInitialized();
    if (!this.#data.jobs.some((job) => job.id === id)) throw new Error(`Unknown job: ${id}`);
    this.#leases.set(id, (this.#leases.get(id) || 0) + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      return this.#enqueueWrite(async () => {
        const count = this.#leases.get(id) || 0;
        if (count > 1) {
          this.#leases.set(id, count - 1);
          return;
        }
        this.#leases.delete(id);

        const nextData = clone(this.#data);
        const compacted = this.#compactData(nextData);
        if (JSON.stringify(compacted) === JSON.stringify(nextData)) return;
        await atomicWriteJson(this.#file, compacted);
        this.#data = compacted;
      });
    };
  }

  /**
   * Return only records marked internally by init() as abandoned by a process
   * restart. Ordinary interrupted/failed jobs are never eligible for automatic
   * success recovery.
   */
  restartRecoveryCandidates() {
    this.#assertInitialized();
    return this.#data.jobs
      .filter((job) => this.#isRestartRecoveryCandidate(job))
      .map((job) => clone(job));
  }

  /**
   * Release init-time recovery pins only after every candidate was reconciled.
   * Any resulting history removal is atomically paired with its update
   * tombstone by #compactData.
   */
  async releaseRestartRecoveryPins() {
    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      if (this.#restartRecoveryPins.size === 0) return 0;
      const nextData = clone(this.#data);
      const compacted = this.#compactData(nextData);
      const removed = nextData.jobs.length - compacted.jobs.length;
      if (JSON.stringify(compacted) !== JSON.stringify(nextData)) {
        await atomicWriteJson(this.#file, compacted);
        this.#data = compacted;
      }
      this.#restartRecoveryPins.clear();
      return removed;
    });
  }

  /**
   * Finish a restart recovery after the caller has durably proven completion
   * from the other stores. This intentionally bypasses the public lifecycle
   * graph but accepts only init()'s private interruption marker.
   */
  async recoverRestartInterruptedAsSucceeded(id, { recoveryIncomplete = false } = {}) {
    if (typeof recoveryIncomplete !== 'boolean') {
      throw new TypeError('recoveryIncomplete must be a boolean');
    }
    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      const index = this.#data.jobs.findIndex((job) => job.id === id);
      if (index < 0) throw new Error(`Unknown job: ${id}`);
      const current = this.#data.jobs[index];
      if (!this.#isRestartRecoveryCandidate(current)) {
        throw new Error(`Job ${id} is not eligible for restart recovery`);
      }

      const nextData = clone(this.#data);
      const next = nextData.jobs[index];
      const now = new Date().toISOString();
      next.status = 'succeeded';
      next.updatedAt = now;
      next.error = null;
      next.metadata = {
        ...next.metadata,
        phase: 'delivery-pending',
        restartRecovery: {
          ...next.metadata.restartRecovery,
          reconciledAt: now,
          recoveryIncomplete,
        },
      };
      next.result = {
        ...(isPlainObject(next.result) ? next.result : {}),
        delivered: false,
        recoveryIncomplete,
      };

      const compacted = this.#compactData(
        nextData,
        [...new Set([id, ...this.#restartRecoveryPins])],
      );
      await atomicWriteJson(this.#file, compacted);
      this.#data = compacted;
      return clone(next);
    });
  }

  /** Mark a restart interruption as examined but not recoverable. */
  async acknowledgeRestartInterruption(id, { reason } = {}) {
    if (!RESTART_RECONCILIATION_REASONS.has(reason)) {
      throw new Error('Unknown restart reconciliation reason');
    }
    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      const index = this.#data.jobs.findIndex((job) => job.id === id);
      if (index < 0) throw new Error(`Unknown job: ${id}`);
      const current = this.#data.jobs[index];
      if (!this.#isRestartRecoveryCandidate(current)) {
        throw new Error(`Job ${id} is not eligible for restart reconciliation`);
      }

      const nextData = clone(this.#data);
      const next = nextData.jobs[index];
      const now = new Date().toISOString();
      next.updatedAt = now;
      next.error = {
        name: 'InterruptedError',
        message: failureFallback('interrupted'),
        code: RECONCILED_INTERRUPTION_CODE,
      };
      next.metadata = {
        ...next.metadata,
        restartRecovery: {
          ...next.metadata.restartRecovery,
          reconciledAt: now,
          reason,
        },
      };

      const compacted = this.#compactData(
        nextData,
        [...new Set([id, ...this.#restartRecoveryPins])],
      );
      await atomicWriteJson(this.#file, compacted);
      this.#data = compacted;
      return clone(next);
    });
  }

  get(id) {
    this.#assertInitialized();
    const found = this.#data.jobs.find((job) => job.id === id);
    return found ? clone(found) : null;
  }

  getByUpdateId(updateId) {
    this.#assertInitialized();
    const found = this.#findDuplicateByUpdateId(normalizeUpdateId(updateId));
    return found ? clone(found) : null;
  }

  latestForSession(sessionKey) {
    this.#assertInitialized();
    const key = String(sessionKey);
    for (let index = this.#data.jobs.length - 1; index >= 0; index -= 1) {
      if (this.#data.jobs[index].sessionKey === key) return clone(this.#data.jobs[index]);
    }
    return null;
  }

  latestSucceededForSession(sessionKey) {
    this.#assertInitialized();
    const key = String(sessionKey);
    for (let index = this.#data.jobs.length - 1; index >= 0; index -= 1) {
      const job = this.#data.jobs[index];
      if (job.sessionKey === key && job.status === 'succeeded') return clone(job);
    }
    return null;
  }

  /** Return the most recent successful response in a compact `/last`-friendly shape. */
  getLatestResponse(sessionKey) {
    this.#assertInitialized();
    const key = String(sessionKey);
    let job = null;
    for (let index = this.#data.jobs.length - 1; index >= 0; index -= 1) {
      const candidate = this.#data.jobs[index];
      if (
        candidate.sessionKey === key
        && candidate.status === 'succeeded'
        && typeof candidate.result?.responseText === 'string'
      ) {
        job = clone(candidate);
        break;
      }
    }
    if (!job) return null;
    return {
      jobId: job.id,
      responseText: job.result.responseText,
      truncated: Boolean(job.result.responseTruncated),
      delivered: Boolean(job.result.delivered),
      finishedAt: job.finishedAt,
    };
  }

  listForSession(sessionKey, { limit = 20, status } = {}) {
    this.#assertInitialized();
    if (status !== undefined && !JOB_STATUSES.has(status)) throw new Error(`Unknown job status: ${status}`);
    const safeLimit = Math.max(0, Math.min(Number.isSafeInteger(limit) ? limit : 20, 10_000));
    const key = String(sessionKey);
    const result = [];
    for (let index = this.#data.jobs.length - 1; index >= 0 && result.length < safeLimit; index -= 1) {
      const job = this.#data.jobs[index];
      if (job.sessionKey === key && (status === undefined || job.status === status)) result.push(clone(job));
    }
    return result;
  }

  async #commitAdded(job, preserveIds = []) {
    const nextData = clone(this.#data);
    nextData.jobs.push(job);
    const compacted = this.#compactData(nextData, [job.id, ...preserveIds], Date.now(), {
      failOnTombstoneCapacity: true,
    });
    await atomicWriteJson(this.#file, compacted);
    this.#data = compacted;
    return clone(job);
  }

  #findDuplicateByUpdateId(updateId) {
    const job = this.#data.jobs.find((candidate) => candidate.updateId === updateId);
    if (job) return job;
    const tombstone = this.#data.updateTombstones.find(
      (candidate) => tombstoneContains(candidate, updateId)
        && Date.now() - Date.parse(candidate.prunedAt) < this.#updateTombstoneRetentionMs,
    );
    return tombstone ? tombstoneDuplicate(tombstone, updateId) : null;
  }

  #isRestartRecoveryCandidate(job) {
    return job.status === 'interrupted'
      && job.error?.name === 'InterruptedError'
      && job.error?.code === RESTART_INTERRUPTION_CODE
      && ['queued', 'running'].includes(job.metadata?.restartRecovery?.previousStatus);
  }

  #sanitizeResult(input) {
    if (!isPlainObject(input)) return {};
    const source = { ...input };
    const hasResponse = Object.hasOwn(source, 'responseText');
    const rawResponse = source.responseText;
    delete source.responseText;
    const sanitized = sanitizeJson(source, this.#sanitizeOptions);
    const result = isPlainObject(sanitized) ? sanitized : {};
    if (Object.hasOwn(result, 'delivered')) result.delivered = Boolean(result.delivered);
    if (hasResponse) {
      const text = typeof rawResponse === 'string' ? rawResponse : String(rawResponse ?? '');
      const redacted = redactString(text, this.#sanitizeOptions.secrets, Number.MAX_SAFE_INTEGER);
      const response = truncateUnicode(redacted, this.#maxResponseChars);
      result.responseText = response.value;
      result.responseTruncated = response.truncated;
      result.responseOriginalChars = response.originalChars;
    }
    return result;
  }

  #compactData(
    data,
    preserveIds = [],
    now = Date.now(),
    { failOnTombstoneCapacity = false } = {},
  ) {
    const preserved = new Set(preserveIds);
    const compacted = {
      version: SCHEMA_VERSION,
      jobs: [...data.jobs],
      updateTombstones: this.#pruneUpdateTombstones(data.updateTombstones, now),
    };
    const prunedAt = tombstoneBucketTimestamp(now);

    while (
      compacted.jobs.length > this.#maxJobs
      || this.#serializedBytes(compacted) > this.#maxBytes
    ) {
      const removable = compacted.jobs.findIndex(
        (job) => TERMINAL_STATUSES.has(job.status)
          && !preserved.has(job.id)
          && !this.#leases.has(job.id),
      );
      if (removable < 0) break;

      const removed = compacted.jobs[removable];
      const numericRemovedId = canonicalUpdateInteger(removed.updateId);
      const candidateTombstones = compacted.updateTombstones.some(
        (entry) => tombstoneContains(entry, removed.updateId),
      )
        ? compacted.updateTombstones
        : [...compacted.updateTombstones,
            numericRemovedId === null
              ? {
                  updateId: removed.updateId,
                  prunedAt,
                  decision: 'pruned',
                }
              : {
                  firstUpdateId: removed.updateId,
                  lastUpdateId: removed.updateId,
                  prunedAt,
                  decision: 'pruned',
                },
          ];
      try {
        compacted.updateTombstones = this.#pruneUpdateTombstones(candidateTombstones, now);
      } catch (error) {
        if (failOnTombstoneCapacity) throw error;
        break;
      }
      compacted.jobs.splice(removable, 1);
    }

    // Active, leased, and operation-local jobs are never discarded. The
    // journal may temporarily exceed its limits until a protected job becomes
    // removable; its update ID is tombstoned atomically with that removal.
    return compacted;
  }

  #pruneUpdateTombstones(tombstones, now = Date.now()) {
    const kept = this.#coalesceUpdateTombstones(tombstones.filter(
      (entry) => now - Date.parse(entry.prunedAt) < this.#updateTombstoneRetentionMs,
    ));
    this.#assertTombstonesDoNotOverlap(kept);
    const bytes = Buffer.byteLength(JSON.stringify(kept, null, 2), 'utf8');
    if (kept.length > this.#maxUpdateTombstones || bytes > this.#maxUpdateTombstoneBytes) {
      const error = new Error(
        'Telegram update deduplication ledger is full; refusing unsafe history pruning',
      );
      error.code = 'JOB_UPDATE_LEDGER_FULL';
      throw error;
    }
    return kept;
  }

  #coalesceUpdateTombstones(tombstones) {
    const fixed = [];
    const numericGroups = new Map();
    for (const entry of tombstones) {
      const range = tombstoneRange(entry);
      if (range === null) {
        fixed.push({ ...entry });
        continue;
      }
      const key = `${entry.decision}\0${entry.prunedAt}`;
      const group = numericGroups.get(key) || {
        decision: entry.decision,
        prunedAt: entry.prunedAt,
        ranges: [],
      };
      group.ranges.push(range);
      numericGroups.set(key, group);
    }

    for (const { decision, prunedAt, ranges } of numericGroups.values()) {
      ranges.sort((left, right) => (left.first < right.first ? -1 : left.first > right.first ? 1 : 0));
      const merged = [];
      for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.first <= previous.last + 1n) {
          if (range.last > previous.last) previous.last = range.last;
          continue;
        }
        merged.push({ ...range });
      }
      for (const range of merged) {
        fixed.push({
          firstUpdateId: range.first.toString(),
          lastUpdateId: range.last.toString(),
          prunedAt,
          decision,
        });
      }
    }

    return fixed.sort((left, right) => {
      const timeOrder = left.prunedAt.localeCompare(right.prunedAt);
      if (timeOrder !== 0) return timeOrder;
      const leftId = left.updateId ?? left.firstUpdateId;
      const rightId = right.updateId ?? right.firstUpdateId;
      return leftId.localeCompare(rightId);
    });
  }

  #assertTombstonesDoNotOverlap(tombstones) {
    const nonNumericIds = new Set();
    const numericRanges = [];
    for (const entry of tombstones) {
      const range = tombstoneRange(entry);
      if (range !== null) {
        numericRanges.push(range);
        continue;
      }
      if (nonNumericIds.has(entry.updateId)) {
        throw new Error(`Duplicate updateId in deduplication ledger: ${entry.updateId}`);
      }
      nonNumericIds.add(entry.updateId);
    }
    numericRanges.sort((left, right) => (left.first < right.first ? -1 : left.first > right.first ? 1 : 0));
    for (let index = 1; index < numericRanges.length; index += 1) {
      if (numericRanges[index].first <= numericRanges[index - 1].last) {
        throw new Error('Overlapping numeric update IDs in deduplication ledger');
      }
    }
  }

  #serializedBytes(data) {
    return Buffer.byteLength(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  #parse(parsed) {
    if (
      !parsed
      || ![LEGACY_SCHEMA_VERSION, SCHEMA_VERSION].includes(parsed.version)
      || !Array.isArray(parsed.jobs)
      || (parsed.version === SCHEMA_VERSION && !Array.isArray(parsed.updateTombstones))
    ) {
      throw new Error(
        `Unsupported or invalid job journal schema (expected version ${SCHEMA_VERSION}`
          + ` or migratable version ${LEGACY_SCHEMA_VERSION})`,
      );
    }
    const ids = new Set();
    const updateIds = new Set();
    const jobs = parsed.jobs.map((job, index) => {
      if (!isPlainObject(job)) throw new Error(`Invalid job record at index ${index}`);
      if (typeof job.id !== 'string' || !job.id || ids.has(job.id)) throw new Error(`Invalid or duplicate job id at index ${index}`);
      const updateId = normalizeUpdateId(job.updateId);
      if (updateIds.has(updateId)) throw new Error(`Duplicate updateId in job journal: ${updateId}`);
      if (!JOB_STATUSES.has(job.status)) throw new Error(`Invalid job status at index ${index}: ${job.status}`);
      ids.add(job.id);
      updateIds.add(updateId);
      return {
        id: job.id,
        updateId,
        sessionKey: requireShortString(job.sessionKey, 'sessionKey', 256),
        kind: requireShortString(job.kind, 'kind', 100),
        status: job.status,
        attempt: Number.isSafeInteger(job.attempt) && job.attempt > 0 ? job.attempt : 1,
        retryOf: typeof job.retryOf === 'string' ? job.retryOf : null,
        payload: sanitizeJson(job.payload ?? {}, this.#sanitizeOptions),
        metadata: sanitizeMetadata(job.metadata ?? {}, this.#sanitizeOptions),
        result: job.result === null ? null : this.#sanitizeResult(job.result),
        error: job.error === null ? null : sanitizeError(job.error, this.#sanitizeOptions, failureFallback(job.status)),
        createdAt: requireShortString(job.createdAt, 'createdAt', 100),
        updatedAt: requireShortString(job.updatedAt, 'updatedAt', 100),
        queuedAt: requireShortString(job.queuedAt ?? job.createdAt, 'queuedAt', 100),
        startedAt: typeof job.startedAt === 'string' ? job.startedAt : null,
        finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : null,
      };
    });
    const updateTombstones = (parsed.version === LEGACY_SCHEMA_VERSION
      ? []
      : parsed.updateTombstones.map((entry, index) => {
          if (!isPlainObject(entry)) throw new Error(`Invalid update tombstone at index ${index}`);
          const decision = entry.decision ?? 'pruned';
          if (!TOMBSTONE_DECISIONS.has(decision)) {
            throw new Error(`Invalid update tombstone decision at index ${index}`);
          }
          const rawTimestamp = normalizeTimestamp(entry.prunedAt, 'prunedAt');
          const hasUpdateId = Object.hasOwn(entry, 'updateId');
          const hasRange = Object.hasOwn(entry, 'firstUpdateId')
            || Object.hasOwn(entry, 'lastUpdateId');
          if (hasUpdateId === hasRange) {
            throw new Error(`Update tombstone at index ${index} must contain one ID or one range`);
          }
          if (hasRange) {
            const firstUpdateId = normalizeUpdateId(entry.firstUpdateId);
            const lastUpdateId = normalizeUpdateId(entry.lastUpdateId);
            const first = canonicalUpdateInteger(firstUpdateId);
            const last = canonicalUpdateInteger(lastUpdateId);
            if (first === null || last === null || first > last) {
              throw new Error(`Invalid numeric update tombstone range at index ${index}`);
            }
            return {
              firstUpdateId,
              lastUpdateId,
              prunedAt: tombstoneBucketTimestamp(Date.parse(rawTimestamp)),
              decision,
            };
          }
          const updateId = normalizeUpdateId(entry.updateId);
          const numeric = canonicalUpdateInteger(updateId);
          if (numeric !== null) {
            return {
              firstUpdateId: updateId,
              lastUpdateId: updateId,
              prunedAt: tombstoneBucketTimestamp(Date.parse(rawTimestamp)),
              decision,
            };
          }
          return {
            updateId,
            prunedAt: decision === 'rejected'
              ? tombstoneBucketTimestamp(Date.parse(rawTimestamp))
              : rawTimestamp,
            decision,
          };
        }));

    if (parsed.rejectedThroughUpdateId != null || parsed.rejectedThroughAt != null) {
      throw new Error('Unsafe rejected-update high-watermark journals are not supported');
    }
    const canonicalTombstones = this.#pruneUpdateTombstones(updateTombstones);
    for (const job of jobs) {
      if (canonicalTombstones.some((entry) => tombstoneContains(entry, job.updateId))) {
        throw new Error(`Update ID exists in both jobs and deduplication ledger: ${job.updateId}`);
      }
    }

    const data = {
      version: SCHEMA_VERSION,
      jobs,
      updateTombstones: canonicalTombstones,
    };
    // A previous startup can crash during reconciliation after init already
    // persisted the interruption marker. Preserve those candidates during the
    // next parse as well; init() will re-establish the process-local pin set.
    const recoveryIds = jobs
      .filter((job) => this.#isRestartRecoveryCandidate(job))
      .map((job) => job.id);
    return this.#compactData(data, recoveryIds);
  }

  #assertInitialized() {
    if (!this.#initialized) throw new Error('JobStore.init() must be awaited before use');
  }

  #enqueueWrite(operation) {
    const result = this.#writeChain.then(operation, operation);
    this.#writeChain = result.catch(() => {});
    return result;
  }
}

export const _private = {
  SCHEMA_VERSION,
  JOB_STATUSES,
  TERMINAL_STATUSES,
  LEGAL_TRANSITIONS,
  sanitizeJson,
  truncateUnicode,
  RESTART_INTERRUPTION_CODE,
  RECONCILED_INTERRUPTION_CODE,
};
