import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendHistory, StateStore } from '../src/state.js';

test('StateStore migrates the original top-level session shape', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-'));
  const file = path.join(root, 'sessions.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        '858588087': {
          conversationId: 'legacy-conversation',
          model: 'legacy-model',
          mode: 'plan',
          sandbox: true,
          projectId: null,
        },
      }),
    );
    const store = new StateStore(file, { workspaceDir: root });
    await store.init();
    const session = store.get('858588087');
    assert.equal(session.conversationId, 'legacy-conversation');
    assert.equal(session.model, 'legacy-model');
    assert.equal(session.mode, 'plan');
    assert.equal(session.sandbox, true);
    assert.match(session.executionGeneration, /^[0-9a-f-]{36}$/u);
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.sessions['858588087'].executionGeneration, session.executionGeneration);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore serializes concurrent updates and writes valid JSON atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-'));
  const file = path.join(root, 'sessions.json');
  try {
    const store = new StateStore(file, { workspaceDir: root });
    await store.init();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.update('1', (session) => ({
          ...session,
          history: [...session.history, { role: 'user', content: String(index), at: new Date().toISOString() }],
        })),
      ),
    );
    assert.equal(store.get('1').history.length, 25);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.version, 2);
    assert.equal(persisted.sessions['1'].history.length, 25);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore preserves Telegram forum topic sessions across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-topic-'));
  const file = path.join(root, 'sessions.json');
  try {
    const first = new StateStore(file, { workspaceDir: root });
    await first.init();
    await first.update('-100123:77', (session) => ({ ...session, model: 'topic-model' }));

    const restarted = new StateStore(file, { workspaceDir: root });
    await restarted.init();
    assert.equal(restarted.get('-100123:77').model, 'topic-model');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore recovers a corrupt file without silently deleting it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-'));
  const file = path.join(root, 'sessions.json');
  try {
    await writeFile(file, '{broken');
    const store = new StateStore(file, { workspaceDir: root });
    await store.init();
    assert.equal(store.has('1'), false);
    const names = await readdir(root);
    assert.ok(names.some((name) => name.startsWith('sessions.json.corrupt-')));
    const recovered = await readFile(file, 'utf8');
    assert.doesNotThrow(() => JSON.parse(recovered));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore rejects unknown future schema versions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-future-'));
  const file = path.join(root, 'sessions.json');
  try {
    await writeFile(file, JSON.stringify({ version: 999, sessions: { 1: {} } }));
    const store = new StateStore(file, { workspaceDir: root });
    await assert.rejects(store.init(), /Unsupported state schema version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore does not expose an update that failed to persist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-rollback-'));
  const file = path.join(root, 'state', 'sessions.json');
  try {
    const store = new StateStore(file, { workspaceDir: root });
    await store.init();
    await rm(path.dirname(file), { recursive: true, force: true });
    await assert.rejects(
      store.update('1', (session) => ({ ...session, model: 'not-durable' })),
      /ENOENT/,
    );
    assert.equal(store.get('1').model, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore bounds session count and total serialized bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-limits-'));
  const file = path.join(root, 'sessions.json');
  try {
    const store = new StateStore(file, { workspaceDir: root }, {
      maxSessions: 1,
      maxBytes: 1_024,
      retentionMs: 60_000,
    });
    await store.init();
    await store.update('1', (session) => ({ ...session, model: 'safe' }));
    await assert.rejects(
      store.update('2', (session) => session),
      (error) => error.code === 'STATE_SESSION_LIMIT',
    );
    await assert.rejects(
      store.update('1', (session) => ({
        ...session,
        history: [{ role: 'user', content: 'x'.repeat(2_000), at: new Date().toISOString() }],
      })),
      (error) => error.code === 'STATE_SIZE_LIMIT',
    );
    assert.equal(store.get('1').model, 'safe');
    assert.equal(store.get('1').history.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore execution context is stable for touches and bookkeeping but changes for execution settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-generation-'));
  const file = path.join(root, 'sessions.json');
  try {
    const store = new StateStore(file, { workspaceDir: root });
    await store.init();
    const created = await store.ensure('1');

    const touched = await store.ensure('1');
    assert.equal(touched.executionGeneration, created.executionGeneration);
    assert.equal(touched.revision, created.revision);

    const completedRun = await store.update('1', (session) => ({
      ...session,
      lastRun: {
        id: 'job-1',
        kind: 'prompt',
        status: 'succeeded',
        mode: 'plan',
        sandbox: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1,
        responseText: null,
        deliveryStatus: 'pending',
        errorCode: null,
      },
    }));
    assert.equal(completedRun.executionGeneration, created.executionGeneration);
    assert.equal(completedRun.revision, created.revision + 1);

    const bookkeeping = await store.update('1', (session) => ({
      ...session,
      lastRun: { ...session.lastRun, deliveryStatus: 'delivered' },
    }));
    assert.equal(bookkeeping.executionGeneration, created.executionGeneration);
    assert.equal(bookkeeping.revision, completedRun.revision);

    const changed = await store.update('1', (session) => ({ ...session, mode: 'plan' }));
    assert.equal(changed.executionGeneration, created.executionGeneration);
    assert.equal(changed.revision, completedRun.revision + 1);

    const attemptedGenerationOverwrite = await store.update('1', (session) => ({
      ...session,
      executionGeneration: '00000000-0000-4000-8000-000000000000',
    }));
    assert.equal(attemptedGenerationOverwrite.executionGeneration, created.executionGeneration);
    assert.equal(attemptedGenerationOverwrite.revision, changed.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore reset and remove/recreate cannot repeat an execution context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-aba-'));
  const file = path.join(root, 'sessions.json');
  try {
    const store = new StateStore(file, { workspaceDir: root });
    await store.init();
    const original = await store.ensure('1');

    const reset = await store.reset('1');
    assert.notEqual(reset.executionGeneration, original.executionGeneration);
    assert.equal(reset.revision, 0);

    await store.remove('1');
    const recreated = await store.ensure('1');
    assert.notEqual(recreated.executionGeneration, reset.executionGeneration);
    assert.equal(recreated.revision, 0);

    const restarted = new StateStore(file, { workspaceDir: root });
    await restarted.init();
    assert.equal(restarted.get('1').executionGeneration, recreated.executionGeneration);
    assert.equal(restarted.get('1').revision, recreated.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore initialization uses exact pretty-printed byte limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-load-bytes-'));
  const file = path.join(root, 'sessions.json');
  try {
    const writer = new StateStore(file, { workspaceDir: root }, { maxBytes: 64 * 1024 });
    await writer.init();
    await writer.update('1', (session) => ({
      ...session,
      history: [{ role: 'user', content: 'x'.repeat(256), at: new Date().toISOString() }],
    }));
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const compactBytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    const persistedBytes = Buffer.byteLength(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    assert.ok(persistedBytes > compactBytes);
    const exactLimit = Math.floor((compactBytes + persistedBytes) / 2);

    const constrained = new StateStore(file, { workspaceDir: root }, { maxBytes: exactLimit });
    await constrained.init();
    assert.equal(constrained.has('1'), false);
    assert.ok(Buffer.byteLength(await readFile(file), 'utf8') <= exactLimit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('StateStore drops TTL-expired sessions before applying startup byte limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-state-load-ttl-'));
  const file = path.join(root, 'sessions.json');
  try {
    const now = Date.now();
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: {
        1: {
          workspaceDir: root,
          updatedAt: new Date(now - 120_000).toISOString(),
          history: [{ role: 'user', content: 'expired'.repeat(2_000) }],
        },
        2: {
          workspaceDir: root,
          updatedAt: new Date(now).toISOString(),
          model: 'live',
        },
      },
    }));
    const store = new StateStore(file, { workspaceDir: root }, {
      maxBytes: 1_024,
      retentionMs: 60_000,
    });
    await store.init();
    assert.equal(store.has('1'), false);
    assert.equal(store.get('2').model, 'live');
    assert.ok(Buffer.byteLength(await readFile(file), 'utf8') <= 1_024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('appendHistory enforces turn and character budgets from the newest turns', () => {
  const history = appendHistory(
    [],
    Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `${index}`.repeat(10),
      at: new Date().toISOString(),
    })),
    { maxTurns: 4, maxChars: 35 },
  );
  assert.ok(history.length <= 4);
  assert.ok(history.reduce((total, turn) => total + turn.content.length, 0) <= 35);
  assert.match(history.at(-1).content, /9/);
});
