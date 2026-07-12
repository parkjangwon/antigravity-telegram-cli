import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

import { terminateProcess } from './agy.js';

function cleanTerminalOutput(value, secret = '') {
  let text = stripVTControlCharacters(String(value ?? ''))
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n');
  if (secret && secret.length >= 3) text = text.split(secret).join('[입력 숨김]');
  return text.trim();
}

export class AuthManager {
  #bin;
  #timeoutMs;
  #forceRemote;
  #sessions = new Map();
  #finishing = new Map();
  #accepting = true;

  constructor({
    bin = 'agy',
    timeoutMs = 900_000,
    forceRemote = true,
    environment = {},
  } = {}) {
    this.#bin = bin;
    this.#timeoutMs = timeoutMs;
    this.#forceRemote = forceRemote;
    this.environment = environment;
  }

  isActive(chatId) {
    return this.#sessions.has(String(chatId));
  }

  hasAnyActive() {
    return this.#sessions.size > 0 || this.#finishing.size > 0;
  }

  start(chatId, { cwd, onOutput, onExit }) {
    const key = String(chatId);
    if (!this.#accepting) throw new Error('Authentication manager is shutting down');
    if (this.#sessions.has(key)) throw new Error('Authentication is already active for this chat');
    if (this.hasAnyActive()) throw new Error('Another authentication session is already active');

    const env = { ...this.environment, NO_COLOR: this.environment.NO_COLOR || '1' };
    if (this.#forceRemote) {
      env.SSH_CONNECTION = env.SSH_CONNECTION || '127.0.0.1 1 127.0.0.1 1';
      env.SSH_TTY = env.SSH_TTY || '/dev/pts/telegram';
    }
    const cliTimeoutSeconds = Math.max(5, Math.floor((this.#timeoutMs - 5_000) / 1_000));
    const args = [
      '--mode',
      'plan',
      '--print-timeout',
      `${cliTimeoutSeconds}s`,
      '--print',
      'Authentication setup only. Reply with exactly AUTHENTICATION_OK. Do not use tools or modify files.',
    ];

    let child;
    try {
      child = spawn(this.#bin, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      throw new Error(`Unable to start the agy authentication process: ${error.message}`, { cause: error });
    }

    const session = {
      child,
      pending: '',
      recentInputs: [],
      lastDelivered: '',
      flushTimer: null,
      timeout: null,
      cancelled: false,
      timedOut: false,
      spawnError: null,
      outputBytes: 0,
      delivery: Promise.resolve(),
      outputExceeded: false,
      terminationLease: null,
      deliveryController: new AbortController(),
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
    };
    this.#sessions.set(key, session);

    const requestTermination = () => {
      session.terminationLease ??= terminateProcess(child);
      return session.terminationLease;
    };

    const flush = () => {
      session.flushTimer = null;
      let cleaned = cleanTerminalOutput(session.pending);
      for (const secret of session.recentInputs) {
        cleaned = cleanTerminalOutput(cleaned, secret);
      }
      session.pending = '';
      if (!cleaned || cleaned === session.lastDelivered) return session.delivery;
      const clipped = cleaned.length > 3_800 ? `…\n${cleaned.slice(-3_798)}` : cleaned;
      session.lastDelivered = cleaned;
      session.delivery = session.delivery
        .then(() => onOutput(clipped, { signal: session.deliveryController.signal }))
        .catch((error) => console.error('Auth output delivery failed', {
          name: error?.name,
          code: error?.code,
          attempts: error?.attempts,
        }));
      return session.delivery;
    };

    const receive = (target) => (data) => {
      session.outputBytes += data.length;
      if (session.outputBytes > 2 * 1024 * 1024) {
        if (!session.outputExceeded) {
          session.outputExceeded = true;
          session.pending = `${session.pending.slice(-10_000)}\n인증 프로세스 출력 제한을 초과했습니다.`;
          child.stdout.pause();
          child.stderr.pause();
          requestTermination();
        }
        return;
      }
      const decoded =
        target === 'stdout'
          ? session.stdoutDecoder.write(data)
          : session.stderrDecoder.write(data);
      session.pending = `${session.pending}${decoded}`.slice(-20_000);
      if (!session.flushTimer) {
        session.flushTimer = setTimeout(flush, /https?:\/\//i.test(session.pending) ? 100 : 500);
      }
    };

    child.stdout.on('data', receive('stdout'));
    child.stderr.on('data', receive('stderr'));
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      session.spawnError = error;
      session.pending += `\nagy 인증 프로세스를 시작할 수 없습니다: ${error.message}`;
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(session.timeout);
      clearTimeout(session.flushTimer);
      if (process.platform !== 'win32' && !session.terminationLease) {
        session.terminationLease = terminateProcess(child, { cleanupReapedGroup: true });
      }
      session.pending += session.stdoutDecoder.end();
      session.pending += session.stderrDecoder.end();
      const delivered = flush();
      this.#sessions.delete(key);
      this.#finishing.set(key, session.deliveryController);
      Promise.all([delivered, session.terminationLease ?? Promise.resolve()])
        .then(() =>
          onExit({
            exitCode,
            signal,
            cancelled: session.cancelled,
            timedOut: session.timedOut,
            error: session.spawnError,
            deliverySignal: session.deliveryController.signal,
          }),
        )
        .catch((error) => console.error('Auth exit delivery failed', {
          name: error?.name,
          code: error?.code,
          attempts: error?.attempts,
        }))
        .finally(() => this.#finishing.delete(key));
    });

    session.timeout = setTimeout(() => {
      session.timedOut = true;
      session.pending += '\n인증 세션 시간이 만료되었습니다.';
      requestTermination();
    }, this.#timeoutMs);
    session.timeout.unref?.();
  }

  input(chatId, text) {
    const session = this.#sessions.get(String(chatId));
    if (!session || !session.child.stdin.writable) return false;
    const value = String(text ?? '').replace(/[\r\n\u0000]/g, '').slice(0, 4_096);
    if (value.length >= 3) {
      session.recentInputs.push(value);
      session.recentInputs = session.recentInputs.slice(-5);
    }
    session.child.stdin.write(`${value}\n`);
    return true;
  }

  cancel(chatId) {
    const key = String(chatId);
    const session = this.#sessions.get(key);
    if (!session) {
      const finishing = this.#finishing.get(key);
      if (!finishing) return false;
      finishing.abort(new Error('Authentication cancelled by user'));
      return true;
    }
    session.cancelled = true;
    session.deliveryController.abort(new Error('Authentication cancelled by user'));
    session.terminationLease ??= terminateProcess(session.child);
    return true;
  }

  cancelAll() {
    this.#accepting = false;
    for (const session of this.#sessions.values()) {
      session.cancelled = true;
      session.deliveryController.abort(new Error('Application shutting down'));
      session.terminationLease ??= terminateProcess(session.child);
    }
    for (const controller of this.#finishing.values()) {
      controller.abort(new Error('Application shutting down'));
    }
  }

  async waitForIdle(timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.hasAnyActive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !this.hasAnyActive();
  }
}

export const _private = { cleanTerminalOutput };
