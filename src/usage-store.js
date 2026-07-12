import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1_000;
const OUTCOMES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

function clone(value) {
  return structuredClone(value);
}

function requireShortString(value, name, maxLength = 256) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new RangeError(`${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeUserId(value) {
  const normalized = requireShortString(String(value ?? ''), 'userId', 32);
  if (!/^\d+$/.test(normalized)) {
    throw new TypeError('userId must be a positive numeric Telegram user ID');
  }
  return normalized;
}

function parseTimestamp(value, name) {
  const normalized = requireShortString(value, name, 100);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} must be an ISO timestamp`);
  return { value: new Date(milliseconds).toISOString(), milliseconds };
}

function utcDay(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function dayMilliseconds(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('day must be YYYY-MM-DD');
  const milliseconds = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || utcDay(milliseconds) !== day) {
    throw new TypeError('day must be a valid UTC calendar day');
  }
  return milliseconds;
}

async function syncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Some Windows/filesystem combinations cannot fsync a directory. The file
    // itself was fsynced before rename, which is the strongest portable contract.
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

export class UsageLimitError extends Error {
  constructor(message, code, { retryAt = null } = {}) {
    super(message);
    this.name = 'UsageLimitError';
    this.code = code;
    this.retryAt = retryAt;
  }
}

/** Reserve before invoking operation and durably settle either outcome. */
export async function runWithUsage(
  store,
  { id, userId, operation, monotonicClock = () => performance.now() },
) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  await store.reserve({ id, userId });
  const started = monotonicClock();
  let result;
  let operationError = null;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  const durationMs = Math.max(0, Math.ceil(monotonicClock() - started));
  const cancelled = operationError?.code === 'AGY_CANCELLED'
    || /cancelled|canceled/i.test(operationError?.message || '');
  // A settlement failure deliberately wins over the child error. The durable
  // worst-case reservation remains in place, so subsequent runs fail safely.
  await store.finish(id, {
    durationMs,
    outcome: operationError ? (cancelled ? 'cancelled' : 'failed') : 'succeeded',
  });
  if (operationError) throw operationError;
  return result;
}

/**
 * Durable single-process abuse/cost accounting.
 *
 * A run reserves the complete configured agy timeout before the child starts.
 * Completion replaces that reservation with measured runtime. On restart, an
 * unfinished reservation is conservatively charged in full. The repository's
 * data-directory instance lock is the cross-component single-writer boundary.
 */
export class UsageStore {
  #file;
  #windowMs;
  #maxJobsPerUser;
  #maxJobsGlobal;
  #dailyRuntimeMsPerUser;
  #dailyRuntimeMsGlobal;
  #reservationMs;
  #retentionDays;
  #maxBytes;
  #clock;
  #data = { version: SCHEMA_VERSION, runs: [], daily: [] };
  #writeChain = Promise.resolve();
  #initialized = false;

  constructor(
    file,
    {
      windowMs = 60 * 60 * 1_000,
      maxJobsPerUser = 20,
      maxJobsGlobal = 100,
      dailyRuntimeMsPerUser = 120 * 60 * 1_000,
      dailyRuntimeMsGlobal = 480 * 60 * 1_000,
      reservationMs = 330_000,
      retentionDays = 8,
      maxBytes = 4 * 1024 * 1024,
      clock = Date.now,
    } = {},
  ) {
    for (const [name, value] of Object.entries({
      windowMs,
      maxJobsPerUser,
      maxJobsGlobal,
      dailyRuntimeMsPerUser,
      dailyRuntimeMsGlobal,
      reservationMs,
      retentionDays,
      maxBytes,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    if (maxJobsGlobal < maxJobsPerUser) {
      throw new RangeError('maxJobsGlobal must be at least maxJobsPerUser');
    }
    if (dailyRuntimeMsGlobal < dailyRuntimeMsPerUser) {
      throw new RangeError('dailyRuntimeMsGlobal must be at least dailyRuntimeMsPerUser');
    }
    if (dailyRuntimeMsPerUser < reservationMs || dailyRuntimeMsGlobal < reservationMs) {
      throw new RangeError('daily runtime limits must each cover one complete reservation');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');

    this.#file = file;
    this.#windowMs = windowMs;
    this.#maxJobsPerUser = maxJobsPerUser;
    this.#maxJobsGlobal = maxJobsGlobal;
    this.#dailyRuntimeMsPerUser = dailyRuntimeMsPerUser;
    this.#dailyRuntimeMsGlobal = dailyRuntimeMsGlobal;
    this.#reservationMs = reservationMs;
    this.#retentionDays = retentionDays;
    this.#maxBytes = maxBytes;
    this.#clock = clock;
  }

  async init() {
    return this.#enqueueWrite(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      let loaded;
      let mustWrite = false;
      try {
        const parsed = JSON.parse(await readFile(this.#file, 'utf8'));
        loaded = this.#parse(parsed);
        mustWrite = JSON.stringify(parsed) !== JSON.stringify(loaded);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        loaded = { version: SCHEMA_VERSION, runs: [], daily: [] };
        await atomicWriteJson(this.#file, loaded);
      }

      const now = this.#now();
      for (const run of loaded.runs) {
        if (run.finishedAt !== null) continue;
        this.#addDaily(loaded, utcDay(Date.parse(run.startedAt)), run.userId, run.reservedRuntimeMs);
        run.finishedAt = new Date(now).toISOString();
        run.durationMs = run.reservedRuntimeMs;
        run.outcome = 'interrupted';
        mustWrite = true;
      }
      const beforeCompact = JSON.stringify(loaded);
      const compacted = this.#compact(loaded, now);
      if (JSON.stringify(compacted) !== beforeCompact) mustWrite = true;
      this.#assertSize(compacted);
      if (mustWrite) await atomicWriteJson(this.#file, compacted);
      this.#data = compacted;
      this.#initialized = true;
      return this;
    });
  }

  /** Atomically check all limits and reserve the worst-case runtime for one agy run. */
  async reserve({ id, userId }) {
    const normalizedId = requireShortString(id, 'id', 128);
    const normalizedUserId = normalizeUserId(userId);
    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      const now = this.#now();
      const next = this.#compact(clone(this.#data), now);
      if (next.runs.some((run) => run.id === normalizedId)) {
        throw new UsageLimitError('A usage reservation already exists for this job', 'USAGE_DUPLICATE');
      }

      const cutoff = now - this.#windowMs;
      const recent = next.runs.filter((run) => Date.parse(run.startedAt) >= cutoff);
      const userRecent = recent.filter((run) => run.userId === normalizedUserId);
      if (userRecent.length >= this.#maxJobsPerUser) {
        throw new UsageLimitError(
          'The per-user rolling agy job limit was reached',
          'USAGE_USER_JOB_LIMIT',
          { retryAt: new Date(Date.parse(userRecent[0].startedAt) + this.#windowMs).toISOString() },
        );
      }
      if (recent.length >= this.#maxJobsGlobal) {
        throw new UsageLimitError(
          'The global rolling agy job limit was reached',
          'USAGE_GLOBAL_JOB_LIMIT',
          { retryAt: new Date(Date.parse(recent[0].startedAt) + this.#windowMs).toISOString() },
        );
      }

      const day = utcDay(now);
      const completedUserMs = next.daily
        .filter((entry) => entry.day === day && entry.userId === normalizedUserId)
        .reduce((total, entry) => total + entry.runtimeMs, 0);
      const completedGlobalMs = next.daily
        .filter((entry) => entry.day === day)
        .reduce((total, entry) => total + entry.runtimeMs, 0);
      const active = next.runs.filter(
        (run) => run.finishedAt === null && utcDay(Date.parse(run.startedAt)) === day,
      );
      const activeUserMs = active
        .filter((run) => run.userId === normalizedUserId)
        .reduce((total, run) => total + run.reservedRuntimeMs, 0);
      const activeGlobalMs = active.reduce((total, run) => total + run.reservedRuntimeMs, 0);

      if (completedUserMs + activeUserMs + this.#reservationMs > this.#dailyRuntimeMsPerUser) {
        throw new UsageLimitError(
          'The per-user daily agy runtime budget was reached',
          'USAGE_USER_RUNTIME_LIMIT',
          { retryAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString() },
        );
      }
      if (completedGlobalMs + activeGlobalMs + this.#reservationMs > this.#dailyRuntimeMsGlobal) {
        throw new UsageLimitError(
          'The global daily agy runtime budget was reached',
          'USAGE_GLOBAL_RUNTIME_LIMIT',
          { retryAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString() },
        );
      }

      const run = {
        id: normalizedId,
        userId: normalizedUserId,
        startedAt: new Date(now).toISOString(),
        reservedRuntimeMs: this.#reservationMs,
        finishedAt: null,
        durationMs: null,
        outcome: null,
      };
      next.runs.push(run);
      this.#assertSize(next);
      await atomicWriteJson(this.#file, next);
      this.#data = next;
      return clone(run);
    });
  }

  /** Replace a live reservation with measured runtime after success or failure. */
  async finish(id, { durationMs, outcome }) {
    const normalizedId = requireShortString(id, 'id', 128);
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > DAY_MS) {
      throw new RangeError('durationMs must be a non-negative safe integer no greater than one day');
    }
    if (!OUTCOMES.has(outcome) || outcome === 'interrupted') {
      throw new TypeError('outcome must be succeeded, failed, or cancelled');
    }

    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      const run = this.#data.runs.find((entry) => entry.id === normalizedId);
      if (!run) throw new Error(`Unknown usage reservation: ${normalizedId}`);
      if (run.finishedAt !== null) return clone(run);

      const now = this.#now();
      const next = clone(this.#data);
      const target = next.runs.find((entry) => entry.id === normalizedId);
      target.finishedAt = new Date(now).toISOString();
      target.durationMs = durationMs;
      target.outcome = outcome;
      this.#addDaily(next, utcDay(Date.parse(target.startedAt)), target.userId, durationMs);
      const compacted = this.#compact(next, now);
      this.#assertSize(compacted);
      await atomicWriteJson(this.#file, compacted);
      this.#data = compacted;
      return clone(target);
    });
  }

  async prune() {
    return this.#enqueueWrite(async () => {
      this.#assertInitialized();
      const next = this.#compact(clone(this.#data), this.#now());
      this.#assertSize(next);
      if (JSON.stringify(next) !== JSON.stringify(this.#data)) {
        await atomicWriteJson(this.#file, next);
        this.#data = next;
      }
    });
  }

  snapshot() {
    this.#assertInitialized();
    return clone(this.#data);
  }

  #addDaily(data, day, userId, runtimeMs) {
    let entry = data.daily.find((candidate) => candidate.day === day && candidate.userId === userId);
    if (!entry) {
      entry = { day, userId, runtimeMs: 0 };
      data.daily.push(entry);
    }
    entry.runtimeMs += runtimeMs;
    if (!Number.isSafeInteger(entry.runtimeMs)) throw new RangeError('Daily runtime total overflow');
  }

  #compact(data, now) {
    const windowCutoff = now - this.#windowMs;
    const oldestDay = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    ) - (this.#retentionDays - 1) * DAY_MS;
    data.runs = data.runs.filter(
      (run) => run.finishedAt === null || Date.parse(run.startedAt) >= windowCutoff,
    );
    data.daily = data.daily.filter((entry) => dayMilliseconds(entry.day) >= oldestDay);
    data.runs.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
    data.daily.sort((left, right) => left.day.localeCompare(right.day) || left.userId.localeCompare(right.userId));
    return data;
  }

  #parse(parsed) {
    if (!parsed || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.runs) || !Array.isArray(parsed.daily)) {
      throw new Error(`Unsupported or invalid usage-store schema (expected version ${SCHEMA_VERSION})`);
    }
    const ids = new Set();
    const runs = parsed.runs.map((run, index) => {
      if (!run || typeof run !== 'object' || Array.isArray(run)) {
        throw new Error(`Invalid usage run at index ${index}`);
      }
      const id = requireShortString(run.id, 'id', 128);
      if (ids.has(id)) throw new Error(`Duplicate usage run id: ${id}`);
      ids.add(id);
      const startedAt = parseTimestamp(run.startedAt, 'startedAt').value;
      const reservedRuntimeMs = run.reservedRuntimeMs;
      if (!Number.isSafeInteger(reservedRuntimeMs) || reservedRuntimeMs < 1) {
        throw new Error(`Invalid usage reservation at index ${index}`);
      }
      const active = run.finishedAt == null;
      const finishedAt = active ? null : parseTimestamp(run.finishedAt, 'finishedAt').value;
      const durationMs = active ? null : run.durationMs;
      if (!active && (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > DAY_MS)) {
        throw new Error(`Invalid usage duration at index ${index}`);
      }
      const outcome = active ? null : run.outcome;
      if (!active && !OUTCOMES.has(outcome)) throw new Error(`Invalid usage outcome at index ${index}`);
      return {
        id,
        userId: normalizeUserId(run.userId),
        startedAt,
        reservedRuntimeMs,
        finishedAt,
        durationMs,
        outcome,
      };
    });

    const dailyByKey = new Map();
    for (const [index, entry] of parsed.daily.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Invalid daily usage at index ${index}`);
      }
      const day = requireShortString(entry.day, 'day', 10);
      dayMilliseconds(day);
      const userId = normalizeUserId(entry.userId);
      if (!Number.isSafeInteger(entry.runtimeMs) || entry.runtimeMs < 0) {
        throw new Error(`Invalid daily runtime at index ${index}`);
      }
      const key = `${day}:${userId}`;
      const total = (dailyByKey.get(key)?.runtimeMs ?? 0) + entry.runtimeMs;
      if (!Number.isSafeInteger(total)) throw new RangeError('Daily runtime total overflow');
      dailyByKey.set(key, { day, userId, runtimeMs: total });
    }
    return { version: SCHEMA_VERSION, runs, daily: [...dailyByKey.values()] };
  }

  #assertSize(data) {
    const size = Buffer.byteLength(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    if (size > this.#maxBytes) {
      const error = new Error(`Usage store exceeds its ${this.#maxBytes}-byte limit`);
      error.code = 'USAGE_STORE_SIZE_LIMIT';
      throw error;
    }
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Usage-store clock returned an invalid time');
    return now;
  }

  #assertInitialized() {
    if (!this.#initialized) throw new Error('UsageStore.init() must be awaited before use');
  }

  #enqueueWrite(operation) {
    const result = this.#writeChain.then(operation, operation);
    this.#writeChain = result.catch(() => {});
    return result;
  }
}

export const _private = { SCHEMA_VERSION, DAY_MS, OUTCOMES, utcDay };
