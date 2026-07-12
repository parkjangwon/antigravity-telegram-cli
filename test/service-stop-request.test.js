import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildServiceRuntimePaths,
  parseFileRunnerArguments,
  resolveServiceDataDir,
} from '../src/service/runtime-paths.js';
import {
  buildServiceStopRequestPath,
  clearStaleServiceStopRequest,
  ServiceStopRequestMonitor,
} from '../src/service/stop-request.js';

function requestDocument(nowMs, lifetimeMs = 120_000) {
  return `${JSON.stringify({
    version: 1,
    requestedAtUtc: new Date(nowMs).toISOString(),
    expiresAtUtc: new Date(nowMs + lifetimeMs).toISOString(),
    requestId: 'structural-test',
  })}\n`;
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition did not become true before timeout');
}

test('service runtime paths honor custom data directories on POSIX and Windows', () => {
  assert.equal(
    resolveServiceDataDir({
      projectDir: '/srv/agygram',
      configuredDataDir: '../private-data',
      platform: 'linux',
    }),
    '/srv/private-data',
  );
  assert.equal(
    resolveServiceDataDir({
      projectDir: 'C:\\Bot',
      env: { LOCALAPPDATA: 'D:\\Profiles\\Me\\Local' },
      platform: 'win32',
    }),
    'D:\\Profiles\\Me\\Local\\agygram\\data',
  );

  const runtime = buildServiceRuntimePaths('D:\\Private Bot Data', 'win32');
  assert.equal(
    runtime.stopRequestPath,
    'D:\\Private Bot Data\\runtime\\service\\stop.request.json',
  );
  assert.equal(runtime.logPath, 'D:\\Private Bot Data\\logs\\service.log');
  assert.deepEqual(parseFileRunnerArguments([
    '--data-dir',
    'D:\\Private Bot Data',
  ], 'win32'), { dataDir: 'D:\\Private Bot Data' });
  assert.throws(() => parseFileRunnerArguments(['--unknown']), /accepts only --data-dir/);
  assert.throws(
    () => parseFileRunnerArguments(['--data-dir', 'relative-data']),
    /must be absolute/,
  );
});

test('an expired or malformed launch sentinel is removed without requesting shutdown', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-stop-stale-'));
  const requestPath = buildServiceStopRequestPath(directory);
  const nowMs = Date.now();
  try {
    await mkdir(path.dirname(requestPath), { recursive: true });
    await writeFile(requestPath, requestDocument(nowMs - 180_000, 60_000));
    assert.equal(await clearStaleServiceStopRequest(requestPath, nowMs), true);
    await assert.rejects(readFile(requestPath), { code: 'ENOENT' });

    await writeFile(requestPath, '{not json');
    assert.equal(await clearStaleServiceStopRequest(requestPath, nowMs), true);
    await assert.rejects(readFile(requestPath), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a valid stop request is latched before lifecycle handler installation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-stop-latch-'));
  const requestPath = buildServiceStopRequestPath(directory);
  const nowMs = Date.now();
  let receivedReason;
  try {
    await mkdir(path.dirname(requestPath), { recursive: true });
    await writeFile(requestPath, requestDocument(nowMs));
    assert.equal(await clearStaleServiceStopRequest(requestPath, nowMs), false);

    const monitor = new ServiceStopRequestMonitor({ requestPath, intervalMs: 25 });
    await monitor.start();
    assert.equal(monitor.requested, true);
    await assert.rejects(readFile(requestPath), { code: 'ENOENT' });

    monitor.setHandler(async (reason) => {
      receivedReason = reason;
    });
    await eventually(() => receivedReason != null);
    assert.equal(receivedReason, 'service-stop-request');
    monitor.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a stop request arriving after launch is consumed once', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-stop-watch-'));
  const requestPath = buildServiceStopRequestPath(directory);
  let calls = 0;
  try {
    await mkdir(path.dirname(requestPath), { recursive: true });
    const monitor = new ServiceStopRequestMonitor({ requestPath, intervalMs: 25 });
    monitor.setHandler(() => {
      calls += 1;
    });
    await monitor.start();
    await writeFile(requestPath, requestDocument(Date.now()));
    await eventually(() => calls === 1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(calls, 1);
    monitor.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
