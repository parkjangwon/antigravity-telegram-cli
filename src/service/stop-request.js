import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export const STOP_REQUEST_FILE = 'stop.request.json';
export const STOP_REQUEST_VERSION = 1;

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_REQUEST_LIFETIME_MS = 5 * 60 * 1_000;
const CLOCK_SKEW_MS = 30 * 1_000;

function assertRequestPath(requestPath) {
  if (typeof requestPath !== 'string' || !path.isAbsolute(requestPath)) {
    throw new Error('service stop-request path must be absolute');
  }
  if (/[\u0000-\u001f\u007f]/u.test(requestPath)) {
    throw new Error('service stop-request path cannot contain control characters');
  }
}

export function buildServiceStopRequestPath(dataDir, pathApi = path) {
  if (typeof dataDir !== 'string' || !pathApi.isAbsolute(dataDir)) {
    throw new Error('service data directory must be absolute');
  }
  return pathApi.join(dataDir, 'runtime', 'service', STOP_REQUEST_FILE);
}

function validateRequestDocument(document, nowMs) {
  if (!document || document.version !== STOP_REQUEST_VERSION) return false;
  const requestedAtMs = Date.parse(document.requestedAtUtc);
  const expiresAtMs = Date.parse(document.expiresAtUtc);
  if (!Number.isFinite(requestedAtMs) || !Number.isFinite(expiresAtMs)) return false;
  if (requestedAtMs > nowMs + CLOCK_SKEW_MS || expiresAtMs <= nowMs) return false;
  if (expiresAtMs <= requestedAtMs || expiresAtMs - requestedAtMs > MAX_REQUEST_LIFETIME_MS) {
    return false;
  }
  return true;
}

async function inspectRequest(requestPath, nowMs = Date.now()) {
  assertRequestPath(requestPath);
  let info;
  try {
    info = await lstat(requestPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, active: false };
    throw error;
  }

  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REQUEST_BYTES) {
    return { exists: true, active: false };
  }

  try {
    const source = (await readFile(requestPath, 'utf8')).replace(/^\ufeff/u, '');
    return {
      exists: true,
      active: validateRequestDocument(JSON.parse(source), nowMs),
    };
  } catch {
    return { exists: true, active: false };
  }
}

export async function clearStaleServiceStopRequest(requestPath, nowMs = Date.now()) {
  const status = await inspectRequest(requestPath, nowMs);
  if (!status.exists || status.active) return false;
  await rm(requestPath, { force: true });
  return true;
}

async function consumeServiceStopRequest(requestPath, nowMs = Date.now()) {
  const status = await inspectRequest(requestPath, nowMs);
  if (!status.exists) return false;
  await rm(requestPath, { force: true });
  return status.active;
}

/**
 * Polls a private, service-owned sentinel. A valid request is consumed and
 * latched even when it arrives before LifecycleController has been created.
 */
export class ServiceStopRequestMonitor {
  #requestPath;
  #intervalMs;
  #logger;
  #timer = null;
  #polling = false;
  #requested = false;
  #handler = null;
  #dispatchPromise = null;

  constructor({ requestPath, intervalMs = 200, logger = console }) {
    assertRequestPath(requestPath);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 25 || intervalMs > 5_000) {
      throw new RangeError('service stop-request interval must be from 25 to 5000ms');
    }
    this.#requestPath = requestPath;
    this.#intervalMs = intervalMs;
    this.#logger = logger;
  }

  get requested() {
    return this.#requested;
  }

  async start() {
    if (this.#timer) return this;
    await this.#poll();
    if (!this.#requested) {
      this.#timer = setInterval(() => {
        this.#poll().catch((error) => {
          this.#logger.warn?.('Service stop-request check failed', {
            name: error?.name,
            code: error?.code,
            message: error?.message,
          });
        });
      }, this.#intervalMs);
      this.#timer.unref?.();
    }
    return this;
  }

  setHandler(handler) {
    if (typeof handler !== 'function') throw new TypeError('stop-request handler must be a function');
    if (this.#handler) throw new Error('stop-request handler is already installed');
    this.#handler = handler;
    this.#dispatch();
  }

  close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #poll() {
    if (this.#polling || this.#requested) return;
    this.#polling = true;
    try {
      if (!(await consumeServiceStopRequest(this.#requestPath))) return;
      this.#requested = true;
      this.close();
      this.#dispatch();
    } finally {
      this.#polling = false;
    }
  }

  #dispatch() {
    if (!this.#requested || !this.#handler || this.#dispatchPromise) return;
    this.#dispatchPromise = Promise.resolve()
      .then(() => this.#handler('service-stop-request'))
      .catch((error) => {
        this.#logger.error?.('Service stop-request handler failed', {
          name: error?.name,
          code: error?.code,
          message: error?.message,
        });
      });
  }
}

export const _private = {
  inspectRequest,
  consumeServiceStopRequest,
  validateRequestDocument,
  MAX_REQUEST_BYTES,
  MAX_REQUEST_LIFETIME_MS,
};
