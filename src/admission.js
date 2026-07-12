export class AdmissionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AdmissionError';
    this.code = code;
  }
}

export class AdmissionCancelledError extends Error {
  constructor(message = 'Admission was cancelled') {
    super(message);
    this.name = 'AdmissionCancelledError';
    this.code = 'ADMISSION_CANCELLED';
  }
}

function cancellationError(reason, fallbackMessage) {
  if (reason instanceof Error) return reason;
  return new AdmissionCancelledError(
    typeof reason === 'string' && reason.trim() ? reason : fallbackMessage,
  );
}

/** Synchronous reservation gate used before any durable enqueue await. */
export class AdmissionController {
  #maxTotal;
  #maxPerUser;
  #entries = new Map();
  #sessions = new Set();
  #users = new Map();
  #idleWaiters = new Set();
  #closed = false;

  constructor({ maxTotal = 16, maxPerUser = 3 } = {}) {
    if (!Number.isSafeInteger(maxTotal) || maxTotal < 1) {
      throw new RangeError('maxTotal must be a positive integer');
    }
    if (!Number.isSafeInteger(maxPerUser) || maxPerUser < 1 || maxPerUser > maxTotal) {
      throw new RangeError('maxPerUser must be a positive integer no greater than maxTotal');
    }
    this.#maxTotal = maxTotal;
    this.#maxPerUser = maxPerUser;
  }

  reserve({ token, sessionKey, userId, sessionAlreadyActive = false }) {
    const normalizedToken = String(token || '');
    const session = String(sessionKey || '');
    const user = String(userId || '');
    if (!normalizedToken || !session || !user) throw new TypeError('token, sessionKey, and userId are required');
    if (this.#closed) {
      throw new AdmissionError('Admission is closed', 'ADMISSION_CLOSED');
    }
    if (this.#entries.has(normalizedToken)) {
      throw new AdmissionError('The admission token is already reserved', 'DUPLICATE_ADMISSION');
    }
    if (sessionAlreadyActive || this.#sessions.has(session)) {
      throw new AdmissionError('A job is already active for this session', 'SESSION_JOB_LIMIT');
    }
    if (this.#entries.size >= this.#maxTotal) {
      throw new AdmissionError('The global pending job limit was reached', 'GLOBAL_JOB_LIMIT');
    }
    if ((this.#users.get(user) || 0) >= this.#maxPerUser) {
      throw new AdmissionError('The per-user pending job limit was reached', 'USER_JOB_LIMIT');
    }

    const entry = {
      sessionKey: session,
      userId: user,
      controller: new AbortController(),
    };
    this.#entries.set(normalizedToken, entry);
    this.#sessions.add(session);
    this.#users.set(user, (this.#users.get(user) || 0) + 1);
    return this.#reservationHandle(normalizedToken, entry);
  }

  get size() {
    return this.#entries.size;
  }

  get closed() {
    return this.#closed;
  }

  /** Abort the reservation for one Telegram session without freeing its slot prematurely. */
  cancel(sessionKey, reason = new AdmissionCancelledError('Admission cancelled by user')) {
    const session = String(sessionKey || '');
    if (!session) return false;
    let cancelled = false;
    for (const entry of this.#entries.values()) {
      if (entry.sessionKey !== session || entry.controller.signal.aborted) continue;
      entry.controller.abort(cancellationError(reason, 'Admission cancelled by user'));
      cancelled = true;
    }
    return cancelled;
  }

  /** Abort all current reservations while keeping the controller open to future work. */
  cancelAll(reason = new AdmissionCancelledError('Application shutting down')) {
    const error = cancellationError(reason, 'Application shutting down');
    let cancelled = 0;
    for (const entry of this.#entries.values()) {
      if (entry.controller.signal.aborted) continue;
      entry.controller.abort(error);
      cancelled += 1;
    }
    return cancelled;
  }

  /** Permanently reject new reservations and abort every reservation still handing off. */
  close(reason = new AdmissionCancelledError('Application shutting down')) {
    const changed = !this.#closed;
    this.#closed = true;
    this.cancelAll(reason);
    return changed;
  }

  seal(reason) {
    return this.close(reason);
  }

  async waitForIdle(timeoutMs = 8_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('timeoutMs must be a non-negative number');
    }
    if (this.#entries.size === 0) return true;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (idle) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#idleWaiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(this.#entries.size === 0), timeoutMs);
      this.#idleWaiters.add(onIdle);
      // Close the release-before-registration race without yielding.
      if (this.#entries.size === 0) onIdle();
    });
  }

  #reservationHandle(token, entry) {
    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      if (this.#entries.get(token) !== entry) return false;
      this.#entries.delete(token);
      this.#sessions.delete(entry.sessionKey);
      const remaining = (this.#users.get(entry.userId) || 1) - 1;
      if (remaining > 0) this.#users.set(entry.userId, remaining);
      else this.#users.delete(entry.userId);
      if (this.#entries.size === 0) {
        for (const waiter of [...this.#idleWaiters]) waiter();
      }
      return true;
    };
    // Keep the original callable release API while exposing a cancellable
    // reservation to handoff code.
    Object.defineProperties(release, {
      release: { value: release },
      signal: { value: entry.controller.signal },
      token: { value: token },
      sessionKey: { value: entry.sessionKey },
    });
    return release;
  }
}
