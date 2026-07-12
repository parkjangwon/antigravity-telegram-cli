import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _private as authPrivate, AuthManager } from '../src/auth.js';
import {
  _private as filePrivate,
  cleanupExpiredUploads,
  downloadTelegramFile,
  releaseUploadLease,
} from '../src/files.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agy-files-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeJob(root, scope, name, contents, ageMs, fileName = 'upload.bin') {
  const directory = path.join(root, scope, name);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, contents);
  const date = new Date(Date.now() - ageMs);
  await utimes(filePath, date, date);
  await utimes(directory, date, date);
  return directory;
}

async function assertProcessGone(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} remained alive after termination lease`);
}

test('terminal cleanup strips control codes and redacts the latest input', () => {
  const cleaned = authPrivate.cleanTerminalOutput('\u001b[31mOAuth code: secret-code\u001b[0m\r\nDone', 'secret-code');
  assert.equal(cleaned.includes('\u001b'), false);
  assert.equal(cleaned.includes('secret-code'), false);
  assert.match(cleaned, /\[입력 숨김\]/);
});

test('AuthManager remains busy until a cancelled process-tree lease completes', { skip: process.platform === 'win32' }, async (t) => {
  const root = await temporaryDirectory(t);
  const pidFile = path.join(root, 'auth-descendant.pid');
  const shim = path.join(root, 'fake-auth-agy');
  const descendantScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  await writeFile(
    shim,
    `#!/usr/bin/env node\n${[
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{detached:true,stdio:'ignore'})`,
      'child.unref()',
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
      "process.on('SIGTERM',()=>process.exit(0))",
      'setInterval(()=>{},1000)',
    ].join(';')}\n`,
  );
  await chmod(shim, 0o755);

  const manager = new AuthManager({
    bin: shim,
    timeoutMs: 30_000,
    environment: { PATH: process.env.PATH },
  });
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  manager.start('123', {
    cwd: root,
    onOutput: async () => {},
    onExit: async () => resolveExit(),
  });

  let descendantPid = null;
  try {
    const fileDeadline = Date.now() + 2_000;
    while (!descendantPid && Date.now() < fileDeadline) {
      descendantPid = Number(await readFile(pidFile, 'utf8').catch(() => '0')) || null;
      if (!descendantPid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(descendantPid, 'fake auth process did not create its descendant');

    const startedAt = Date.now();
    assert.equal(manager.cancel('123'), true);
    assert.equal(await manager.waitForIdle(5_000), true);
    assert.ok(Date.now() - startedAt >= 1_900, 'auth manager became idle before escalation');
    await exited;
    await assertProcessGone(descendantPid);
  } finally {
    manager.cancelAll();
    await manager.waitForIdle(5_000);
    if (descendantPid) {
      try {
        process.kill(-descendantPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
});

test('uploaded filenames cannot escape the upload directory', () => {
  assert.equal(filePrivate.safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(filePrivate.safeFilename('..'), 'upload.bin');
  assert.equal(filePrivate.safeFilename('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.equal(filePrivate.safeFilename('NUL.txt'), '_NUL.txt');
  assert.equal(filePrivate.safeFilename('com1'), '_com1');
  assert.equal(filePrivate.safeFilename('report...   '), 'report');
  assert.throws(() => filePrivate.safeScopeId('../../outside'), /Invalid upload scope/);
});

test('each Telegram upload is isolated in its own job directory', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response('hello');
  const ctx = {
    chat: { id: 123 },
    telegram: { getFileLink: async () => new URL('https://example.test/file') },
  };

  const first = await downloadTelegramFile(
    ctx,
    { fileId: 'one', fileName: '../../notes.txt', fileSize: 5 },
    { uploadsDir, maxBytes: 100, scopeId: '123-thread-9' },
  );
  const second = await downloadTelegramFile(
    ctx,
    { fileId: 'two', fileName: 'notes.txt', fileSize: 5 },
    { uploadsDir, maxBytes: 100, scopeId: '123-thread-9' },
  );

  assert.notEqual(path.dirname(first), path.dirname(second));
  assert.equal(path.basename(first), 'notes.txt');
  assert.equal(path.basename(path.dirname(path.dirname(first))), '123-thread-9');
  assert.equal(await readFile(first, 'utf8'), 'hello');
  assert.equal(await readFile(second, 'utf8'), 'hello');
  assert.deepEqual((await readdir(path.dirname(first))).sort(), ['.active.part', 'notes.txt']);
  await releaseUploadLease(first);
  assert.deepEqual(await readdir(path.dirname(first)), ['notes.txt']);
});

test('getFileLink is covered by the download timeout and failed jobs leave no .part files', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  const ctx = {
    chat: { id: 123 },
    telegram: { getFileLink: () => new Promise(() => {}) },
  };

  await assert.rejects(
    downloadTelegramFile(
      ctx,
      { fileId: 'slow', fileName: 'slow.bin' },
      { uploadsDir, maxBytes: 100, scopeId: '123', timeoutMs: 20 },
    ),
    (error) => error?.name === 'TimeoutError',
  );
  assert.deepEqual(await readdir(path.join(uploadsDir, '123')), []);
});

test('Telegram getFile receives the job cancellation signal at the HTTP transport', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  const controller = new AbortController();
  let transportSignal;
  const ctx = {
    chat: { id: 123 },
    telegram: {
      callApi: async (_method, _payload, { signal }) => {
        transportSignal = signal;
        return new Promise(() => {});
      },
      getFileLink: async () => assert.fail('metadata resolution must not run after cancellation'),
    },
  };
  const pending = downloadTelegramFile(
    ctx,
    { fileId: 'cancel-get-file', fileName: 'cancel.bin' },
    {
      uploadsDir,
      maxBytes: 100,
      scopeId: '123',
      signal: controller.signal,
      timeoutMs: 1_000,
    },
  );
  const deadline = Date.now() + 1_000;
  while (!transportSignal && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(transportSignal, 'getFile transport did not start');
  controller.abort(new Error('cancel download'));

  await assert.rejects(pending, /cancel download/);
  assert.equal(transportSignal.aborted, true);
});

test('external cancellation and timeout are combined without AbortSignal.any', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  const originalFetch = globalThis.fetch;
  const originalAny = AbortSignal.any;
  t.after(() => {
    globalThis.fetch = originalFetch;
    AbortSignal.any = originalAny;
  });
  AbortSignal.any = undefined;
  globalThis.fetch = () => new Promise(() => {});
  const controller = new AbortController();
  const ctx = {
    chat: { id: 123 },
    telegram: { getFileLink: async () => new URL('https://example.test/file') },
  };
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    downloadTelegramFile(
      ctx,
      { fileId: 'cancel', fileName: 'cancel.bin' },
      {
        uploadsDir,
        maxBytes: 100,
        scopeId: '123',
        signal: controller.signal,
        timeoutMs: 1_000,
      },
    ),
    (error) => error?.name === 'AbortError',
  );
  assert.deepEqual(await readdir(path.join(uploadsDir, '123')), []);
});

test('stream limit failures remove the complete temporary job directory', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(101));
        controller.close();
      },
    }),
  });
  const ctx = {
    chat: { id: 123 },
    telegram: { getFileLink: async () => new URL('https://example.test/file') },
  };

  await assert.rejects(
    downloadTelegramFile(
      ctx,
      { fileId: 'large', fileName: 'large.bin' },
      { uploadsDir, maxBytes: 100, scopeId: '123' },
    ),
    /upload limit/,
  );
  assert.deepEqual(await readdir(path.join(uploadsDir, '123')), []);
});

test('concurrent downloads reserve quota atomically before either can oversubscribe storage', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let bodyController;
  let announceFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    announceFetchStarted = resolve;
  });
  let linkCalls = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      bodyController = controller;
      announceFetchStarted();
    },
  }));
  const ctx = {
    chat: { id: 123 },
    telegram: {
      getFileLink: async () => {
        linkCalls += 1;
        return new URL('https://example.test/file');
      },
    },
  };

  const first = downloadTelegramFile(
    ctx,
    { fileId: 'first', fileName: 'first.bin', fileSize: 60 },
    { uploadsDir, maxBytes: 100, maxTotalBytes: 100, scopeId: '123' },
  );
  await fetchStarted;

  await assert.rejects(
    downloadTelegramFile(
      ctx,
      { fileId: 'second', fileName: 'second.bin', fileSize: 60 },
      { uploadsDir, maxBytes: 100, maxTotalBytes: 100, scopeId: '123' },
    ),
    (error) => error?.code === 'UPLOAD_STORAGE_QUOTA',
  );
  assert.equal(linkCalls, 1);

  bodyController.enqueue(new Uint8Array(60));
  bodyController.close();
  const savedPath = await first;
  assert.equal((await readFile(savedPath)).length, 60);
});

test('an unknown upload size reserves the full per-file limit', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  await writeJob(uploadsDir, '123', 'active', Buffer.alloc(1), 100, 'upload.bin.part');
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let linkCalls = 0;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(Buffer.alloc(1));
  };
  const ctx = {
    chat: { id: 123 },
    telegram: {
      getFileLink: async () => {
        linkCalls += 1;
        return new URL('https://example.test/file');
      },
    },
  };

  await assert.rejects(
    downloadTelegramFile(
      ctx,
      { fileId: 'unknown', fileName: 'unknown.bin' },
      {
        uploadsDir,
        maxBytes: 100,
        maxTotalBytes: 100,
        activeLeaseMaxAgeMs: 1_000,
        scopeId: '123',
      },
    ),
    (error) => error?.code === 'UPLOAD_STORAGE_QUOTA',
  );
  assert.equal(linkCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('quota rejection happens before Telegram link lookup or network download', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  await writeJob(uploadsDir, '123', 'active', Buffer.alloc(80), 100, 'upload.bin.part');
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let linkCalls = 0;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(Buffer.alloc(1));
  };
  const ctx = {
    chat: { id: 123 },
    telegram: {
      getFileLink: async () => {
        linkCalls += 1;
        return new URL('https://example.test/file');
      },
    },
  };

  await assert.rejects(
    downloadTelegramFile(
      ctx,
      { fileId: 'blocked', fileName: 'blocked.bin', fileSize: 30 },
      {
        uploadsDir,
        maxBytes: 100,
        maxTotalBytes: 100,
        activeLeaseMaxAgeMs: 1_000,
        scopeId: '123',
      },
    ),
    (error) => error?.code === 'UPLOAD_STORAGE_QUOTA',
  );
  assert.equal(linkCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('upload janitor expires old jobs then evicts oldest jobs to satisfy quota', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  await writeJob(uploadsDir, '123', 'expired', Buffer.alloc(6), 30_000);
  await writeJob(uploadsDir, '123', 'quota-oldest', Buffer.alloc(6), 5_000);
  await writeJob(uploadsDir, '123', 'newest', Buffer.alloc(6), 1_000);

  const result = await cleanupExpiredUploads(uploadsDir, {
    retentionMs: 10_000,
    maxTotalBytes: 7,
  });

  assert.deepEqual(result, { removedEntries: 2, reclaimedBytes: 12, remainingBytes: 6 });
  assert.deepEqual(await readdir(path.join(uploadsDir, '123')), ['newest']);
});

test('quota cleanup skips active .part jobs but retention eventually removes them', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  await writeJob(uploadsDir, '123', 'active', Buffer.alloc(10), 1_000, 'upload.bin.part');
  await writeJob(uploadsDir, '123', 'complete', Buffer.alloc(5), 2_000);

  const quotaResult = await cleanupExpiredUploads(uploadsDir, { maxTotalBytes: 4 });
  assert.deepEqual(quotaResult, { removedEntries: 1, reclaimedBytes: 5, remainingBytes: 10 });
  assert.deepEqual(await readdir(path.join(uploadsDir, '123')), ['active']);

  const expiryResult = await cleanupExpiredUploads(uploadsDir, {
    retentionMs: 0,
    activeLeaseMaxAgeMs: 0,
  });
  assert.deepEqual(expiryResult, { removedEntries: 1, reclaimedBytes: 10, remainingBytes: 0 });
  await assert.rejects(readdir(path.join(uploadsDir, '123')), { code: 'ENOENT' });
});

test('quota cleanup evicts a crash-left stale upload lease', async (t) => {
  const uploadsDir = await temporaryDirectory(t);
  await writeJob(uploadsDir, '123', 'stale-part', Buffer.alloc(10), 60_000, 'upload.bin.part');
  await writeJob(uploadsDir, '123', 'fresh', Buffer.alloc(3), 1_000);

  const result = await cleanupExpiredUploads(uploadsDir, {
    maxTotalBytes: 4,
    activeLeaseMaxAgeMs: 5_000,
  });

  assert.deepEqual(result, { removedEntries: 1, reclaimedBytes: 10, remainingBytes: 3 });
  assert.deepEqual(await readdir(path.join(uploadsDir, '123')), ['fresh']);
});
