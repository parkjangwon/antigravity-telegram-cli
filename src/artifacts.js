import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { isResultTemporaryFileName } from './results.js';

async function regularFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    const info = await lstat(file).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink()) files.push({ file, name: entry.name, mtimeMs: info.mtimeMs });
  }
  return files;
}

export async function cleanupAtomicArtifacts({
  stateFile,
  jobFile,
  usageFile,
  resultsDir,
  retentionMs = 24 * 60 * 60 * 1_000,
  maxCorruptBackups = 3,
  now = Date.now(),
}) {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new RangeError('retentionMs must be positive');
  if (!Number.isSafeInteger(maxCorruptBackups) || maxCorruptBackups < 0) {
    throw new RangeError('maxCorruptBackups must be non-negative');
  }
  const stores = [stateFile, jobFile, usageFile].filter(Boolean).map((file) => ({
    directory: path.dirname(file),
    base: path.basename(file),
  }));
  let removed = 0;
  const corrupt = [];
  for (const store of stores) {
    for (const entry of await regularFiles(store.directory)) {
      const atomicTemp = entry.name.startsWith(`${store.base}.`) && entry.name.endsWith('.tmp');
      const corruptBackup = store.base === path.basename(stateFile)
        && entry.name.startsWith(`${store.base}.corrupt-`);
      if (atomicTemp && now - entry.mtimeMs >= retentionMs) {
        await rm(entry.file, { force: true });
        removed += 1;
      } else if (corruptBackup) {
        corrupt.push(entry);
      }
    }
  }
  corrupt.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (let index = 0; index < corrupt.length; index += 1) {
    if (index >= maxCorruptBackups || now - corrupt[index].mtimeMs >= retentionMs) {
      await rm(corrupt[index].file, { force: true });
      removed += 1;
    }
  }
  for (const entry of await regularFiles(resultsDir)) {
    if (isResultTemporaryFileName(entry.name) && now - entry.mtimeMs >= retentionMs) {
      await rm(entry.file, { force: true });
      removed += 1;
    }
  }
  return { removed };
}
