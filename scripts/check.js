import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots = ['src', 'bin', 'scripts', 'test', 'tests'];
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    else if (entry.isFile() && entry.name.endsWith('.js') && target !== 'scripts/check.js') files.push(target);
  }
}

for (const root of roots) await collect(root);
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.stdout.write(`Syntax OK: ${files.length} JavaScript files\n`);
