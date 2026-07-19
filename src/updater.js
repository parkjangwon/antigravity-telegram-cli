import { execFile, spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { AGYGRAM_VERSION } from './version.js';

const execFileAsync = promisify(execFile);
const REPOSITORY = 'parkjangwon/agygram';
const REMOTE = `https://github.com/${REPOSITORY}.git`;
const MANAGED_OWNER = 'agygram-managed-installer';
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/iu;
const UPDATE_CHECK_UNAVAILABLE_CODE = 'UPDATE_CHECK_UNAVAILABLE';

function run(file, args, cwd) {
  return execFileAsync(file, args, { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 256 * 1024 });
}

function normalizeRemote(value) {
  const trimmed = String(value || '').trim();
  if (trimmed === REMOTE || trimmed === `https://github.com/${REPOSITORY}`) return REMOTE;
  if (trimmed === `git@github.com:${REPOSITORY}.git`) return REMOTE;
  if (trimmed === `ssh://git@github.com/${REPOSITORY}.git`) return REMOTE;
  return trimmed;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function assertManagedIdentity(record, label) {
  if (
    record?.schemaVersion !== 1 ||
    record.owner !== MANAGED_OWNER ||
    record.repository !== REPOSITORY ||
    !SEMVER_RE.test(record.version || '') ||
    !COMMIT_RE.test(record.commit || '')
  ) {
    throw new Error(`Invalid agygram managed ${label}`);
  }
}

async function detectManagedInstallation(projectDir) {
  const releaseDir = path.resolve(projectDir);
  const markerPath = path.join(releaseDir, '.agygram-release.json');
  let marker;
  try {
    marker = await readJson(markerPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  assertManagedIdentity(marker, 'release marker');
  const releaseInfo = await lstat(releaseDir);
  if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink()) {
    throw new Error('Invalid agygram managed release directory');
  }
  const installRoot = path.resolve(releaseDir, '..', '..');
  const releaseName = path.basename(releaseDir);
  const releasesDir = path.basename(path.dirname(releaseDir));
  if (releasesDir !== 'releases' || marker.releaseName !== releaseName) {
    throw new Error('Invalid agygram managed release location');
  }
  const [manifest, current] = await Promise.all([
    readJson(path.join(installRoot, 'manifest.json')),
    readFile(path.join(installRoot, 'current'), 'utf8').then((value) => value.trim()),
  ]);
  assertManagedIdentity(manifest, 'manifest');
  if (
    current !== releaseName ||
    manifest.currentRelease !== releaseName ||
    manifest.version !== marker.version ||
    manifest.commit !== marker.commit ||
    (manifest.tag != null && manifest.tag !== `v${manifest.version}`) ||
    !path.isAbsolute(manifest.configFile || '') ||
    !path.isAbsolute(manifest.dataDir || '')
  ) {
    throw new Error('agygram managed manifest is inconsistent');
  }
  return {
    type: 'managed',
    installRoot,
    releaseDir,
    releaseName,
    version: manifest.version,
    commit: manifest.commit,
    tag: manifest.tag || `v${manifest.version}`,
    configFile: manifest.configFile,
    dataDir: manifest.dataDir,
    serviceInstalled: manifest.serviceInstalled !== false,
  };
}

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function managedInstallerArgs(installation, { platform = process.platform } = {}) {
  const pathApi = pathApiFor(platform);
  return [
    pathApi.join(installation.releaseDir, 'scripts', 'install.mjs'),
    '--install-root',
    installation.installRoot,
    '--config-file',
    installation.configFile,
    ...(installation.serviceInstalled ? [] : ['--no-service']),
  ];
}

async function scheduleManagedUpdate(
  installation,
  { platform = process.platform, runCommand = run, spawnProcess = spawn } = {},
) {
  const installerArgs = managedInstallerArgs(installation, { platform });
  if (platform === 'linux') {
    const unit = `agygram-update-${Date.now()}-${process.pid}`;
    await runCommand('systemd-run', [
      '--user',
      '--collect',
      '--unit',
      unit,
      process.execPath,
      '--',
      ...installerArgs,
    ], installation.releaseDir);
    return { method: 'systemd-run', unit };
  }
  const child = spawnProcess(process.execPath, ['--', ...installerArgs], {
    cwd: installation.releaseDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();
  return { method: 'detached-process' };
}

async function latestRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agygram-update-check' },
        signal: controller.signal,
      });
    } catch (error) {
      const unavailable = new Error('Latest release lookup is temporarily unavailable');
      unavailable.code = UPDATE_CHECK_UNAVAILABLE_CODE;
      unavailable.cause = error;
      throw unavailable;
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        const unavailable = new Error('Latest release lookup is temporarily unavailable');
        unavailable.code = UPDATE_CHECK_UNAVAILABLE_CODE;
        throw unavailable;
      }
      throw new Error(`GitHub release lookup failed (HTTP ${response.status})`);
    }
    const release = await response.json();
    if (!release?.immutable || release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name || '')) {
      throw new Error('Latest GitHub release is not an immutable stable release');
    }
    return {
      version: release.tag_name.slice(1),
      tag: release.tag_name,
      target: release.target_commitish,
      name: release.name || release.tag_name,
      url: release.html_url || `https://github.com/${REPOSITORY}/releases/tag/${release.tag_name}`,
      body: typeof release.body === 'string' ? release.body : '',
    };
  } finally { clearTimeout(timer); }
}

export async function checkSourceUpdate(projectDir) {
  const [release, managed] = await Promise.all([
    latestRelease(),
    detectManagedInstallation(projectDir),
  ]);
  if (managed) {
    return {
      ...release,
      current: managed.version,
      dirty: false,
      managed: true,
      installRoot: managed.installRoot,
      serviceInstalled: managed.serviceInstalled,
    };
  }
  const [remote, status] = await Promise.all([
    run('git', ['remote', 'get-url', 'origin'], projectDir),
    run('git', ['status', '--porcelain=v1'], projectDir),
  ]);
  if (normalizeRemote(remote.stdout) !== REMOTE) throw new Error('Updates require the official GitHub origin remote or a managed agygram release');
  return { ...release, current: AGYGRAM_VERSION, dirty: Boolean(status.stdout.trim()) };
}

export async function applySourceUpdate(projectDir) {
  const managed = await detectManagedInstallation(projectDir);
  const update = await checkSourceUpdate(projectDir);
  if (update.dirty) throw new Error('Refusing update: source checkout has uncommitted changes');
  if (update.version === update.current) return { ...update, changed: false };
  if (managed) {
    const scheduled = await scheduleManagedUpdate(managed);
    return {
      ...update,
      changed: true,
      managed: true,
      scheduled,
      restart: false,
    };
  }
  await run('git', ['fetch', '--force', 'origin', `refs/tags/${update.tag}:refs/tags/${update.tag}`], projectDir);
  const commit = (await run('git', ['rev-list', '-n', '1', update.tag], projectDir)).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit) || ( /^[0-9a-f]{40}$/i.test(update.target || '') && commit !== update.target)) {
    throw new Error('Release tag does not match GitHub release target commit');
  }
  await run('git', ['checkout', '--detach', update.tag], projectDir);
  await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], projectDir);
  return { ...update, changed: true, restart: true };
}

export const _private = {
  detectManagedInstallation,
  latestRelease,
  managedInstallerArgs,
  normalizeRemote,
  scheduleManagedUpdate,
};
