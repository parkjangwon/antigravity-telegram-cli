import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 2;

const EXECUTION_FIELDS = [
  'conversationId',
  'projectId',
  'model',
  'agent',
  'skill',
  'mode',
  'sandbox',
  'workspaceDir',
  'newProject',
  'history',
];

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function serializedState(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function executionState(session) {
  return {
    ...Object.fromEntries(EXECUTION_FIELDS.map((field) => [field, session[field]])),
    // A native conversation normally keeps the same ID while its remote
    // contents advance. A new completed run ID is therefore an execution
    // change even when every other persisted field remains byte-for-byte the
    // same. Later deliveryStatus patches keep the ID and remain harmless.
    completedRunId: session.lastRun?.id ?? null,
  };
}

function executionStateChanged(current, next) {
  return JSON.stringify(executionState(current)) !== JSON.stringify(executionState(next));
}

function clone(value) {
  return structuredClone(value);
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

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn) => turn && ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string')
    .map((turn) => ({
      role: turn.role,
      content: turn.content,
      at: typeof turn.at === 'string' ? turn.at : new Date().toISOString(),
    }));
}

function normalizeLastRun(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    id: typeof value.id === 'string' ? value.id : null,
    kind: typeof value.kind === 'string' ? value.kind : 'prompt',
    status: ['succeeded', 'failed', 'cancelled'].includes(value.status)
      ? value.status
      : 'failed',
    mode: ['accept-edits', 'plan'].includes(value.mode) ? value.mode : null,
    sandbox: Boolean(value.sandbox),
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    finishedAt: typeof value.finishedAt === 'string' ? value.finishedAt : null,
    durationMs: Number.isFinite(value.durationMs) ? value.durationMs : null,
    responseText:
      typeof value.responseText === 'string' ? value.responseText.slice(0, 64 * 1024) : null,
    deliveryStatus: ['pending', 'delivered', 'failed'].includes(value.deliveryStatus)
      ? value.deliveryStatus
      : null,
    errorCode: typeof value.errorCode === 'string' ? value.errorCode.slice(0, 100) : null,
  };
}

function normalizeSession(value, defaults) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...clone(defaults),
    conversationId:
      typeof source.conversationId === 'string' && source.conversationId ? source.conversationId : null,
    projectId: typeof source.projectId === 'string' && source.projectId ? source.projectId : null,
    model: typeof source.model === 'string' && source.model ? source.model : null,
    agent: typeof source.agent === 'string' && source.agent ? source.agent : null,
    skill: typeof source.skill === 'string' && source.skill ? source.skill.slice(0, 200) : null,
    mode: ['accept-edits', 'plan'].includes(source.mode) ? source.mode : defaults.mode,
    sandbox: typeof source.sandbox === 'boolean' ? source.sandbox : defaults.sandbox,
    workspaceDir:
      typeof source.workspaceDir === 'string' && source.workspaceDir
        ? source.workspaceDir
        : defaults.workspaceDir,
    newProject: typeof source.newProject === 'boolean' ? source.newProject : true,
    history: normalizeHistory(source.history),
    lastRun: normalizeLastRun(source.lastRun),
    executionGeneration: isUuid(source.executionGeneration)
      ? source.executionGeneration
      : randomUUID(),
    revision: Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
  };
}

export class StateStore {
  #file;
  #defaults;
  #data = { version: SCHEMA_VERSION, sessions: {} };
  #writeChain = Promise.resolve();
  #maxSessions;
  #maxBytes;
  #retentionMs;

  constructor(file, defaults = {}, {
    maxSessions = 500,
    maxBytes = 16 * 1024 * 1024,
    retentionMs = 30 * 24 * 60 * 60 * 1_000,
  } = {}) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new RangeError('maxSessions must be positive');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be positive');
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new RangeError('retentionMs must be positive');
    this.#file = file;
    this.#maxSessions = maxSessions;
    this.#maxBytes = maxBytes;
    this.#retentionMs = retentionMs;
    this.#defaults = {
      conversationId: null,
      projectId: null,
      model: null,
      agent: null,
      mode: 'accept-edits',
      sandbox: false,
      workspaceDir: null,
      newProject: true,
      history: [],
      lastRun: null,
      executionGeneration: null,
      revision: 0,
      ...defaults,
    };
  }

  async init() {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      const migrated = this.#migrate(parsed);
      const limited = this.#limitLoadedSessions(migrated);
      // Always rewrite a successfully loaded state once. Besides enforcing the
      // current limits and file mode, this makes newly assigned execution
      // generations durable before a queued job can rely on them.
      await this.#persist(limited);
      this.#data = limited;
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.#persist();
        return;
      }
      if (error instanceof SyntaxError) {
        const corruptPath = `${this.#file}.corrupt-${Date.now()}`;
        await rename(this.#file, corruptPath);
        console.warn(`Corrupt state moved to ${corruptPath}`);
        this.#data = { version: SCHEMA_VERSION, sessions: {} };
        await this.#persist();
        return;
      }
      throw error;
    }
  }

  #migrate(parsed) {
    let sessions;
    if (
      parsed &&
      [1, SCHEMA_VERSION].includes(parsed.version) &&
      parsed.sessions &&
      typeof parsed.sessions === 'object'
    ) {
      sessions = parsed.sessions;
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      !Object.hasOwn(parsed, 'version')
    ) {
      // Accept the original design's legacy top-level { chatId: session } shape.
      sessions = parsed;
    } else if (parsed && Object.hasOwn(parsed, 'version')) {
      throw new Error(`Unsupported state schema version: ${parsed.version}`);
    } else {
      sessions = {};
    }

    return {
      version: SCHEMA_VERSION,
      sessions: Object.fromEntries(
        Object.entries(sessions)
          .filter(([chatId]) => /^-?\d+(?::\d+)?$/.test(chatId))
          .map(([chatId, session]) => [chatId, normalizeSession(session, this.#defaults)]),
      ),
    };
  }

  get(chatId) {
    const key = String(chatId);
    return normalizeSession(this.#data.sessions[key], this.#defaults);
  }

  has(chatId) {
    return Object.hasOwn(this.#data.sessions, String(chatId));
  }

  async ensure(chatId) {
    // Touch existing sessions so TTL maintenance cannot evict a session that
    // has just been admitted for work.
    return this.update(chatId, (session) => session);
  }

  async update(chatId, updater) {
    const key = String(chatId);
    return this.#enqueueWrite(async () => {
      if (!this.has(key) && Object.keys(this.#data.sessions).length >= this.#maxSessions) {
        const error = new Error(`State session limit reached (${this.#maxSessions})`);
        error.code = 'STATE_SESSION_LIMIT';
        throw error;
      }
      const current = this.get(key);
      const proposed = await updater(clone(current));
      const next = normalizeSession(proposed ?? current, this.#defaults);
      next.createdAt = current.createdAt;
      next.updatedAt = new Date().toISOString();
      // A generation identifies one lifetime of a session. It is deliberately
      // not writable through the generic updater, so remove/reset followed by
      // recreation can never produce the same execution context (ABA).
      next.executionGeneration = current.executionGeneration;
      if (this.has(key) && executionStateChanged(current, next)) {
        if (current.revision === Number.MAX_SAFE_INTEGER) {
          next.executionGeneration = randomUUID();
          next.revision = 0;
        } else {
          next.revision = current.revision + 1;
        }
      } else {
        next.revision = current.revision;
      }
      const nextData = clone(this.#data);
      nextData.sessions[key] = next;
      await this.#persist(nextData);
      this.#data = nextData;
      return clone(next);
    });
  }

  async reset(chatId) {
    const key = String(chatId);
    return this.#enqueueWrite(async () => {
      const fresh = normalizeSession({}, this.#defaults);
      const nextData = clone(this.#data);
      nextData.sessions[key] = fresh;
      await this.#persist(nextData);
      this.#data = nextData;
      return clone(fresh);
    });
  }

  async remove(chatId) {
    const key = String(chatId);
    return this.#enqueueWrite(async () => {
      const nextData = clone(this.#data);
      delete nextData.sessions[key];
      await this.#persist(nextData);
      this.#data = nextData;
    });
  }

  async pruneExpired(now = Date.now()) {
    return this.#enqueueWrite(async () => {
      const cutoff = now - this.#retentionMs;
      const nextData = clone(this.#data);
      let removed = 0;
      for (const [key, session] of Object.entries(nextData.sessions)) {
        const updated = Date.parse(session.updatedAt);
        if (Number.isFinite(updated) && updated <= cutoff) {
          delete nextData.sessions[key];
          removed += 1;
        }
      }
      if (removed > 0) {
        await this.#persist(nextData);
        this.#data = nextData;
      }
      return removed;
    });
  }

  #enqueueWrite(operation) {
    const result = this.#writeChain.then(operation, operation);
    this.#writeChain = result.catch(() => {});
    return result;
  }

  async #persist(data = this.#data) {
    const temp = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    const contents = serializedState(data);
    const bytes = Buffer.byteLength(contents, 'utf8');
    if (bytes > this.#maxBytes) {
      const error = new Error(`State file would exceed its limit (${bytes} > ${this.#maxBytes} bytes)`);
      error.code = 'STATE_SIZE_LIMIT';
      throw error;
    }
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, this.#file);
      await syncDirectoryBestEffort(path.dirname(this.#file));
    } finally {
      await handle?.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  #limitLoadedSessions(data, now = Date.now()) {
    const cutoff = now - this.#retentionMs;
    const entries = Object.entries(data.sessions).filter(([, session]) => {
      const updated = Date.parse(session.updatedAt);
      return !Number.isFinite(updated) || updated > cutoff;
    });
    entries.sort((left, right) => {
      const leftTime = Date.parse(left[1].updatedAt) || 0;
      const rightTime = Date.parse(right[1].updatedAt) || 0;
      return rightTime - leftTime;
    });
    const kept = [];
    for (const entry of entries) {
      if (kept.length >= this.#maxSessions) break;
      const candidate = {
        version: SCHEMA_VERSION,
        sessions: Object.fromEntries([...kept, entry]),
      };
      // Measure the exact representation #persist writes. Compact JSON can be
      // materially smaller and previously let an invalid candidate through,
      // making startup fail before expired/oversized sessions were pruned.
      if (Buffer.byteLength(serializedState(candidate), 'utf8') > this.#maxBytes) continue;
      kept.push(entry);
    }
    if (
      kept.length === Object.keys(data.sessions).length &&
      kept.every(([key]) => Object.hasOwn(data.sessions, key))
    ) {
      return data;
    }
    return { version: SCHEMA_VERSION, sessions: Object.fromEntries(kept) };
  }
}

export function appendHistory(history, turns, { maxTurns = 20, maxChars = 60_000 } = {}) {
  if (maxTurns === 0 || maxChars === 0) return [];
  const combined = [...normalizeHistory(history), ...normalizeHistory(turns)];
  const kept = [];
  let chars = 0;

  for (let index = combined.length - 1; index >= 0 && kept.length < maxTurns; index -= 1) {
    const turn = combined[index];
    if (kept.length > 0 && chars + turn.content.length > maxChars) break;
    const remaining = Math.max(0, maxChars - chars);
    const content = turn.content.length > remaining ? turn.content.slice(-remaining) : turn.content;
    kept.unshift({ ...turn, content });
    chars += content.length;
  }
  return kept;
}

export const _private = {
  normalizeSession,
  normalizeHistory,
  normalizeLastRun,
  SCHEMA_VERSION,
};
