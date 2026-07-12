export class ActivityClosedError extends Error {
  constructor(message = 'Activity tracker is shutting down') {
    super(message);
    this.name = 'ActivityClosedError';
    this.code = 'ACTIVITY_TRACKER_CLOSED';
  }
}

/**
 * Tracks asynchronous tails that intentionally outlive their Telegram update
 * handler (for example, a durable agy job detached after journal admission).
 * The instance lock may only be released after this tracker is idle.
 */
export class ActivityTracker {
  #active = new Set();
  #accepting = true;

  get closed() {
    return !this.#accepting;
  }

  hasAnyActive() {
    return this.#active.size > 0;
  }

  close() {
    if (!this.#accepting) return false;
    this.#accepting = false;
    return true;
  }

  begin() {
    if (!this.#accepting) throw new ActivityClosedError();
    return this.#addToken();
  }

  // The promise is already running, so it must remain visible even if close()
  // raced with the hand-off from an admitted Telegram handler.
  trackExisting(promise) {
    const release = this.#addToken();
    return Promise.resolve(promise).finally(release);
  }

  #addToken() {
    const token = {};
    this.#active.add(token);
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      this.#active.delete(token);
      return true;
    };
  }

  async waitForIdle(timeoutMs = 8_000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.#active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.#active.size === 0;
  }
}
