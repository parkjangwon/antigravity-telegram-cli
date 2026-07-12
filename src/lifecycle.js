const defaultSleep = (delayMs) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });

function asErrorDetails(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
  };
}

class StopRequestedDuringLaunch extends Error {
  constructor() {
    super('Bot launch was cancelled because shutdown was requested');
    this.name = 'StopRequestedDuringLaunch';
  }
}

class BotStopTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Bot transport did not stop within ${timeoutMs}ms`);
    this.name = 'BotStopTimeoutError';
    this.code = 'BOT_STOP_TIMEOUT';
  }
}

/**
 * Coordinates Telegraf startup and graceful shutdown without assuming that
 * `bot.polling` is created synchronously by `bot.launch()`.
 */
export class LifecycleController {
  #bot;
  #tasks;
  #auth;
  #admissions;
  #sleep;
  #logger;
  #stopReadyTimeoutMs;
  #stopReadyPollMs;
  #idleTimeoutMs;
  #botStopTimeoutMs;
  #startPromise = null;
  #setupPromise = null;
  #stopPromise = null;
  #stopRequestedPromise;
  #resolveStopRequested;
  #stopReason = null;
  #launchStarted = false;
  #launchSettled = false;
  #setupStarted = false;
  #setupSettled = false;
  #shutdownComponentsIdle = false;
  #botStopped = false;
  #botStopPromise = null;
  #botStopOperation = null;
  #launchPromise = null;
  #startupAbortController = new AbortController();

  constructor({
    bot,
    tasks,
    auth,
    admissions,
    sleep = defaultSleep,
    logger = console,
    stopReadyTimeoutMs = 5_000,
    stopReadyPollMs = 25,
    idleTimeoutMs = 8_000,
    botStopTimeoutMs = 5_000,
  }) {
    if (!bot || typeof bot.launch !== 'function' || typeof bot.stop !== 'function') {
      throw new TypeError('bot must provide launch() and stop()');
    }
    if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
    if (!Number.isFinite(stopReadyTimeoutMs) || stopReadyTimeoutMs < 0) {
      throw new RangeError('stopReadyTimeoutMs must be a non-negative number');
    }
    if (!Number.isFinite(stopReadyPollMs) || stopReadyPollMs <= 0) {
      throw new RangeError('stopReadyPollMs must be a positive number');
    }
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
      throw new RangeError('idleTimeoutMs must be a non-negative number');
    }
    if (!Number.isFinite(botStopTimeoutMs) || botStopTimeoutMs < 0) {
      throw new RangeError('botStopTimeoutMs must be a non-negative number');
    }

    this.#bot = bot;
    this.#tasks = tasks;
    this.#auth = auth;
    this.#admissions = admissions;
    this.#sleep = sleep;
    this.#logger = logger;
    this.#stopReadyTimeoutMs = stopReadyTimeoutMs;
    this.#stopReadyPollMs = stopReadyPollMs;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#botStopTimeoutMs = botStopTimeoutMs;
    this.#stopRequestedPromise = new Promise((resolve) => {
      this.#resolveStopRequested = resolve;
    });
  }

  get stopping() {
    return this.#stopPromise !== null;
  }

  get launchStarted() {
    return this.#launchStarted;
  }

  get launchSettled() {
    return !this.#launchStarted || this.#launchSettled;
  }

  get setupSettled() {
    return !this.#setupStarted || this.#setupSettled;
  }

  /**
   * True only after shutdown has sealed/cancelled every managed component and
   * both startup setup and bot.launch have actually settled. Callers may use
   * this as the authority for releasing the single-instance lock.
   */
  get quiescent() {
    return (
      this.stopping &&
      this.#shutdownComponentsIdle &&
      this.setupSettled &&
      this.launchSettled &&
      (this.#botStopped || !this.#transportReady())
    );
  }

  get stopReason() {
    return this.#stopReason;
  }

  /**
   * Installs one-shot signal handlers early in startup. The returned function
   * removes handlers that have not fired yet, which is useful in tests and
   * embedders.
   */
  installSignalHandlers(target = process, signals = ['SIGINT', 'SIGTERM']) {
    if (!target || typeof target.once !== 'function' || typeof target.removeListener !== 'function') {
      throw new TypeError('signal target must provide once() and removeListener()');
    }

    const bindings = signals.map((signal) => {
      const handler = () => {
        this.requestStop(signal).catch((error) => {
          this.#logger.error?.('Lifecycle shutdown failed', asErrorDetails(error));
        });
      };
      target.once(signal, handler);
      return [signal, handler];
    });

    let installed = true;
    return () => {
      if (!installed) return false;
      installed = false;
      for (const [signal, handler] of bindings) target.removeListener(signal, handler);
      return true;
    };
  }

  /**
   * Runs the ordered startup sequence once. A stop requested before startup or
   * while commands are being configured prevents `bot.launch()` from running.
   */
  start({ setCommands, launchOptions = { dropPendingUpdates: false }, onLaunch } = {}) {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#runStart({ setCommands, launchOptions, onLaunch });
    return this.#startPromise;
  }

  async #runStart({ setCommands, launchOptions, onLaunch }) {
    if (this.stopping) {
      await this.#stopPromise;
      return { launched: false, skipped: 'stopping' };
    }

    if (setCommands) {
      this.#setupStarted = true;
      this.#setupPromise = this.#observeSetup(setCommands);
      const setupOutcome = await Promise.race([
        this.#setupPromise,
        this.#stopRequestedPromise.then(() => ({ status: 'stop-requested' })),
      ]);
      if (setupOutcome.status === 'stop-requested') {
        await this.#stopPromise;
        return { launched: false, skipped: 'stopping' };
      }
      if (setupOutcome.status === 'rejected') {
        if (this.stopping && this.#startupAbortController.signal.aborted) {
          await this.#stopPromise;
          return { launched: false, skipped: 'stopping' };
        }
        await this.#shutdownAfterFatal('set-commands-error');
        throw setupOutcome.error;
      }
    }

    if (this.stopping) {
      await this.#stopPromise;
      return { launched: false, skipped: 'stopping' };
    }

    this.#launchStarted = true;
    const restoreTransportGuards = this.#installTransportGuards();
    const launchCallback = (...args) => {
      // Telegraf invokes this after getMe but before it creates either
      // transport. The guarded transport entrypoint below will abort the rest
      // of launch; if a custom launcher already created one, stop it now.
      if (this.stopping) {
        if (this.#transportReady()) this.#retryLateBotStop();
        return undefined;
      }
      return onLaunch?.(...args);
    };

    const launchOutcome = this.#observeLaunch(
      launchOptions,
      launchCallback,
      restoreTransportGuards,
    );
    this.#launchPromise = launchOutcome;
    const outcome = await Promise.race([
      launchOutcome,
      this.#stopRequestedPromise.then(() => ({ status: 'stop-requested' })),
    ]);

    if (outcome.status === 'stop-requested') {
      await this.#stopPromise;
      return { launched: true, skipped: null };
    }
    if (outcome.status === 'rejected') {
      await this.#shutdownAfterFatal('launch-error');
      throw outcome.error;
    }

    if (this.#stopPromise) await this.#stopPromise;
    return { launched: true, skipped: null };
  }

  /**
   * Begins graceful shutdown once and returns the same Promise to every caller.
   */
  requestStop(reason = 'shutdown') {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopReason = String(reason || 'shutdown');
    this.#stopPromise = this.#runStop(this.#stopReason);
    this.#startupAbortController.abort(
      new Error(`Startup cancelled because shutdown was requested: ${this.#stopReason}`),
    );
    this.#resolveStopRequested();
    return this.#stopPromise;
  }

  async #observeSetup(setCommands) {
    try {
      await setCommands(this.#startupAbortController.signal);
      return { status: 'fulfilled' };
    } catch (error) {
      return { status: 'rejected', error };
    } finally {
      this.#setupSettled = true;
    }
  }

  async #shutdownAfterFatal(reason) {
    if (!this.stopping) await this.requestStop(reason);
    else await this.#stopPromise;
  }

  async #observeLaunch(launchOptions, launchCallback, restoreTransportGuards) {
    let outcome;
    try {
      await this.#bot.launch(launchOptions, launchCallback);
      outcome = { status: 'fulfilled' };
    } catch (error) {
      outcome =
        error instanceof StopRequestedDuringLaunch && this.stopping
          ? { status: 'fulfilled' }
          : { status: 'rejected', error };
    } finally {
      this.#launchSettled = true;
      if (this.stopping && !this.#botStopped) {
        await this.#stopBotWhenReady(this.#stopReason).catch((error) => {
          this.#logger.warn?.('Late bot shutdown failed', asErrorDetails(error));
        });
      }
      restoreTransportGuards();
    }
    return outcome;
  }

  /**
   * Telegraf creates polling/webhook transports after asynchronous API calls.
   * A shutdown can therefore finish its bounded readiness wait before either
   * transport exists. Keep these gates installed until launch itself settles
   * so a transport can never start after a stop was requested.
   */
  #installTransportGuards() {
    const restorers = [];
    for (const methodName of ['startPolling', 'startWebhook']) {
      const original = this.#bot[methodName];
      if (typeof original !== 'function') continue;

      const hadOwnProperty = Object.hasOwn(this.#bot, methodName);
      const ownDescriptor = Object.getOwnPropertyDescriptor(this.#bot, methodName);
      const guarded = (...args) => {
        if (this.stopping) {
          // Throw instead of returning a dummy transport result. In webhook
          // mode Telegraf would otherwise continue and register the remote
          // webhook even though no local server was started.
          throw new StopRequestedDuringLaunch();
        }
        return Reflect.apply(original, this.#bot, args);
      };

      try {
        Object.defineProperty(this.#bot, methodName, {
          configurable: true,
          writable: true,
          value: guarded,
        });
      } catch (error) {
        this.#logger.warn?.('Unable to install transport lifecycle guard', {
          method: methodName,
          ...asErrorDetails(error),
        });
        continue;
      }

      restorers.push(() => {
        if (this.#bot[methodName] !== guarded) return;
        if (hadOwnProperty) Object.defineProperty(this.#bot, methodName, ownDescriptor);
        else delete this.#bot[methodName];
      });
    }

    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      for (const restore of restorers.reverse()) restore();
    };
  }

  async #runStop(reason) {
    const errors = [];
    const admissionsClosed = this.#closeAdmissions(errors);
    this.#cancelAll(this.#tasks, 'tasks', errors);
    this.#cancelAll(this.#auth, 'auth', errors);

    const [bot, admissions, tasks, auth] = await Promise.all([
      this.#stopBotWhenReady(reason).catch((error) => {
        errors.push({ component: 'bot', ...asErrorDetails(error) });
        this.#logger.warn?.('Bot shutdown failed', asErrorDetails(error));
        return false;
      }),
      this.#waitForIdle(this.#admissions, 'admissions', errors),
      this.#waitForIdle(this.#tasks, 'tasks', errors),
      this.#waitForIdle(this.#auth, 'auth', errors),
    ]);

    await this.#waitForBackgroundSettlement(this.#idleTimeoutMs);
    const botQuiescent = this.#botStopped || !this.#transportReady();
    this.#shutdownComponentsIdle = admissionsClosed && admissions && tasks && auth;

    return {
      reason,
      botStopped: bot || this.#botStopped,
      botQuiescent,
      admissionsClosed,
      admissionsIdle: admissions,
      tasksIdle: tasks,
      authIdle: auth,
      setupSettled: this.setupSettled,
      launchSettled: this.launchSettled,
      quiescent: this.quiescent,
      errors,
    };
  }

  #closeAdmissions(errors) {
    if (typeof this.#admissions?.close !== 'function') return true;
    try {
      this.#admissions.close(new Error('Application shutting down'));
      return true;
    } catch (error) {
      errors.push({ component: 'admissions', operation: 'close', ...asErrorDetails(error) });
      this.#logger.warn?.('admissions close failed', asErrorDetails(error));
      return false;
    }
  }

  async #waitForBackgroundSettlement(timeoutMs) {
    if (this.setupSettled && this.launchSettled) return true;
    if (timeoutMs === 0) return false;

    const pending = [];
    if (!this.setupSettled && this.#setupPromise) pending.push(this.#setupPromise);
    if (!this.launchSettled && this.#launchPromise) pending.push(this.#launchPromise);
    if (pending.length === 0) return this.setupSettled && this.launchSettled;

    await Promise.race([
      Promise.all(pending),
      this.#sleep(timeoutMs),
    ]);
    return this.setupSettled && this.launchSettled;
  }

  #cancelAll(component, name, errors) {
    if (typeof component?.cancelAll !== 'function') return;
    try {
      component.cancelAll();
    } catch (error) {
      errors.push({ component: name, operation: 'cancelAll', ...asErrorDetails(error) });
      this.#logger.warn?.(`${name} cancellation failed`, asErrorDetails(error));
    }
  }

  async #waitForIdle(component, name, errors) {
    if (typeof component?.waitForIdle !== 'function') return true;
    try {
      return Boolean(await component.waitForIdle(this.#idleTimeoutMs));
    } catch (error) {
      errors.push({ component: name, operation: 'waitForIdle', ...asErrorDetails(error) });
      this.#logger.warn?.(`${name} idle wait failed`, asErrorDetails(error));
      return false;
    }
  }

  #transportReady() {
    return Boolean(this.#bot.polling || this.#bot.webhookServer);
  }

  async #stopBotWhenReady(reason) {
    if (!this.#launchStarted || this.#botStopped) return this.#botStopped;

    const waits = Math.ceil(this.#stopReadyTimeoutMs / this.#stopReadyPollMs);
    for (let attempt = 0; ; attempt += 1) {
      if (this.#transportReady()) return this.#stopBot(reason);
      if (this.#launchSettled || attempt >= waits) return false;
      await this.#sleep(this.#stopReadyPollMs);
    }
  }

  async #stopBot(reason) {
    if (this.#botStopped) return true;
    if (this.#botStopPromise) return this.#botStopPromise;

    if (!this.#botStopOperation) {
      this.#botStopOperation = Promise.resolve()
        .then(() => this.#bot.stop(reason))
        .then(
          () => {
            this.#botStopped = true;
            return { status: 'fulfilled' };
          },
          (error) => ({ status: 'rejected', error }),
        );
    }
    this.#botStopPromise = this.#waitForBotStopOperation();

    try {
      return await this.#botStopPromise;
    } finally {
      if (!this.#botStopped) this.#botStopPromise = null;
    }
  }

  async #waitForBotStopOperation() {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), this.#botStopTimeoutMs);
    });
    const outcome = await Promise.race([this.#botStopOperation, timeout]);
    clearTimeout(timer);

    if (outcome.status === 'timeout') {
      throw new BotStopTimeoutError(this.#botStopTimeoutMs);
    }
    if (outcome.status === 'rejected') throw outcome.error;
    return true;
  }

  #retryLateBotStop() {
    this.#stopBotWhenReady(this.#stopReason).catch((error) => {
      this.#logger.warn?.('Late bot shutdown failed', asErrorDetails(error));
    });
  }
}

export const _private = { defaultSleep };
