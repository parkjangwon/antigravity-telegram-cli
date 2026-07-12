import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ResultStore } from '../src/results.js';

test('ResultStore persists private bounded output and reads it by job ID', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ResultStore(root, { maxResultBytes: 100, maxTotalBytes: 200, retentionMs: 10_000 }).init();
  const id = '11111111-1111-1111-1111-111111111111';
  await store.save(id, '한😀 result');
  assert.equal(await store.read(id), '한😀 result');
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.part')), []);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(root, `${id}.txt`))).mode & 0o777, 0o600);
  await assert.rejects(store.save('22222222-2222-2222-2222-222222222222', 'x'.repeat(101)), /per-result limit/);
});

test('ResultStore expires old files and evicts oldest output to its total quota', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ResultStore(root, { maxResultBytes: 100, maxTotalBytes: 100, retentionMs: 1_000 }).init();
  const first = '11111111-1111-1111-1111-111111111111';
  const second = '22222222-2222-2222-2222-222222222222';
  await store.save(first, 'a'.repeat(70));
  const old = new Date(Date.now() - 2_000);
  await utimes(path.join(root, `${first}.txt`), old, old);
  await store.save(second, 'b'.repeat(70));
  await assert.rejects(store.read(first), /ENOENT/);
  assert.equal((await store.read(second)).length, 70);
});

test('ResultStore descriptor leases are reference counted across retention cleanup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ResultStore(root, {
    maxResultBytes: 100,
    maxTotalBytes: 100,
    retentionMs: 1_000,
  }).init();
  const id = '33333333-3333-3333-3333-333333333333';
  await store.save(id, 'leased result');
  const old = new Date(Date.now() - 2_000);
  await utimes(path.join(root, `${id}.txt`), old, old);

  const firstLease = await store.acquire(id);
  const secondLease = await store.acquire(id);
  assert.equal((await store.cleanup()).removedFiles, 0);
  await assert.rejects(store.remove(id), (error) => error.code === 'RESULT_IN_USE');

  await firstLease.release();
  await firstLease.release();
  assert.equal((await store.cleanup()).removedFiles, 0);

  await secondLease.release();
  assert.equal((await store.cleanup()).removedFiles, 1);
  await assert.rejects(store.read(id), /ENOENT/);
});

test('ResultStore rolls back a new save instead of evicting an actively delivered result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mib = 1024 * 1024;
  const store = await new ResultStore(root, {
    maxResultBytes: mib,
    maxTotalBytes: mib,
    retentionMs: 10_000,
  }).init();
  const first = '44444444-4444-4444-4444-444444444444';
  const second = '55555555-5555-5555-5555-555555555555';
  const firstText = 'a'.repeat(700 * 1024);
  const secondText = 'b'.repeat(700 * 1024);
  const deliveryLease = await store.saveAndAcquire(first, firstText);

  await assert.rejects(
    store.save(second, secondText),
    (error) => error.code === 'RESULT_QUOTA_EXCEEDED',
  );
  assert.equal(await store.read(first), firstText);
  await assert.rejects(store.read(second), /ENOENT/);

  await deliveryLease.release();
  await store.save(second, secondText);
  await assert.rejects(store.read(first), /ENOENT/);
  assert.equal(await store.read(second), secondText);
});

test('ResultStore read holds an internal lease against a concurrent quota save', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mib = 1024 * 1024;
  const store = await new ResultStore(root, {
    maxResultBytes: mib,
    maxTotalBytes: mib,
    retentionMs: 10_000,
  }).init();
  const first = '66666666-6666-6666-6666-666666666666';
  const second = '77777777-7777-7777-7777-777777777777';
  const firstText = 'r'.repeat(700 * 1024);
  await store.save(first, firstText);

  const read = store.read(first);
  const competingSave = store.save(second, 's'.repeat(700 * 1024));
  assert.equal(await read, firstText);
  await assert.rejects(competingSave, (error) => error.code === 'RESULT_QUOTA_EXCEEDED');
  assert.equal(await store.read(first), firstText);
  await assert.rejects(store.read(second), /ENOENT/);
});

test('ResultStore never deletes any active lease when quota is fully pinned', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ResultStore(root, {
    maxResultBytes: 100,
    maxTotalBytes: 100,
    retentionMs: 10_000,
  }).init();
  const first = '88888888-8888-8888-8888-888888888888';
  const second = '99999999-9999-9999-9999-999999999999';
  const rejected = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await store.save(first, 'a'.repeat(60));
  await store.save(second, 'b'.repeat(40));
  const firstLease = await store.acquire(first);
  const secondLease = await store.acquire(second);

  await assert.rejects(store.save(rejected, 'c'), (error) => error.code === 'RESULT_QUOTA_EXCEEDED');
  assert.equal((await store.read(first)).length, 60);
  assert.equal((await store.read(second)).length, 40);
  await assert.rejects(store.read(rejected), /ENOENT/);

  await firstLease.release();
  await secondLease.release();
});

test('ResultStore TTL cleanup removes only exact regular crash-temp files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ResultStore(root, {
    maxResultBytes: 100,
    maxTotalBytes: 200,
    retentionMs: 1_000,
  }).init();
  const exactName =
    'dddddddd-dddd-dddd-dddd-dddddddddddd.txt.123.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.part';
  const wrongUuidVersion =
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.txt.123.aaaaaaaa-bbbb-3ccc-8ddd-eeeeeeeeeeee.part';
  const legacyTemp = 'ffffffff-ffff-ffff-ffff-ffffffffffff.txt.123.part';
  await writeFile(path.join(root, exactName), 'crash temp');
  await writeFile(path.join(root, wrongUuidVersion), 'unrelated');
  await writeFile(path.join(root, legacyTemp), 'legacy crash temp');
  const old = new Date(Date.now() - 2_000);
  await Promise.all([
    utimes(path.join(root, exactName), old, old),
    utimes(path.join(root, wrongUuidVersion), old, old),
    utimes(path.join(root, legacyTemp), old, old),
  ]);
  let symlinkName = null;
  if (process.platform !== 'win32') {
    const target = path.join(root, 'unrelated-target');
    symlinkName = 'abababab-abab-abab-abab-abababababab.txt.123.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.part';
    await writeFile(target, 'target');
    await symlink(target, path.join(root, symlinkName));
  }

  const cleanup = await store.cleanup();
  const remaining = await readdir(root);
  assert.equal(cleanup.removedFiles, 2);
  assert.equal(remaining.includes(exactName), false);
  assert.equal(remaining.includes(wrongUuidVersion), true);
  assert.equal(remaining.includes(legacyTemp), false);
  if (symlinkName) assert.equal(remaining.includes(symlinkName), true);
});

test('ResultStore quota counts and evicts the oldest exact crash-temp file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ResultStore(root, {
    maxResultBytes: 100,
    maxTotalBytes: 100,
    retentionMs: 10_000,
  }).init();
  const resultId = '12121212-1212-1212-1212-121212121212';
  const tempName =
    '34343434-3434-3434-3434-343434343434.txt.456.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.part';
  const unrelatedName = 'unrelated.part';
  await store.save(resultId, 'r'.repeat(60));
  await writeFile(path.join(root, tempName), 't'.repeat(60));
  await writeFile(path.join(root, unrelatedName), 'u'.repeat(1_000));
  const oldButFresh = new Date(Date.now() - 1_000);
  await utimes(path.join(root, tempName), oldButFresh, oldButFresh);

  const cleanup = await store.cleanup();
  assert.deepEqual(cleanup, { removedFiles: 1, removedBytes: 60, remainingBytes: 60 });
  await assert.rejects(stat(path.join(root, tempName)), /ENOENT/);
  assert.equal((await store.read(resultId)).length, 60);
  assert.equal((await stat(path.join(root, unrelatedName))).size, 1_000);
});
