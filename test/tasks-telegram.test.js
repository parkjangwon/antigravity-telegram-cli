import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BusyError, KeyedMutex, QueueTimeoutError, TaskManager } from '../src/tasks.js';
import { runWithUsage } from '../src/usage-store.js';
import {
  _private,
  abortActiveTelegramCalls,
  classifyUpdateAge,
  guardTelegramClient,
  hasActiveTelegramCalls,
  replyLong,
  retryTelegramCall,
  sendAgyResponse,
  sendAgyResponseFile,
  sendLong,
  sessionKey,
  shutdownTelegramCalls,
  splitTelegramText,
  storageScope,
  waitForTelegramIdle,
  TelegramDeliveryError,
  TelegramRequestError,
} from '../src/telegram.js';

test('TaskManager rejects overlapping work for one chat', async () => {
  const manager = new TaskManager(2);
  let release;
  const first = manager.run('1', () => new Promise((resolve) => (release = resolve)));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(manager.run('1', async () => {}), BusyError);
  release('done');
  assert.equal(await first, 'done');
});

test('TaskManager caps global concurrency', async () => {
  const manager = new TaskManager(1);
  const order = [];
  let releaseFirst;
  const first = manager.run('1', async () => {
    order.push('first-start');
    await new Promise((resolve) => (releaseFirst = resolve));
    order.push('first-end');
  });
  const second = manager.run('2', async () => order.push('second-start'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
});

test('TaskManager bounds how long a queued job may wait', async () => {
  const manager = new TaskManager(1, { maxQueueWaitMs: 20 });
  let releaseFirst;
  const first = manager.run('1', () => new Promise((resolve) => (releaseFirst = resolve)));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(manager.run('2', async () => {}), QueueTimeoutError);
  releaseFirst();
  await first;
});

test('TaskManager uses a shorter queue timeout under backlog pressure', async () => {
  const manager = new TaskManager(1, {
    maxQueueWaitMs: 500,
    overloadThreshold: 0.5,
    overloadQueueWaitMs: 25,
    maxActive: 4,
  });
  let releaseFirst;
  const first = manager.run('1', () => new Promise((resolve) => (releaseFirst = resolve)));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(manager.run('2', async () => {}), QueueTimeoutError);
  releaseFirst();
  await first;
});

test('TaskManager queue deadline includes same-workspace mutex wait but not agy execution', async () => {
  const manager = new TaskManager(2, { maxQueueWaitMs: 25 });
  const mutex = new KeyedMutex();
  let releaseFirst;
  let firstStarted;
  const firstIsRunning = new Promise((resolve) => (firstStarted = resolve));
  let firstSignal;

  const first = manager.run(
    '1',
    (signal, job) => mutex.run('/repo', signal, () => job.runExecution(async () => {
      firstSignal = signal;
      firstStarted();
      await new Promise((resolve) => (releaseFirst = resolve));
      return 'first-result';
    })),
    {},
    { deferExecutionStart: true },
  );
  await firstIsRunning;

  let secondExecuted = false;
  const second = manager.run(
    '2',
    (signal, job) => mutex.run('/repo', signal, () => job.runExecution(async () => {
      secondExecuted = true;
    })),
    {},
    { deferExecutionStart: true },
  );

  await assert.rejects(second, QueueTimeoutError);
  assert.equal(secondExecuted, false);
  assert.equal(firstSignal.aborted, false, 'queue timer must stop once agy execution starts');
  releaseFirst();
  assert.equal(await first, 'first-result');
});

test('deferred TaskManager queue deadline includes global execution-slot wait', async () => {
  const manager = new TaskManager(1, { maxQueueWaitMs: 25 });
  const mutex = new KeyedMutex();
  let usageReservations = 0;
  const runMetered = async (operation) => {
    usageReservations += 1;
    return operation();
  };
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => (markFirstStarted = resolve));

  const first = manager.run(
    '1',
    (signal, job) => mutex.run('/x', signal, () => job.runExecution(() => runMetered(async () => {
      markFirstStarted();
      await new Promise((resolve) => (releaseFirst = resolve));
    }))),
    {},
    { deferExecutionStart: true },
  );
  await firstStarted;

  let secondExecuted = false;
  const second = manager.run(
    '2',
    (signal, job) => mutex.run('/y', signal, () => job.runExecution(() => runMetered(async () => {
      secondExecuted = true;
    }))),
    {},
    { deferExecutionStart: true },
  );

  await assert.rejects(second, QueueTimeoutError);
  assert.equal(secondExecuted, false);
  assert.equal(usageReservations, 1, 'a queue timeout must not create a usage reservation');
  releaseFirst();
  await first;
});

test('same-workspace waiter does not consume a global execution slot', async () => {
  const manager = new TaskManager(2, { maxQueueWaitMs: 1_000 });
  const mutex = new KeyedMutex();
  let releaseA;
  let markAStarted;
  let markBWaiting;
  const aStarted = new Promise((resolve) => (markAStarted = resolve));
  const bWaiting = new Promise((resolve) => (markBWaiting = resolve));
  const order = [];

  const a = manager.run(
    'a',
    (signal, job) => mutex.run('/x', signal, () => job.runExecution(async () => {
      order.push('a-start');
      markAStarted();
      await new Promise((resolve) => (releaseA = resolve));
      order.push('a-end');
    })),
    {},
    { deferExecutionStart: true },
  );
  await aStarted;

  const b = manager.run(
    'b',
    async (signal, job) => {
      markBWaiting();
      return mutex.run('/x', signal, () => job.runExecution(async () => {
        order.push('b-start');
      }));
    },
    {},
    { deferExecutionStart: true },
  );
  await bWaiting;
  await new Promise((resolve) => setImmediate(resolve));

  const c = manager.run(
    'c',
    (signal, job) => mutex.run('/y', signal, () => job.runExecution(async () => {
      order.push('c-start');
      return 'c-result';
    })),
    {},
    { deferExecutionStart: true },
  );

  assert.equal(await c, 'c-result');
  assert.deepEqual(order, ['a-start', 'c-start']);
  releaseA();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a-start', 'c-start', 'a-end', 'b-start']);
});

test('workspace lock, execution permit, and usage nesting never exceed configured agy concurrency', async () => {
  const manager = new TaskManager(2, { maxQueueWaitMs: 1_000 });
  const mutex = new KeyedMutex();
  const usage = {
    reserve: async () => {},
    finish: async () => {},
  };
  let running = 0;
  let maxRunning = 0;
  let started = 0;
  let notifyTwoStarted;
  let releaseExecutions;
  const twoStarted = new Promise((resolve) => (notifyTwoStarted = resolve));
  const executionGate = new Promise((resolve) => (releaseExecutions = resolve));

  const executions = Array.from({ length: 6 }, (_, index) => manager.run(
    `chat-${index}`,
    (signal, job) => mutex.run(`/workspace-${index}`, signal, () => job.runExecution(() =>
      runWithUsage(usage, {
        id: `job-${index}`,
        userId: String(1_000 + index),
        operation: async () => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          started += 1;
          if (started === 2) notifyTwoStarted();
          await executionGate;
          running -= 1;
        },
      }))),
    {},
    { deferExecutionStart: true },
  ));

  await twoStarted;
  assert.equal(running, 2);
  assert.equal(maxRunning, 2);
  releaseExecutions();
  await Promise.all(executions);
  assert.equal(maxRunning, 2);
});

test('TaskManager has a hard cap on active plus queued work', async () => {
  const manager = new TaskManager(1, { maxActive: 2, maxQueueWaitMs: 1_000 });
  let releaseFirst;
  const first = manager.run('1', () => new Promise((resolve) => (releaseFirst = resolve)));
  const second = manager.run('2', async () => {});
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    manager.run('3', async () => {}),
    (error) => error instanceof BusyError && error.code === 'TASK_GLOBAL_LIMIT',
  );
  releaseFirst();
  await Promise.all([first, second]);
});

test('TaskManager cancelAll seals the shutdown boundary against late tasks', async () => {
  const manager = new TaskManager(1);
  let observedAbort = false;
  const active = manager.run('active', async (signal) => {
    await new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        observedAbort = true;
        resolve();
      }, { once: true });
    });
  });
  await new Promise((resolve) => setImmediate(resolve));

  manager.cancelAll();
  await active;
  assert.equal(observedAbort, true);
  assert.equal(manager.closed, true);
  await assert.rejects(
    manager.run('late', async () => assert.fail('late task must not start')),
    (error) => error instanceof BusyError && error.code === 'TASK_MANAGER_CLOSED',
  );
});

test('TaskManager exposes queue, job id, and live phases', async () => {
  const manager = new TaskManager(1);
  let release;
  const running = manager.run('1', async (_signal, job) => {
    job.update('running-agy', { workspace: '/repo' });
    await new Promise((resolve) => (release = resolve));
  });
  await new Promise((resolve) => setImmediate(resolve));
  const status = manager.getStatus('1');
  assert.match(status.id, /^[0-9a-f]{8}$/);
  assert.equal(status.state, 'running');
  assert.equal(status.phase, 'running-agy');
  assert.equal(status.metadata.workspace, '/repo');
  release();
  await running;
  assert.equal(manager.getStatus('1'), null);
});

test('KeyedMutex serializes the same workspace but not different workspaces', async () => {
  const mutex = new KeyedMutex();
  const order = [];
  let release;
  const first = mutex.run('/repo', undefined, async () => {
    order.push('first');
    await new Promise((resolve) => (release = resolve));
  });
  const second = mutex.run('/repo', undefined, async () => order.push('second'));
  const other = mutex.run('/other', undefined, async () => order.push('other'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first', 'other']);
  release();
  await Promise.all([first, second, other]);
  assert.deepEqual(order, ['first', 'other', 'second']);
});

test('splitTelegramText stays below limits and does not split surrogate pairs', () => {
  const text = `${'line with words\n'.repeat(400)}${'😀'.repeat(100)}`;
  const chunks = splitTelegramText(text, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(chunks.join('\n').replaceAll('\n', '').includes('\uFFFD'), false);
});

test('Telegram forum topics get independent session and storage keys', () => {
  const ctx = { chat: { id: -100123 }, message: { message_thread_id: 77 } };
  assert.equal(sessionKey(ctx), '-100123:77');
  assert.equal(storageScope(ctx), '-100123-thread-77');
  assert.equal(sessionKey({ chat: { id: 42 }, message: {} }), '42');
});

test('stale mutating updates are rejected while explicitly safe status commands remain readable', () => {
  const nowSeconds = 10_000;
  assert.equal(
    classifyUpdateAge(
      { message: { date: 9_000, text: 'change files' } },
      300,
      { nowSeconds, safeCommands: new Set(['status']) },
    ).stale,
    true,
  );
  assert.equal(
    classifyUpdateAge(
      { message: { date: 9_000, text: '/status' } },
      300,
      { nowSeconds, safeCommands: new Set(['status']) },
    ).stale,
    false,
  );
});

test('sendLong keeps forum thread routing on every chunk', async () => {
  const calls = [];
  const telegram = {
    sendMessage: async (...args) => calls.push(args),
  };
  const report = await sendLong(
    telegram,
    -100123,
    'x'.repeat(8_000),
    { message_thread_id: 77 },
  );
  assert.ok(calls.length > 1);
  assert.ok(calls.every(([, , options]) => options.message_thread_id === 77));
  assert.equal(report.complete, true);
  assert.equal(report.sentParts, calls.length);
});

test('retryTelegramCall honors Telegram retry_after without real sleeping', async () => {
  const delays = [];
  let calls = 0;
  const report = await retryTelegramCall(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('Too Many Requests'), {
          response: {
            error_code: 429,
            parameters: { retry_after: 2 },
          },
        });
      }
      return 'ok';
    },
    {
      operation: 'test rate limit',
      sleep: async (delayMs) => delays.push(delayMs),
      random: () => 0,
    },
  );

  assert.equal(report.value, 'ok');
  assert.equal(report.attempts, 2);
  assert.equal(report.retries, 1);
  assert.equal(report.duplicateRisk, false);
  assert.deepEqual(delays, [2_000]);
});

test('retryTelegramCall exponentially retries 5xx and network failures', async () => {
  const delays = [];
  let calls = 0;
  const report = await retryTelegramCall(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('Telegram unavailable'), {
          response: { error_code: 503 },
        });
      }
      if (calls === 2) {
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      }
      return 'delivered';
    },
    {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
      sleep: async (delayMs) => delays.push(delayMs),
    },
  );

  assert.equal(report.value, 'delivered');
  assert.equal(report.attempts, 3);
  assert.equal(report.duplicateRisk, true);
  assert.deepEqual(delays, [100, 200]);
});

test('retryTelegramCall is bounded and exposes exhausted attempt count', async () => {
  const delays = [];
  let calls = 0;
  await assert.rejects(
    retryTelegramCall(
      async () => {
        calls += 1;
        throw Object.assign(new Error('bad gateway'), {
          response: { error_code: 502 },
        });
      },
      {
        maxAttempts: 3,
        baseDelayMs: 5,
        jitterRatio: 0,
        sleep: async (delayMs) => delays.push(delayMs),
      },
    ),
    (error) => {
      assert.ok(error instanceof TelegramRequestError);
      assert.equal(error.attempts, 3);
      assert.equal(error.retryable, true);
      assert.equal(error.duplicateRisk, true);
      return true;
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5, 10]);
});

test('retryTelegramCall aborts a hung attempt at its per-attempt deadline', async () => {
  let transportSignal;
  await assert.rejects(
    retryTelegramCall(
      (signal) => {
        transportSignal = signal;
        return new Promise(() => {});
      },
      { maxAttempts: 1, attemptTimeoutMs: 10 },
    ),
    (error) => {
      assert.ok(error instanceof TelegramRequestError);
      assert.equal(error.cause?.code, 'TELEGRAM_ATTEMPT_TIMEOUT');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(transportSignal.aborted, true);
  assert.equal(hasActiveTelegramCalls(), false);
});

test('retryTelegramCall propagates external cancellation to the transport and backoff', async () => {
  const controller = new AbortController();
  const reason = new Error('shutdown now');
  let transportSignal;
  const pending = retryTelegramCall(
    (signal) => {
      transportSignal = signal;
      return new Promise(() => {});
    },
    { signal: controller.signal, maxAttempts: 4, attemptTimeoutMs: 5_000 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(transportSignal.aborted, true);
  assert.equal(hasActiveTelegramCalls(), false);
});

test('global Telegram shutdown aborts and drains active delivery calls', async () => {
  const reason = new Error('global shutdown');
  let transportSignal;
  const pending = retryTelegramCall(
    (signal) => {
      transportSignal = signal;
      return new Promise(() => {});
    },
    { maxAttempts: 1, attemptTimeoutMs: 5_000 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hasActiveTelegramCalls(), true);
  abortActiveTelegramCalls(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(transportSignal.aborted, true);
  assert.equal(await waitForTelegramIdle(50), true);
});

test('replyLong uses low-level callApi so the HTTP transport receives its deadline signal', async () => {
  let captured;
  const ctx = {
    chat: { id: -100123 },
    message: { message_thread_id: 77 },
    telegram: {
      callApi: async (...args) => {
        captured = args;
        return { message_id: 1 };
      },
    },
    reply: async () => assert.fail('high-level fallback must not be used'),
  };
  await replyLong(ctx, 'hello', { disable_notification: true });
  assert.equal(captured[0], 'sendMessage');
  assert.deepEqual(captured[1], {
    chat_id: -100123,
    message_thread_id: 77,
    disable_notification: true,
    text: 'hello',
  });
  assert.ok(captured[2].signal instanceof AbortSignal);
});

test('replyLong retries its Telegram call and preserves final options', async () => {
  const calls = [];
  const ctx = {
    reply: async (...args) => {
      calls.push(args);
      if (calls.length === 1) {
        throw Object.assign(new Error('temporary'), {
          response: { error_code: 500 },
        });
      }
    },
  };

  const report = await replyLong(
    ctx,
    'hello',
    { message_thread_id: 77 },
    {
      retry: {
        sleep: async () => {},
        jitterRatio: 0,
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1], { message_thread_id: 77 });
  assert.equal(report.retries, 1);
  assert.equal(report.duplicateRisk, true);
});

test('replyLong renders single-chunk markdown with Telegram HTML parse mode', async () => {
  let captured;
  const ctx = {
    chat: { id: 42 },
    telegram: {
      callApi: async (...args) => {
        captured = args;
        return { message_id: 1 };
      },
    },
    reply: async () => assert.fail('high-level fallback must not be used'),
  };

  await replyLong(ctx, '**Bold** `code` [link](https://example.com)');
  assert.equal(captured[0], 'sendMessage');
  assert.equal(captured[1].parse_mode, 'HTML');
  assert.equal(
    captured[1].text,
    '<b>Bold</b> <code>code</code> <a href="https://example.com">link</a>',
  );
});

test('sendLong keeps multi-chunk text in plain mode to avoid broken rich-text boundaries', async () => {
  const calls = [];
  const telegram = {
    sendMessage: async (...args) => calls.push(args),
  };

  await sendLong(telegram, 1, `**headline**\n${'x'.repeat(7_900)}`);
  assert.ok(calls.length > 1);
  assert.match(calls[0][1], /^\*\*headline\*\*/);
  assert.equal(calls[0][2]?.parse_mode, undefined);
});

test('markdownToTelegramHtml converts common markdown patterns', () => {
  const rendered = _private.markdownToTelegramHtml('# Title\n\n```js\nconst x = 1;\n```');
  assert.equal(
    rendered,
    '<b>Title</b>\n\n<pre><code class="language-js">const x = 1;\n</code></pre>',
  );
});

test('sendLong exposes confirmed chunks and ambiguity after partial failure', async () => {
  let calls = 0;
  const telegram = {
    sendMessage: async () => {
      calls += 1;
      if (calls > 1) {
        throw Object.assign(new Error('chat migrated'), {
          response: { error_code: 400 },
        });
      }
    },
  };

  await assert.rejects(
    sendLong(telegram, 42, 'x'.repeat(5_000), undefined, undefined, {
      retry: { sleep: async () => {} },
    }),
    (error) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.sentParts, 1);
      assert.equal(error.totalParts, 2);
      assert.equal(error.failedPart, 2);
      assert.equal(error.partial, true);
      assert.equal(error.recoverableWithLast, true);
      assert.equal(error.duplicateRisk, false);
      assert.match(error.message, /\/last/);
      return true;
    },
  );
});

test('sendAgyResponse retries document delivery with an injectable sleep', async () => {
  let calls = 0;
  const ctx = {
    replyWithDocument: async (document, options) => {
      calls += 1;
      assert.equal(document.filename, 'agy-response.txt');
      assert.equal(options.caption, '응답이 길어 텍스트 파일로 보냅니다.');
      if (calls === 1) {
        throw Object.assign(new Error('rate limited'), {
          response: { error_code: 429, parameters: { retry_after: 0 } },
        });
      }
    },
  };

  const report = await sendAgyResponse(ctx, 'long response', 1, {
    retry: {
      sleep: async () => {},
      jitterRatio: 0,
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.transport, 'document');
  assert.equal(report.retries, 1);
});

test('sendAgyResponseFile owns and closes its file stream without allocating a response Buffer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-telegram-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'job.txt');
  await writeFile(file, 'retained response');
  let observed;
  let received = '';
  const ctx = {
    replyWithDocument: async (document) => {
      observed = document;
      for await (const chunk of document.source) received += chunk.toString('utf8');
    },
  };
  const report = await sendAgyResponseFile(ctx, file);
  assert.equal(Buffer.isBuffer(observed.source), false);
  assert.equal(observed.source.path, file);
  assert.equal(observed.source.closed, true);
  assert.equal(observed.filename, 'agy-response.txt');
  assert.equal(received, 'retained response');
  assert.equal(report.transport, 'document-file');
});

test('sendAgyResponseFile closes a timed-out stream before its promise rejects', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-telegram-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'job.txt');
  await writeFile(file, 'response that remains unread');
  let observedStream;
  const ctx = {
    chat: { id: 42 },
    telegram: {
      callApi: async (_method, payload) => {
        observedStream = payload.document.source;
        return new Promise(() => {});
      },
    },
  };

  await assert.rejects(
    sendAgyResponseFile(ctx, file, {
      retry: { maxAttempts: 1, attemptTimeoutMs: 10 },
    }),
    TelegramDeliveryError,
  );
  assert.ok(observedStream);
  assert.equal(observedStream.closed, true);
});

test('sendAgyResponseFile closes a timed-out attempt before opening its retry stream', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-telegram-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'job.txt');
  await writeFile(file, 'retry response');
  const streams = [];
  let calls = 0;
  const ctx = {
    chat: { id: 42 },
    telegram: {
      callApi: async (_method, payload) => {
        calls += 1;
        streams.push(payload.document.source);
        if (calls === 1) return new Promise(() => {});
        assert.equal(streams[0].closed, true);
        for await (const _chunk of payload.document.source) {
          // Consume the retry stream as the HTTP client would.
        }
        return { message_id: 1 };
      },
    },
  };

  const report = await sendAgyResponseFile(ctx, file, {
    retry: {
      maxAttempts: 2,
      attemptTimeoutMs: 10,
      sleep: async () => {},
      jitterRatio: 0,
    },
  });
  assert.equal(calls, 2);
  assert.equal(streams.every((stream) => stream.closed), true);
  assert.equal(report.retries, 1);
});

test('guarded getUpdates preserves fatal native polling errors', async () => {
  const nativeError = Object.assign(new Error('Conflict'), {
    name: 'TelegramError',
    response: { error_code: 409 },
  });
  const client = guardTelegramClient({
    callApi: async () => {
      throw nativeError;
    },
  });
  const polling = new AbortController();
  await assert.rejects(
    client.callApi('getUpdates', { timeout: 50 }, { signal: polling.signal }),
    (error) => error === nativeError,
  );
});

test('guarded getUpdates consumes transient Telegram failures before Telegraf backoff', async () => {
  let calls = 0;
  const client = guardTelegramClient({
    callApi: async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('Too Many Requests'), {
          response: { error_code: 429, parameters: { retry_after: 0 } },
        });
      }
      return [];
    },
  });
  const polling = new AbortController();
  assert.deepEqual(
    await client.callApi('getUpdates', { timeout: 50 }, { signal: polling.signal }),
    [],
  );
  assert.equal(calls, 2);
});

test('guarded getUpdates deadline backoff remains abortable', async () => {
  let transportSignal;
  const client = guardTelegramClient({
    callApi: async (_method, _payload, { signal }) => {
      transportSignal = signal;
      return new Promise(() => {});
    },
  }, { attemptTimeoutMs: 5 });
  const polling = new AbortController();
  const reason = new Error('stop polling');
  const pending = client.callApi('getUpdates', {}, { signal: polling.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  polling.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(transportSignal.aborted, true);
});

test('guarded Telegraf clients abort direct calls and reject calls admitted after shutdown', async () => {
  const shutdown = new Error('gateway stopped');
  let calls = 0;
  const transportSignals = [];
  const client = guardTelegramClient({
    callApi: async (method, _payload, { signal }) => {
      calls += 1;
      transportSignals.push(signal);
      if (method === 'getUpdates') {
        throw Object.assign(new Error('long rate limit'), {
          response: { error_code: 429, parameters: { retry_after: 120 } },
        });
      }
      return new Promise(() => {});
    },
  });

  const pending = client.callApi('sendMessage', { chat_id: 1, text: 'hello' });
  const polling = new AbortController();
  const pendingPoll = client.callApi(
    'getUpdates',
    { timeout: 50 },
    { signal: polling.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  shutdownTelegramCalls(shutdown);
  await assert.rejects(pending, (error) => error === shutdown);
  await assert.rejects(pendingPoll, (error) => error === shutdown);
  assert.equal(transportSignals.every((signal) => signal.aborted), true);
  assert.equal(await waitForTelegramIdle(50), true);

  await assert.rejects(
    client.callApi('sendMessage', { chat_id: 1, text: 'late' }),
    (error) => error === shutdown,
  );
  assert.equal(calls, 2);
});
