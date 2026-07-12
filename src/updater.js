import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AGYGRAM_VERSION } from './version.js';

const execFileAsync = promisify(execFile);
const REPOSITORY = 'parkjangwon/antigravity-telegram-cli';
const REMOTE = `https://github.com/${REPOSITORY}.git`;

function run(file, args, cwd) {
  return execFileAsync(file, args, { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 256 * 1024 });
}

async function latestRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agygram-update-check' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub release lookup failed (HTTP ${response.status})`);
    const release = await response.json();
    if (!release?.immutable || release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name || '')) {
      throw new Error('Latest GitHub release is not an immutable stable release');
    }
    return { version: release.tag_name.slice(1), tag: release.tag_name, target: release.target_commitish };
  } finally { clearTimeout(timer); }
}

export async function checkSourceUpdate(projectDir) {
  const [release, remote, status] = await Promise.all([
    latestRelease(), run('git', ['remote', 'get-url', 'origin'], projectDir), run('git', ['status', '--porcelain=v1'], projectDir),
  ]);
  if (remote.stdout.trim() !== REMOTE) throw new Error('Updates require the official GitHub origin remote');
  return { ...release, current: AGYGRAM_VERSION, dirty: Boolean(status.stdout.trim()) };
}

export async function applySourceUpdate(projectDir) {
  const update = await checkSourceUpdate(projectDir);
  if (update.dirty) throw new Error('Refusing update: source checkout has uncommitted changes');
  if (update.version === update.current) return { ...update, changed: false };
  await run('git', ['fetch', '--force', 'origin', `refs/tags/${update.tag}:refs/tags/${update.tag}`], projectDir);
  const commit = (await run('git', ['rev-list', '-n', '1', update.tag], projectDir)).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit) || ( /^[0-9a-f]{40}$/i.test(update.target || '') && commit !== update.target)) {
    throw new Error('Release tag does not match GitHub release target commit');
  }
  await run('git', ['checkout', '--detach', update.tag], projectDir);
  await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], projectDir);
  return { ...update, changed: true };
}
