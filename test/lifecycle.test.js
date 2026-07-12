import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { AdmissionController } from '../src/admission.js';
import { LifecycleController } from '../src/lifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function idleComponent() {
  return {
    cancelCalls: 0,
    waitCalls: [],
    cancelAll() {
      this.cancelCalls += 1;
    },
    async waitForIdle(timeoutMs) {
      this.waitCalls.push(timeoutMs);
      return true;
    },
  };
}

function quietLogger() {
  return { error() {}, warn() {} };
}

test('a signal received before startup skips command setup and launch', async () => {
  const signals = new EventEmitter();
  const tasks = idleComponent();
  const auth = idleComponent();
  let commandCalls = 0;
  let launchCalls = 0;
  const bot = {
    async launch() {
      launchCalls += 1;
    },
    stop() {},
  };
  const lifecycle = new LifecycleController({ bot, tasks, auth, logger: quietLogger() });
  const removeSignals = lifecycle.installSignalHandlers(signals);

  signals.emit('SIGTERM');
  const result = await lifecycle.start({
    setCommands: async () => {
      commandCalls += 1;
    },
  });

  assert.deepEqual(result, { launched: false, skipped: 'stopping' });
  assert.equal(commandCalls, 0);
  assert.equal(launchCalls, 0);
  assert.equal(tasks.cancelCalls, 1);
  assert.equal(auth.cancelCalls, 1);
  assert.deepEqual(tasks.waitCalls, [8_000]);
  assert.equal(removeSignals(), true);
  assert.equal(removeSignals(), false);
});

test('a stop requested during setCommands prevents launch', async () => {
  const configuring = deferred();
  const tasks = idleComponent();
  const auth = idleComponent();
  let launchCalls = 0;
  const bot = {
    async launch() {
      launchCalls += 1;
    },
    stop() {},
  };
  const lifecycle = new LifecycleController({ bot, tasks, auth, logger: quietLogger() });

  const startup = lifecycle.start({ setCommands: () => configuring.promise });
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = lifecycle.requestStop('test-stop');
  configuring.resolve();

  assert.deepEqual(await startup, { launched: false, skipped: 'stopping' });
  assert.equal((await shutdown).reason, 'test-stop');
  assert.equal(launchCalls, 0);
});

test('shutdown waits a bounded number of injected ticks for delayed polling', async () => {
  const launched = deferred();
  const tasks = idleComponent();
  const auth = idleComponent();
  let stopCalls = 0;
  let sleepCalls = 0;
  const bot = {
    polling: null,
    launch: () => launched.promise,
    stop(reason) {
      stopCalls += 1;
      assert.equal(reason, 'SIGINT');
      launched.resolve();
    },
  };
  const lifecycle = new LifecycleController({
    bot,
    tasks,
    auth,
    logger: quietLogger(),
    stopReadyTimeoutMs: 100,
    stopReadyPollMs: 20,
    sleep: async () => {
      sleepCalls += 1;
      if (sleepCalls === 2) bot.polling = {};
    },
  });

  const startup = lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const firstStop = lifecycle.requestStop('SIGINT');
  const secondStop = lifecycle.requestStop('ignored-second-reason');

  assert.equal(firstStop, secondStop);
  const report = await firstStop;
  assert.equal(report.botStopped, true);
  assert.equal(stopCalls, 1);
  assert.equal(sleepCalls, 2);
  assert.deepEqual(await startup, { launched: true, skipped: null });
});

test('transport readiness polling is bounded when Telegraf never becomes ready', async () => {
  const launched = deferred();
  let sleepCalls = 0;
  const bot = {
    polling: null,
    webhookServer: null,
    launch: () => launched.promise,
    stop() {
      assert.fail('stop must not run without a polling or webhook transport');
    },
  };
  const lifecycle = new LifecycleController({
    bot,
    logger: quietLogger(),
    stopReadyTimeoutMs: 90,
    stopReadyPollMs: 30,
    idleTimeoutMs: 0,
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  const startup = lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const report = await lifecycle.requestStop('bounded');

  assert.equal(report.botStopped, false);
  assert.equal(sleepCalls, 3);
  launched.resolve();
  await startup;
  assert.equal(sleepCalls, 3);
});

test('the launch callback retries a stop after the initial readiness window', async () => {
  const launchFinished = deferred();
  let launchCallback;
  let stopCalls = 0;
  const bot = {
    polling: null,
    launch(_options, callback) {
      launchCallback = callback;
      return launchFinished.promise;
    },
    stop() {
      stopCalls += 1;
      launchFinished.resolve();
    },
  };
  const lifecycle = new LifecycleController({
    bot,
    logger: quietLogger(),
    stopReadyTimeoutMs: 0,
    idleTimeoutMs: 0,
    sleep: async () => assert.fail('zero timeout must not sleep'),
  });

  const startup = lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const report = await lifecycle.requestStop('startup-race');
  assert.equal(report.botStopped, false);

  bot.polling = {};
  launchCallback();
  await startup;
  assert.equal(stopCalls, 1);
});

test('a transport cannot start after the shutdown readiness window expires', async () => {
  const continueLaunch = deferred();
  const pollingFinished = deferred();
  let startPollingCalls = 0;
  let stopCalls = 0;
  const bot = {
    polling: null,
    async launch() {
      await continueLaunch.promise;
      await this.startPolling();
    },
    startPolling() {
      startPollingCalls += 1;
      this.polling = {};
      return pollingFinished.promise;
    },
    stop() {
      stopCalls += 1;
      pollingFinished.resolve();
    },
  };
  const lifecycle = new LifecycleController({
    bot,
    logger: quietLogger(),
    stopReadyTimeoutMs: 0,
    idleTimeoutMs: 0,
    sleep: async () => assert.fail('zero timeout must not sleep'),
  });

  const startup = lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const report = await lifecycle.requestStop('late-transport');

  assert.equal(report.botStopped, false);
  assert.deepEqual(await startup, { launched: true, skipped: null });

  continueLaunch.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(startPollingCalls, 0);
  assert.equal(bot.polling, null);
  assert.equal(stopCalls, 0);
});

test('fatal launch failure cancels active work and waits for idle before surfacing', async () => {
  const fatal = new Error('launch exploded');
  let active = true;
  const tasks = {
    cancelCalls: 0,
    waitCalls: [],
    cancelAll() {
      this.cancelCalls += 1;
      active = false;
    },
    async waitForIdle(timeoutMs) {
      this.waitCalls.push(timeoutMs);
      assert.equal(active, false);
      return true;
    },
  };
  const auth = idleComponent();
  const bot = {
    polling: null,
    async launch() {
      throw fatal;
    },
    stop() {
      assert.fail('a transport was never started');
    },
  };
  const lifecycle = new LifecycleController({
    bot,
    tasks,
    auth,
    logger: quietLogger(),
    idleTimeoutMs: 321,
  });

  await assert.rejects(lifecycle.start(), (error) => error === fatal);
  const report = await lifecycle.requestStop('ignored-after-fatal');

  assert.equal(lifecycle.stopReason, 'launch-error');
  assert.equal(tasks.cancelCalls, 1);
  assert.deepEqual(tasks.waitCalls, [321]);
  assert.equal(auth.cancelCalls, 1);
  assert.equal(report.launchSettled, true);
  assert.equal(report.quiescent, true);
  assert.equal(lifecycle.quiescent, true);
});

test('shutdown waits for polling launch cleanup after bot.stop returns', async () => {
  const launchFinished = deferred();
  const timeout = deferred();
  let stopCalls = 0;
  const bot = {
    polling: {},
    launch: () => launchFinished.promise,
    stop() {
      stopCalls += 1;
      // Telegraf Polling.stop() aborts getUpdates synchronously, but launch
      // remains pending while its final offset synchronization completes.
    },
  };
  const lifecycle = new LifecycleController({
    bot,
    logger: quietLogger(),
    idleTimeoutMs: 500,
    sleep: () => timeout.promise,
  });

  const startup = lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = lifecycle.requestStop('delayed-polling-cleanup');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopCalls, 1);
  assert.equal(lifecycle.launchSettled, false);
  assert.equal(lifecycle.quiescent, false);

  launchFinished.resolve();
  const report = await shutdown;
  await startup;

  assert.equal(report.launchSettled, true);
  assert.equal(report.quiescent, true);
  assert.equal(lifecycle.quiescent, true);
});

test('failed bot stop with a live transport is never reported as quiescent', async () => {
  const launchFinished = deferred();
  const stopError = new Error('polling refused to stop');
  const bot = {
    polling: {},
    launch: () => launchFinished.promise,
    stop() {
      launchFinished.resolve();
      throw stopError;
    },
  };
  const lifecycle = new LifecycleController({
    bot,
    logger: quietLogger(),
    idleTimeoutMs: 100,
  });

  const startup = lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const report = await lifecycle.requestStop('failed-stop');
  await startup;

  assert.equal(report.botStopped, false);
  assert.equal(report.botQuiescent, false);
  assert.equal(report.launchSettled, true);
  assert.equal(report.quiescent, false);
  assert.equal(lifecycle.quiescent, false);
  assert.ok(report.errors.some((error) => error.component === 'bot'));
});

test('timed out bot stop remains non-quiescent and shutdown stays bounded', async () => {
  const launchFinished = deferred();
  const stopFinished = deferred();
  const bot = {
    polling: {},
    launch: () => launchFinished.promise,
    stop: () => stopFinished.promise,
  };
  const lifecycle = new LifecycleController({
    bot,
    logger: quietLogger(),
    botStopTimeoutMs: 0,
    idleTimeoutMs: 0,
  });

  const startup = lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const report = await lifecycle.requestStop('timed-out-stop');
  await startup;

  assert.equal(report.botStopped, false);
  assert.equal(report.botQuiescent, false);
  assert.equal(report.quiescent, false);
  assert.equal(lifecycle.quiescent, false);
  assert.ok(
    report.errors.some(
      (error) => error.component === 'bot' && error.name === 'BotStopTimeoutError',
    ),
  );
});

test('stop aborts and races an outstanding command setup operation', async () => {
  let setupSignal;
  const bot = {
    async launch() {
      assert.fail('launch must be skipped after setup is cancelled');
    },
    stop() {},
  };
  const lifecycle = new LifecycleController({
    bot,
    logger: quietLogger(),
    idleTimeoutMs: 500,
  });

  const startup = lifecycle.start({
    setCommands(signal) {
      setupSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const report = await lifecycle.requestStop('cancel-setup');

  assert.equal(setupSignal.aborted, true);
  assert.deepEqual(await startup, { launched: false, skipped: 'stopping' });
  assert.equal(report.setupSettled, true);
  assert.equal(report.quiescent, true);
});

test('cancellation and idle waits run once even under repeated stop requests', async () => {
  const launchFinished = deferred();
  const tasks = idleComponent();
  const auth = idleComponent();
  let stopCalls = 0;
  const bot = {
    polling: {},
    launch: () => launchFinished.promise,
    stop() {
      stopCalls += 1;
      launchFinished.resolve();
    },
  };
  const lifecycle = new LifecycleController({
    bot,
    tasks,
    auth,
    logger: quietLogger(),
    idleTimeoutMs: 123,
  });

  const startup = lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const shutdowns = Array.from({ length: 5 }, () => lifecycle.requestStop('only-once'));
  assert.ok(shutdowns.every((promise) => promise === shutdowns[0]));
  const reports = await Promise.all(shutdowns);
  await startup;

  assert.ok(reports.every((report) => report === reports[0]));
  assert.equal(stopCalls, 1);
  assert.equal(tasks.cancelCalls, 1);
  assert.equal(auth.cancelCalls, 1);
  assert.deepEqual(tasks.waitCalls, [123]);
  assert.deepEqual(auth.waitCalls, [123]);
});

test('shutdown seals admission before cancelling tasks and drains delayed handoffs', async () => {
  const events = [];
  const gate = new AdmissionController();
  const reservation = gate.reserve({ token: 'pending', sessionKey: 'chat', userId: 'user' });
  const admissions = {
    close(reason) {
      events.push('admissions.close');
      return gate.close(reason);
    },
    async waitForIdle(timeoutMs) {
      events.push('admissions.wait');
      return gate.waitForIdle(timeoutMs);
    },
  };
  const tasks = {
    cancelAll() {
      events.push('tasks.cancelAll');
      assert.equal(reservation.signal.aborted, true);
      // Simulate the snapshot/enqueue owner observing abort and completing its
      // cancelled journal transition before relinquishing admission.
      reservation.release();
    },
    async waitForIdle() {
      events.push('tasks.wait');
      return true;
    },
  };
  const auth = idleComponent();
  const bot = { async launch() {}, stop() {} };
  const lifecycle = new LifecycleController({
    bot,
    admissions,
    tasks,
    auth,
    logger: quietLogger(),
  });

  const report = await lifecycle.requestStop('admission-handoff');

  assert.equal(events[0], 'admissions.close');
  assert.ok(events.indexOf('admissions.close') < events.indexOf('tasks.cancelAll'));
  assert.equal(report.admissionsClosed, true);
  assert.equal(report.admissionsIdle, true);
  assert.equal(report.quiescent, true);
  assert.equal(gate.closed, true);
  assert.equal(gate.size, 0);
});
