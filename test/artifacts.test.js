import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cleanupAtomicArtifacts } from '../src/artifacts.js';

test('artifact janitor removes only stale recognized temp and bounded corrupt backups', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'sessions.json');
  const jobFile = path.join(root, 'jobs.json');
  const usageFile = path.join(root, 'usage.json');
  const resultsDir = path.join(root, 'results');
  await mkdir(resultsDir);
  const names = [
    'sessions.json.1.abc.tmp',
    'jobs.json.1.abc.tmp',
    'usage.json.1.abc.tmp',
    'sessions.json.corrupt-1',
    'sessions.json.corrupt-2',
    'sessions.json.corrupt-3',
    'unrelated.tmp',
  ];
  for (const name of names) await writeFile(path.join(root, name), 'secret');
  const resultTemp = path.join(
    resultsDir,
    '11111111-1111-1111-1111-111111111111.txt.1.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.part',
  );
  await writeFile(resultTemp, 'result');
  const oldLookalike = path.join(
    resultsDir,
    '33333333-3333-3333-3333-333333333333.txt.1.aaaaaaaa-bbbb-3ccc-8ddd-eeeeeeeeeeee.part',
  );
  await writeFile(oldLookalike, 'unrelated');
  const old = new Date(Date.now() - 10_000);
  for (const name of [...names.slice(0, 3), names[3], resultTemp, oldLookalike]) {
    const file = path.isAbsolute(name) ? name : path.join(root, name);
    await utimes(file, old, old);
  }
  if (process.platform !== 'win32') {
    await symlink(
      path.join(root, 'unrelated.tmp'),
      path.join(
        resultsDir,
        '22222222-2222-2222-2222-222222222222.txt.1.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.part',
      ),
    );
  }

  await cleanupAtomicArtifacts({
    stateFile,
    jobFile,
    usageFile,
    resultsDir,
    retentionMs: 5_000,
    maxCorruptBackups: 1,
  });
  const remaining = await readdir(root);
  assert.equal(remaining.includes('sessions.json.1.abc.tmp'), false);
  assert.equal(remaining.includes('jobs.json.1.abc.tmp'), false);
  assert.equal(remaining.includes('usage.json.1.abc.tmp'), false);
  assert.equal(remaining.includes('unrelated.tmp'), true);
  assert.equal(remaining.filter((name) => name.startsWith('sessions.json.corrupt-')).length, 1);
  assert.equal((await readdir(resultsDir)).includes(path.basename(resultTemp)), false);
  assert.equal((await readdir(resultsDir)).includes(path.basename(oldLookalike)), true);
});
