import { randomUUID } from 'node:crypto';

export class BusyError extends Error {
  constructor(message = 'A task is already running for this chat') {
    super(message);
    this.name = 'BusyError';
  }
}

export class QueueTimeoutError extends Error {
  constructor(message = 'Task exceeded the queue wait limit') {
    super(message);
    this.name = 'QueueTimeoutError';
    this.code = 'TASK_QUEUE_TIMEOUT';
  }
}

class Semaphore {
  #limit;
  #running = 0;
  #waiting = [];

  constructor(limit) {
    this.#limit = limit;
  }

  acquire(signal) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        const index = this.#waiting.indexOf(entry);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(signal.reason ?? new Error('Cancelled'));
      };
      if (signal?.aborted) {
        entry.onAbort();
        return;
      }
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.#waiting.push(entry);
      this.#drain();
    });
  }

  #drain() {
    while (this.#running < this.#limit && this.#waiting.length > 0) {
      const entry = this.#waiting.shift();
      if (entry.signal?.aborted) continue;
      entry.signal?.removeEventListener('abort', entry.onAbort);
      this.#running += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.#running -= 1;
        this.#drain();
      });
    }
  }

  get running() {
    return this.#running;
  }

  get waiting() {
    return this.#waiting.length;
  }
}

export class KeyedMutex {
  #entries = new Map();

  async run(key, signal, operation) {
    const normalized = String(key);
    let entry = this.#entries.get(normalized);
    if (!entry) {
      entry = { locked: false, waiting: [] };
      this.#entries.set(normalized, entry);
    }
    const release = await this.#acquire(normalized, entry, signal);
    try {
      // Abort can race with a lock grant. Check once more before crossing the
      // synchronous execution boundary so expired work never starts.
      if (signal?.aborted) throw signal.reason ?? new Error('Cancelled');
      return await operation();
    } finally {
      release();
    }
  }

  #acquire(key, entry, signal) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      const grant = () => {
        entry.locked = true;
        signal?.removeEventListener('abort', waiter.onAbort);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          const next = entry.waiting.shift();
          if (next) next.grant();
          else {
            entry.locked = false;
            this.#entries.delete(key);
          }
        });
      };
      waiter.grant = grant;
      waiter.onAbort = () => {
        const index = entry.waiting.indexOf(waiter);
        if (index >= 0) entry.waiting.splice(index, 1);
        if (!entry.locked && entry.waiting.length === 0) this.#entries.delete(key);
        reject(signal.reason ?? new Error('Cancelled'));
      };
      if (signal?.aborted) {
        waiter.onAbort();
      } else if (!entry.locked) {
        grant();
      } else {
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        entry.waiting.push(waiter);
      }
    });
  }
}

export class TaskManager {
  #active = new Map();
  #semaphore;
  #maxQueueWaitMs;
  #overloadThreshold;
  #overloadQueueWaitMs;
  #maxActive;
  #accepting = true;
  #closeReason = null;

  constructor(maxConcurrent = 1, {
    maxQueueWaitMs = 10 * 60 * 1_000,
    overloadThreshold = 0.75,
    overloadQueueWaitMs = 2 * 60 * 1_000,
    maxActive = 32,
  } = {}) {
    if (!Number.isFinite(maxQueueWaitMs) || maxQueueWaitMs <= 0) {
      throw new RangeError('maxQueueWaitMs must be a positive number');
    }
    if (!Number.isSafeInteger(maxActive) || maxActive < maxConcurrent) {
      throw new RangeError('maxActive must be an integer no smaller than maxConcurrent');
    }
    if (typeof overloadThreshold !== 'number' || !Number.isFinite(overloadThreshold)
      || overloadThreshold <= 0 || overloadThreshold > 1) {
      throw new RangeError('overloadThreshold must be a number from 0 (exclusive) to 1 (inclusive)');
    }
    if (!Number.isFinite(overloadQueueWaitMs) || overloadQueueWaitMs <= 0) {
      throw new RangeError('overloadQueueWaitMs must be a positive number');
    }
    this.#semaphore = new Semaphore(maxConcurrent);
    this.#maxQueueWaitMs = maxQueueWaitMs;
    this.#overloadThreshold = overloadThreshold;
    this.#overloadQueueWaitMs = overloadQueueWaitMs;
    this.#maxActive = maxActive;
  }

  isActive(chatId) {
    return this.#active.has(String(chatId));
  }

  hasAnyActive() {
    return this.#active.size > 0;
  }

  get activeCount() {
    return this.#active.size;
  }

  get queuedCount() {
    return this.#semaphore.waiting;
  }

  get closed() {
    return !this.#accepting;
  }

  getStatus(chatId) {
    const active = this.#active.get(String(chatId));
    if (!active) return null;
    const queued = [...this.#active.values()].filter((task) => task.state === 'queued');
    return {
      id: active.id,
      state: active.state,
      phase: active.phase,
      queuedAt: active.queuedAt,
      startedAt: active.startedAt,
      queuePosition: active.state === 'queued' ? queued.indexOf(active) + 1 : 0,
      metadata: { ...active.metadata },
    };
  }

  async run(chatId, task, metadata = {}, { deferExecutionStart = false } = {}) {
    const key = String(chatId);
    if (!this.#accepting) {
      const error = new BusyError('The task manager is shutting down');
      error.code = 'TASK_MANAGER_CLOSED';
      throw error;
    }
    if (this.#active.has(key)) throw new BusyError();
    if (this.#active.size >= this.#maxActive) {
      const error = new BusyError('The global active task limit was reached');
      error.code = 'TASK_GLOBAL_LIMIT';
      throw error;
    }
    const queueWaitMs = this.#queueWaitLimitFor(this.#active.size + 1);
    const controller = new AbortController();
    const marker = {
      id: randomUUID().slice(0, 8),
      controller,
      state: 'queued',
      phase: 'queued',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      metadata: { ...metadata },
    };
    this.#active.set(key, marker);

    let release;
    let executionStarted = false;
    let executionClaimed = false;
    const queueTimer = setTimeout(() => {
      controller.abort(new QueueTimeoutError());
    }, queueWaitMs);
    const startExecution = () => {
      if (executionStarted) return;
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new QueueTimeoutError();
      }
      executionStarted = true;
      clearTimeout(queueTimer);
      marker.state = 'running';
      marker.phase = 'starting';
      marker.startedAt = new Date().toISOString();
    };
    const runExecution = async (operation) => {
      if (!deferExecutionStart) {
        throw new Error('runExecution is only available for deferred tasks');
      }
      if (executionClaimed) throw new Error('Task execution may only start once');
      executionClaimed = true;
      const releaseExecution = await this.#semaphore.acquire(controller.signal);
      try {
        // The timer remains armed while this task waits for a global slot.
        // If timeout won the grant race, this throws before operation starts.
        startExecution();
        return await operation();
      } finally {
        releaseExecution();
      }
    };
    try {
      if (!deferExecutionStart) {
        release = await this.#semaphore.acquire(controller.signal);
        startExecution();
      }
      const control = {
        id: marker.id,
        runExecution,
        update: (phase, details = {}) => {
          marker.phase = phase;
          marker.metadata = { ...marker.metadata, ...details };
        },
      };
      return await task(controller.signal, control);
    } finally {
      clearTimeout(queueTimer);
      release?.();
      if (this.#active.get(key) === marker) this.#active.delete(key);
    }
  }

  cancel(chatId) {
    const active = this.#active.get(String(chatId));
    if (!active) return false;
    active.controller.abort(new Error('Cancelled by user'));
    return true;
  }

  close(reason = new Error('Application shutting down')) {
    if (!this.#accepting) return false;
    this.#accepting = false;
    this.#closeReason = reason;
    return true;
  }

  cancelAll(reason = new Error('Application shutting down')) {
    this.close(reason);
    for (const active of this.#active.values()) {
      active.controller.abort(this.#closeReason || reason);
    }
  }

  async waitForIdle(timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.#active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.#active.size === 0;
  }

  #queueWaitLimitFor(projectedActive) {
    const overloadCutoff = Math.max(1, Math.ceil(this.#maxActive * this.#overloadThreshold));
    if (projectedActive < overloadCutoff) return this.#maxQueueWaitMs;
    return Math.min(this.#maxQueueWaitMs, this.#overloadQueueWaitMs);
  }
}

export const _private = { Semaphore };
