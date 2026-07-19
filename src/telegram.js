import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const TELEGRAM_TEXT_LIMIT = 4_096;
const SAFE_CHUNK_SIZE = 3_800;
const TELEGRAM_HTML_PARSE_MODE = 'HTML';
const TELEGRAM_MARKDOWN_HINT =
  /(^|\n)\s{0,3}#{1,6}\s|\*\*[^*\n]+\*\*|`[^`\n]+`|```[\s\S]*?```|\[[^\]\n]+\]\((?:https?:\/\/|tg:\/\/)[^)]+\)/u;

const DEFAULT_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
  attemptTimeoutMs: 30_000,
});

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
]);

const activeTelegramCalls = new Set();
const guardedTelegramClients = new WeakSet();
let telegramCallsAccepting = true;
let telegramShutdownReason = null;

function abortReason(signal, fallback = 'Telegram request cancelled') {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error(fallback), { name: 'AbortError', code: 'ABORT_ERR' });
}

function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizeTelegramCodeLanguage(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9#+-]/gu, '');
}

function markdownToTelegramHtml(markdown) {
  const source = String(markdown ?? '');
  if (!source || !TELEGRAM_MARKDOWN_HINT.test(source)) return null;

  const fences = [];
  const withFenceTokens = source.replace(/```([^\n`]*)\n([\s\S]*?)```/gu, (_m, language, code) => {
    const index = fences.push({ language, code }) - 1;
    return `\u0000FENCE_${index}\u0000`;
  });

  let html = escapeTelegramHtml(withFenceTokens);
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|tg:\/\/[^\s)]+)\)/gu, (_m, label, url) =>
    `<a href="${escapeTelegramHtml(url)}">${label}</a>`);
  html = html.replace(/^#{1,6}\s+(.+)$/gmu, '<b>$1</b>');
  html = html.replace(/\*\*([^\n*][\s\S]*?[^\n*])\*\*/gu, '<b>$1</b>');
  html = html.replace(/`([^`\n]+)`/gu, '<code>$1</code>');
  html = html.replace(/\u0000FENCE_(\d+)\u0000/gu, (_m, index) => {
    const { language, code } = fences[Number(index)] || {};
    const escapedCode = escapeTelegramHtml(code || '');
    const normalized = normalizeTelegramCodeLanguage(language);
    if (normalized) return `<pre><code class="language-${normalized}">${escapedCode}</code></pre>`;
    return `<pre>${escapedCode}</pre>`;
  });
  return html;
}

function formatTelegramChunk(chunk, allowFormatting) {
  if (!allowFormatting) return { text: chunk, parseMode: undefined };
  const html = markdownToTelegramHtml(chunk);
  if (!html) return { text: chunk, parseMode: undefined };
  return { text: html, parseMode: TELEGRAM_HTML_PARSE_MODE };
}

function waitForAbortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(reject, abortReason(signal));
    const finish = (settle, value) => {
      signal.removeEventListener('abort', onAbort);
      settle(value);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

const defaultSleep = (delayMs, signal) => {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(resolve), delayMs);
    const onAbort = () => finish(reject, abortReason(signal));
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

export class TelegramAttemptTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Telegram request attempt exceeded ${timeoutMs}ms`);
    this.name = 'TelegramAttemptTimeoutError';
    this.code = 'TELEGRAM_ATTEMPT_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

export class TelegramRequestError extends Error {
  constructor(message, details) {
    super(message, { cause: details.cause });
    this.name = 'TelegramRequestError';
    this.code = 'TELEGRAM_REQUEST_FAILED';
    this.operation = details.operation;
    this.attempts = details.attempts;
    this.retryable = details.retryable;
    this.duplicateRisk = details.duplicateRisk;
    this.retryAfterMs = details.retryAfterMs;
  }
}

/**
 * Raised when a logical Telegram delivery could not be completed. `sentParts`
 * makes partial chunk delivery explicit. Callers with durable output (such as
 * `/last`) should offer that recovery path instead of blindly replaying only
 * the failed chunk: an ambiguous network failure may already have delivered it.
 */
export class TelegramDeliveryError extends Error {
  constructor(message, details) {
    super(message, { cause: details.cause });
    this.name = 'TelegramDeliveryError';
    this.code = 'TELEGRAM_DELIVERY_FAILED';
    this.operation = details.operation;
    this.sentParts = details.sentParts;
    this.totalParts = details.totalParts;
    this.failedPart = details.failedPart;
    this.partial = details.sentParts > 0;
    this.recoverableWithLast = true;
    this.retries = details.retries;
    this.duplicateRisk = details.duplicateRisk;
  }
}

function numberInRange(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeRetryOptions(options = {}) {
  const maxAttempts = Math.trunc(
    numberInRange(options.maxAttempts, DEFAULT_RETRY_OPTIONS.maxAttempts, 1, 10),
  );
  const baseDelayMs = numberInRange(
    options.baseDelayMs,
    DEFAULT_RETRY_OPTIONS.baseDelayMs,
    0,
    60_000,
  );
  const maxDelayMs = numberInRange(
    options.maxDelayMs,
    DEFAULT_RETRY_OPTIONS.maxDelayMs,
    baseDelayMs,
    5 * 60_000,
  );
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    attemptTimeoutMs: numberInRange(
      options.attemptTimeoutMs,
      DEFAULT_RETRY_OPTIONS.attemptTimeoutMs,
      1,
      5 * 60_000,
    ),
    jitterRatio: numberInRange(
      options.jitterRatio,
      DEFAULT_RETRY_OPTIONS.jitterRatio,
      0,
      1,
    ),
    sleep: typeof options.sleep === 'function' ? options.sleep : defaultSleep,
    random: typeof options.random === 'function' ? options.random : Math.random,
    onRetry: typeof options.onRetry === 'function' ? options.onRetry : undefined,
    signal: options.signal,
  };
}

function nestedErrors(error) {
  const errors = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current) && errors.length < 5) {
    errors.push(current);
    seen.add(current);
    current = current.cause;
  }
  return errors;
}

function errorStatus(error) {
  for (const candidate of nestedErrors(error)) {
    const response = candidate.response?.body || candidate.response;
    const values = [
      response?.error_code,
      response?.status,
      candidate.status,
      candidate.statusCode,
      typeof candidate.code === 'number' ? candidate.code : undefined,
    ];
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed;
    }
  }
  return undefined;
}

function errorRetryAfterMs(error) {
  for (const candidate of nestedErrors(error)) {
    const response = candidate.response?.body || candidate.response;
    const value =
      response?.parameters?.retry_after ??
      response?.retry_after ??
      candidate.parameters?.retry_after ??
      candidate.retry_after;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  }
  return undefined;
}

function isAbortError(error) {
  return nestedErrors(error).some(
    (candidate) => candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR',
  );
}

function isNetworkError(error) {
  if (isAbortError(error)) return false;
  return nestedErrors(error).some((candidate) => {
    if (candidate.code === 'TELEGRAM_ATTEMPT_TIMEOUT') return true;
    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
    if (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_')) return true;
    if (candidate.name === 'FetchError') return true;
    return candidate.name === 'TypeError' && /fetch failed|network/i.test(candidate.message || '');
  });
}

function createCallAbort(externalSignal) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(abortReason(externalSignal));
  if (!telegramCallsAccepting) {
    controller.abort(telegramShutdownReason || new Error('Telegram delivery is shutting down'));
  } else if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  activeTelegramCalls.add(controller);
  return {
    controller,
    cleanup() {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      activeTelegramCalls.delete(controller);
    },
  };
}

function createAttemptAbort(signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortReason(signal));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new TelegramAttemptTimeoutError(timeoutMs));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function pollingRetryDelayMs(error) {
  const status = errorStatus(error);
  const timeout = error?.code === 'TELEGRAM_ATTEMPT_TIMEOUT';
  const transient =
    timeout ||
    error?.name === 'FetchError' ||
    status === 429 ||
    (status !== undefined && status >= 500);
  if (!transient) return null;
  const requested = timeout ? 5_000 : errorRetryAfterMs(error) ?? 5_000;
  return Math.min(5 * 60_000, Math.max(50, requested));
}

async function guardedPollingTelegramCall(operation, { signal, attemptTimeoutMs }) {
  const callAbort = createCallAbort(signal);
  try {
    for (;;) {
      if (callAbort.controller.signal.aborted) {
        throw abortReason(callAbort.controller.signal);
      }
      const attemptAbort = createAttemptAbort(callAbort.controller.signal, attemptTimeoutMs);
      try {
        const pending = Promise.resolve().then(() => operation(attemptAbort.signal));
        return await waitForAbortable(pending, attemptAbort.signal);
      } catch (error) {
        if (callAbort.controller.signal.aborted) {
          throw abortReason(callAbort.controller.signal);
        }
        const delayMs = pollingRetryDelayMs(error);
        // Preserve fatal Telegram errors (notably 401/409) and unexpected
        // application failures for Telegraf's normal launch error handling.
        if (delayMs === null) throw error;
        await defaultSleep(delayMs, callAbort.controller.signal);
      } finally {
        attemptAbort.cleanup();
      }
    }
  } finally {
    callAbort.cleanup();
  }
}

export function abortActiveTelegramCalls(reason = new Error('Application shutting down')) {
  for (const controller of activeTelegramCalls) {
    if (!controller.signal.aborted) controller.abort(reason);
  }
}

export function shutdownTelegramCalls(reason = new Error('Application shutting down')) {
  telegramCallsAccepting = false;
  telegramShutdownReason = reason;
  abortActiveTelegramCalls(reason);
}

export function hasActiveTelegramCalls() {
  return activeTelegramCalls.size > 0;
}

export async function waitForTelegramIdle(timeoutMs = 8_000) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (activeTelegramCalls.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return activeTelegramCalls.size === 0;
}

/**
 * Telegraf creates a separate Telegram client for every update. Guarding each
 * client at the earliest middleware boundary ensures even ordinary ctx.reply()
 * calls use the shared shutdown boundary and a deadline, while still passing
 * an AbortSignal to Telegraf's low-level HTTP transport.
 */
export function guardTelegramClient(client, { attemptTimeoutMs = 30_000 } = {}) {
  if (!client || typeof client.callApi !== 'function') {
    throw new TypeError('Telegram client must provide callApi()');
  }
  if (guardedTelegramClients.has(client)) return client;
  const callApi = client.callApi.bind(client);
  client.callApi = (method, payload, options = {}) => {
    // Telegraf's own polling backoff cannot be aborted. Consume transient
    // getUpdates failures here so bot.stop/global shutdown can cancel both the
    // HTTP attempt and a long retry_after sleep immediately.
    const serverWaitMs = method === 'getUpdates' && Number.isFinite(Number(payload?.timeout))
      ? Math.max(0, Number(payload.timeout) * 1_000)
      : 0;
    const effectiveAttemptTimeoutMs = serverWaitMs > 0
      ? Math.max(attemptTimeoutMs, serverWaitMs + 10_000)
      : attemptTimeoutMs;
    if (method === 'getUpdates') {
      return guardedPollingTelegramCall(
        (signal) => callApi(method, payload, { ...options, signal }),
        {
          signal: options?.signal,
          attemptTimeoutMs: effectiveAttemptTimeoutMs,
        },
      );
    }
    return retryTelegramCall(
      (signal) => callApi(method, payload, { ...options, signal }),
      {
        signal: options?.signal,
        maxAttempts: 1,
        attemptTimeoutMs: effectiveAttemptTimeoutMs,
        operation: String(method || 'Telegram API request'),
      },
    ).then((report) => report.value);
  };
  guardedTelegramClients.add(client);
  return client;
}

export function classifyTelegramError(error) {
  const status = errorStatus(error);
  const retryAfterMs = errorRetryAfterMs(error);
  const network = status === undefined && isNetworkError(error);
  const rateLimited = status === 429;
  const serverError = status !== undefined && status >= 500;
  return {
    status,
    retryAfterMs,
    retryable: rateLimited || serverError || network,
    reason: rateLimited ? 'rate-limit' : serverError ? 'server' : network ? 'network' : 'fatal',
    // 429 is an explicit rejection. A 5xx or lost network response may have
    // happened after Telegram accepted the message, so replay can duplicate it.
    duplicateRisk: serverError || network,
  };
}

function retryDelayMs(attempt, details, options) {
  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const required = Math.max(exponential, details.retryAfterMs || 0);
  const jitterWindow = Math.min(required, options.maxDelayMs) * options.jitterRatio;
  const random = Math.min(1, Math.max(0, Number(options.random()) || 0));
  return Math.round(Math.min(options.maxDelayMs, required + jitterWindow * random));
}

/**
 * Execute one Telegram API request with bounded retries.
 *
 * The return report exposes `duplicateRisk`: it becomes true when a retry
 * follows an ambiguous 5xx/network failure. `sleep` and `random` are injectable
 * through options for deterministic tests. An exhausted call throws
 * TelegramRequestError with the same delivery-risk information.
 */
export async function retryTelegramCall(operation, options = {}) {
  const retryOptions = normalizeRetryOptions(options);
  const operationName = options.operation || 'request';
  let duplicateRisk = false;
  const callAbort = createCallAbort(retryOptions.signal);
  try {
    for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt += 1) {
      if (callAbort.controller.signal.aborted) {
        throw abortReason(callAbort.controller.signal);
      }
      const attemptAbort = createAttemptAbort(
        callAbort.controller.signal,
        retryOptions.attemptTimeoutMs,
      );
      try {
        const pending = Promise.resolve().then(() => operation(attemptAbort.signal));
        const value = await waitForAbortable(pending, attemptAbort.signal);
        return {
          value,
          attempts: attempt,
          retries: attempt - 1,
          duplicateRisk,
        };
      } catch (error) {
        // Application/user cancellation is authoritative and must never be
        // wrapped or retried. This is what lets TaskManager shutdown promptly.
        if (callAbort.controller.signal.aborted) {
          throw abortReason(callAbort.controller.signal);
        }
        const details = classifyTelegramError(error);
        duplicateRisk ||= details.duplicateRisk;
        const exhausted = attempt >= retryOptions.maxAttempts;
        if (!details.retryable || exhausted) {
          throw new TelegramRequestError(
            `Telegram ${operationName} failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${error.message || String(error)}`,
            {
              cause: error,
              operation: operationName,
              attempts: attempt,
              retryable: details.retryable,
              duplicateRisk,
              retryAfterMs: details.retryAfterMs,
            },
          );
        }

        const delayMs = retryDelayMs(attempt, details, retryOptions);
        await waitForAbortable(
          Promise.resolve(retryOptions.onRetry?.({
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
            error,
            ...details,
          })),
          callAbort.controller.signal,
        );
        await waitForAbortable(
          retryOptions.sleep(delayMs, callAbort.controller.signal),
          callAbort.controller.signal,
        );
      } finally {
        attemptAbort.cleanup();
      }
    }
  } finally {
    callAbort.cleanup();
  }

  throw new Error('unreachable');
}

function deliveryRetryOptions(deliveryOptions) {
  if (!deliveryOptions) return {};
  const { retry, ...common } = deliveryOptions;
  return { ...common, ...(retry || {}) };
}

function deliveryReport(transport, sentParts, retries, duplicateRisk) {
  return {
    complete: true,
    transport,
    sentParts,
    totalParts: sentParts,
    retries,
    duplicateRisk,
  };
}

async function deliverParts({ transport, parts, deliver, deliveryOptions }) {
  let retries = 0;
  let duplicateRisk = false;
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) {
      // Throttle/Delay between chunks to defend against Telegram Rate Limits (Flood limits)
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    try {
      const report = await retryTelegramCall((signal) => deliver(parts[index], index, signal), {
        ...deliveryRetryOptions(deliveryOptions),
        operation: `${transport} part ${index + 1}/${parts.length}`,
      });
      retries += report.retries;
      duplicateRisk ||= report.duplicateRisk;
      await deliveryOptions?.onSent?.(report.value, { index, total: parts.length, transport });
    } catch (error) {
      // retryTelegramCall only leaves cancellation/shutdown errors unwrapped.
      // Preserve that authoritative reason so callers do not start a fresh
      // error-notification delivery after cancellation.
      if (!(error instanceof TelegramRequestError)) throw error;
      retries += Math.max(0, (error.attempts || 1) - 1);
      duplicateRisk ||= Boolean(error.duplicateRisk);
      throw new TelegramDeliveryError(
        `Telegram delivery stopped at part ${index + 1}/${parts.length}; use /last to recover the complete response.`,
        {
          cause: error,
          operation: transport,
          sentParts: index,
          totalParts: parts.length,
          failedPart: index + 1,
          retries,
          duplicateRisk,
        },
      );
    }
  }
  return deliveryReport(transport, parts.length, retries, duplicateRisk);
}

export function sessionKey(ctx) {
  const chatId = String(ctx.chat?.id ?? '');
  const threadId =
    ctx.message?.message_thread_id ??
    ctx.callbackQuery?.message?.message_thread_id ??
    ctx.update?.callback_query?.message?.message_thread_id;
  return threadId ? `${chatId}:${threadId}` : chatId;
}

export function storageScope(ctx) {
  return sessionKey(ctx).replace(':', '-thread-');
}

export function messageThreadOptions(ctx) {
  const threadId =
    ctx.message?.message_thread_id ??
    ctx.callbackQuery?.message?.message_thread_id ??
    ctx.update?.callback_query?.message?.message_thread_id;
  return threadId ? { message_thread_id: threadId } : undefined;
}

export function classifyUpdateAge(
  ctx,
  maxAgeSeconds,
  { nowSeconds = Math.floor(Date.now() / 1_000), safeCommands = new Set() } = {},
) {
  const messageDate = ctx.message?.date;
  if (!Number.isFinite(messageDate)) return { stale: false, ageSeconds: null, command: null };
  const ageSeconds = Math.max(0, Math.floor(nowSeconds - messageDate));
  const command = ctx.message?.text?.match(/^\/(\w+)/)?.[1]?.toLowerCase() || null;
  return {
    stale: ageSeconds > maxAgeSeconds && !(command && safeCommands.has(command)),
    ageSeconds,
    command,
  };
}

export function splitTelegramText(value, maxLength = SAFE_CHUNK_SIZE) {
  const text = String(value ?? '');
  if (!text) return [];
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    let splitAt = window.lastIndexOf('\n');
    if (splitAt < Math.floor(maxLength * 0.55)) splitAt = window.lastIndexOf(' ');
    if (splitAt < Math.floor(maxLength * 0.55)) splitAt = maxLength;
    if (/^[\uDC00-\uDFFF]$/.test(remaining[splitAt])) splitAt -= 1;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    const delimiter = remaining[splitAt];
    remaining = remaining.slice(splitAt + (delimiter === '\n' || delimiter === ' ' ? 1 : 0));
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function callContextApi(ctx, method, payload, signal, fallback) {
  if (ctx?.chat?.id != null && typeof ctx.telegram?.callApi === 'function') {
    return ctx.telegram.callApi(
      method,
      { chat_id: ctx.chat.id, ...messageThreadOptions(ctx), ...payload },
      { signal },
    );
  }
  return fallback();
}

function callTelegramApi(telegram, method, payload, signal, fallback) {
  if (typeof telegram?.callApi === 'function') {
    return telegram.callApi(method, payload, { signal });
  }
  return fallback();
}

function recordContextTelegramResult(ctx, result) {
  if (typeof ctx?.state?.agygramRecordTelegramResult === 'function') {
    ctx.state.agygramRecordTelegramResult(result, 'out');
  }
  return result;
}

export async function replyLong(ctx, text, extra = undefined, deliveryOptions = undefined) {
  const match = text.match(/\/retry\s+([0-9a-f]{8,32})(?:\s+(confirm))?/i);
  if (match) {
    const id = match[1];
    const confirm = match[2];
    const button = confirm
      ? { text: '✓ 명시 승인 및 재시도', callback_data: `tg:confirm-${id}` }
      : { text: '🔄 작업 재시도', callback_data: `tg:retry-${id}` };
    extra = { ...(extra || {}) };
    extra.reply_markup = { ...(extra.reply_markup || {}) };
    extra.reply_markup.inline_keyboard = [...(extra.reply_markup.inline_keyboard || [])];
    extra.reply_markup.inline_keyboard.push([button]);
  }
  const chunks = splitTelegramText(text);
  return deliverParts({
    transport: 'reply',
    parts: chunks,
    deliveryOptions,
    deliver: (chunk, index, signal) => {
      const formatted = formatTelegramChunk(chunk, chunks.length === 1);
      const options = {
        ...(index === chunks.length - 1 ? extra || {} : {}),
      };
      if (formatted.parseMode && options.parse_mode == null) options.parse_mode = formatted.parseMode;
      const finalOptions = Object.keys(options).length > 0 ? options : undefined;
      return callContextApi(
        ctx,
        'sendMessage',
        { ...(finalOptions || {}), text: formatted.text },
        signal,
        () => ctx.reply(formatted.text, finalOptions),
      ).then((result) => recordContextTelegramResult(ctx, result));
    },
  });
}

export async function sendLong(
  telegram,
  chatId,
  text,
  commonExtra = undefined,
  lastExtra = undefined,
  deliveryOptions = undefined,
) {
  const match = text.match(/\/retry\s+([0-9a-f]{8,32})(?:\s+(confirm))?/i);
  if (match) {
    const id = match[1];
    const confirm = match[2];
    const button = confirm
      ? { text: '✓ 명시 승인 및 재시도', callback_data: `tg:confirm-${id}` }
      : { text: '🔄 작업 재시도', callback_data: `tg:retry-${id}` };
    lastExtra = { ...(lastExtra || {}) };
    lastExtra.reply_markup = { ...(lastExtra.reply_markup || {}) };
    lastExtra.reply_markup.inline_keyboard = [...(lastExtra.reply_markup.inline_keyboard || [])];
    lastExtra.reply_markup.inline_keyboard.push([button]);
  }
  const chunks = splitTelegramText(text);
  return deliverParts({
    transport: 'sendMessage',
    parts: chunks,
    deliveryOptions,
    deliver: (chunk, index, signal) => {
      const formatted = formatTelegramChunk(chunk, chunks.length === 1);
      const options = {
        ...(commonExtra || {}),
        ...(index === chunks.length - 1 ? lastExtra || {} : {}),
      };
      if (formatted.parseMode && options.parse_mode == null) options.parse_mode = formatted.parseMode;
      const finalOptions = Object.keys(options).length > 0 ? options : undefined;
      return callTelegramApi(
        telegram,
        'sendMessage',
        { chat_id: chatId, text: formatted.text, ...(finalOptions || {}) },
        signal,
        () => telegram.sendMessage(chatId, formatted.text, finalOptions),
      );
    },
  });
}

export async function sendAgyResponse(
  ctx,
  text,
  maxInlineChars = 20_000,
  deliveryOptions = undefined,
) {
  if (text.length <= maxInlineChars) {
    return replyLong(ctx, text, undefined, deliveryOptions);
  }

  return deliverParts({
    transport: 'document',
    parts: [text],
    deliveryOptions,
    deliver: (content, _index, signal) => {
      const document = { source: Buffer.from(content, 'utf8'), filename: 'agy-response.txt' };
      const extra = { caption: '응답이 길어 텍스트 파일로 보냅니다.' };
      return callContextApi(
        ctx,
        'sendDocument',
        { document, ...extra },
        signal,
        () => ctx.replyWithDocument(document, extra),
      ).then((result) => recordContextTelegramResult(ctx, result));
    },
  });
}

export async function sendAgyResponseFile(ctx, filePath, deliveryOptions = undefined) {
  try {
    const stats = await stat(filePath).catch(() => null);
    if (stats && stats.size > 48 * 1024 * 1024) {
      const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
      const text = `⚠️ 결과 파일 크기(${sizeMb} MB)가 텔레그램 Bot API 전송 제한(50MB)을 초과합니다.\n결과물이 서버 로컬 경로에 저장되었으니 직접 확인해 주세요:\n\`${filePath}\``;
      return await replyLong(ctx, text, undefined, deliveryOptions);
    }
  } catch (error) {
    console.warn('File size check failed', error);
  }

  const streams = new Set();
  const closing = new WeakMap();
  const closeStream = (stream) => {
    if (stream.closed) {
      streams.delete(stream);
      return Promise.resolve();
    }
    let pending = closing.get(stream);
    if (!pending) {
      pending = new Promise((resolve) => {
        const ignoreError = () => {};
        const onClose = () => {
          stream.removeListener('error', ignoreError);
          streams.delete(stream);
          resolve();
        };
        // Destroying a stream that has not opened yet can surface its open
        // error before `close`. Keep that error observed, but retain the result
        // lease until the descriptor is actually closed.
        stream.on('error', ignoreError);
        stream.once('close', onClose);
        stream.destroy();
      });
      closing.set(stream, pending);
    }
    return pending;
  };
  const closeAllStreams = () => Promise.all([...streams].map(closeStream));

  try {
    return await deliverParts({
      transport: 'document-file',
      parts: [filePath],
      deliveryOptions,
      deliver: async (source, _index, signal) => {
        // retryTelegramCall can time an attempt out before an underlying HTTP
        // promise observes its AbortSignal. Drain every previous attempt before
        // opening the next file descriptor.
        await closeAllStreams();
        const stream = createReadStream(source);
        streams.add(stream);
        const onAbort = () => stream.destroy();
        signal?.addEventListener('abort', onAbort, { once: true });
        const document = { source: stream, filename: 'agy-response.txt' };
        const extra = { caption: '응답이 길어 텍스트 파일로 보냅니다.' };
        try {
          const result = await waitForAbortable(
            callContextApi(
              ctx,
              'sendDocument',
              { document, ...extra },
              signal,
              () => ctx.replyWithDocument(document, extra),
            ),
            signal,
          );
          return recordContextTelegramResult(ctx, result);
        } finally {
          signal?.removeEventListener('abort', onAbort);
          await closeStream(stream);
        }
      },
    });
  } finally {
    // The retry wrapper deliberately races hung transports with cancellation.
    // Its operation promise can therefore still be pending here; explicitly
    // close every owned stream before the caller releases its ResultStore lease.
    await closeAllStreams();
  }
}

export function commandArgument(ctx) {
  const text = ctx.message?.text || '';
  return text.replace(/^\/\w+(?:@\w+)?(?:\s+|$)/, '').trim();
}

export function startTyping(ctx, { signal, attemptTimeoutMs = 10_000 } = {}) {
  let stopped = false;
  const send = () => {
    if (stopped || signal?.aborted) return;
    retryTelegramCall(
      (attemptSignal) => callContextApi(
        ctx,
        'sendChatAction',
        { action: 'typing' },
        attemptSignal,
        () => ctx.sendChatAction('typing'),
      ),
      { signal, attemptTimeoutMs, maxAttempts: 1, operation: 'typing status' },
    ).catch(() => {});
  };
  send();
  const timer = setInterval(send, 4_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export const _private = {
  TELEGRAM_TEXT_LIMIT,
  SAFE_CHUNK_SIZE,
  DEFAULT_RETRY_OPTIONS,
  retryDelayMs,
  markdownToTelegramHtml,
};
