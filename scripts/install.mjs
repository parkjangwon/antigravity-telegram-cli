#!/usr/bin/env node

/**
 * Standalone managed installer for agygram.
 *
 * This file intentionally imports only Node.js built-ins: the release bootstrap
 * downloads it before any npm dependencies exist.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
} from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OWNER = 'agygram-managed-installer';
const REPOSITORY = 'parkjangwon/antigravity-telegram-cli';
const PACKAGE_NAME = 'antigravity-telegram-cli';
const SCHEMA_VERSION = 1;
const ROOT_MARKER = '.agygram-managed-root.json';
const RELEASE_MARKER = '.agygram-release.json';
const RELEASE_INVENTORY = '.agygram-release-inventory.json';
const MANIFEST_FILE = 'manifest.json';
const CURRENT_FILE = 'current';
const LOCK_FILE = '.install.lock';
const TRANSACTION_FILE = 'transaction.json';
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_TREE_DEPTH = 32;
const MAX_RELATIVE_PATH_BYTES = 512;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 12 * 60_000;
const SEMVER_SOURCE = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)' +
  '(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)' +
  '(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?' +
  '(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?';
const SEMVER_RE = new RegExp(`^${SEMVER_SOURCE}$`, 'u');
const TAG_RE = new RegExp(`^v(${SEMVER_SOURCE})$`, 'u');
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;

const USAGE = `agygram managed installer

Usage:
  node install.mjs --version <semver> --commit <40-hex> [options]

Options:
  --version <semver>        Expected package version
  --tag <v-semver>          Expected release tag (must agree with --version)
  --commit <40-hex>         Exact source commit
  --archive <absolute path> Install a local release .tgz/.tar.gz
  --archive-sha256 <64hex>  Required SHA-256 for --archive
  --install-root <path>     Managed code root
  --config-file <path>      External configuration file
  --agy-bin <path>          Absolute agy executable
  --no-service              Install/update code but leave native service removed
  --allow-downgrade         Explicitly permit a lower target version
  -h, --help                Show this help
`;

function fail(message) {
  throw new Error(message);
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22 && major !== 24) {
    fail(`Node.js 22 or 24 is required; found ${process.versions.node}`);
  }
}

function assertNoControls(value, name) {
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(`${name} contains control characters`);
}

function parseOptions(argv) {
  const options = {
    noService: false,
    allowDowngrade: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '-h' || item === '--help') {
      options.help = true;
      continue;
    }
    if (seen.has(item)) fail(`Duplicate option: ${item}`);
    seen.add(item);
    if (item === '--no-service') options.noService = true;
    else if (item === '--allow-downgrade') options.allowDowngrade = true;
    else if ([
      '--version',
      '--tag',
      '--commit',
      '--archive',
      '--archive-sha256',
      '--install-root',
      '--config-file',
      '--agy-bin',
    ].includes(item)) {
      const value = argv[index + 1];
      if (value == null || value.startsWith('--')) fail(`Missing value after ${item}`);
      assertNoControls(value, item);
      index += 1;
      const property = {
        '--version': 'version',
        '--tag': 'tag',
        '--commit': 'commit',
        '--archive': 'archive',
        '--archive-sha256': 'archiveSha256',
        '--install-root': 'installRoot',
        '--config-file': 'envFile',
        '--agy-bin': 'agyBin',
      }[item];
      options[property] = value;
    } else {
      fail(`Unknown option: ${item}`);
    }
  }

  if (options.version && !SEMVER_RE.test(options.version)) {
    fail(`--version must be strict SemVer: ${options.version}`);
  }
  if (options.tag) {
    const match = TAG_RE.exec(options.tag);
    if (!match) fail(`--tag must be v followed by strict SemVer: ${options.tag}`);
    if (options.version && options.tag !== `v${options.version}`) {
      fail(`--tag ${options.tag} does not match --version ${options.version}`);
    }
    options.version ??= match[1];
  }
  if (options.commit) {
    options.commit = options.commit.toLowerCase();
    if (!COMMIT_RE.test(options.commit)) fail('--commit must contain exactly 40 hexadecimal characters');
  }
  if (options.archiveSha256) {
    options.archiveSha256 = options.archiveSha256.toLowerCase();
    if (!SHA256_RE.test(options.archiveSha256)) {
      fail('--archive-sha256 must contain exactly 64 hexadecimal characters');
    }
  }
  if (options.archive && !options.archiveSha256) {
    fail('--archive requires --archive-sha256');
  }
  if (options.archiveSha256 && !options.archive) {
    fail('--archive-sha256 may only be used with --archive');
  }
  if (options.archive && (!options.version || !options.commit)) {
    fail('--archive requires exact --version and --commit values');
  }
  for (const [flag, value] of [
    ['--archive', options.archive],
    ['--install-root', options.installRoot],
    ['--config-file', options.envFile],
    ['--agy-bin', options.agyBin],
  ]) {
    if (value && !path.isAbsolute(value)) fail(`${flag} must be an absolute path`);
  }
  return options;
}

function platformDefaults(env = process.env) {
  const home = os.homedir();
  if (!home || !path.isAbsolute(home)) fail('Cannot determine an absolute user home directory');
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (!local || !path.isAbsolute(local)) {
      fail('Windows requires an absolute LOCALAPPDATA to locate managed files consistently');
    }
    const base = path.resolve(local, 'agygram');
    return {
      base,
      installRoot: path.join(base, 'manager'),
      envFile: path.join(base, 'config', '.env'),
      dataDir: path.join(base, 'data'),
      workspaceDir: path.join(base, 'workspace'),
    };
  }
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support', 'agygram');
    return {
      base,
      installRoot: path.join(base, 'manager'),
      envFile: path.join(base, 'config', '.env'),
      dataDir: path.join(base, 'data'),
      workspaceDir: path.join(base, 'workspace'),
    };
  }
  if (Object.hasOwn(env, 'XDG_DATA_HOME') &&
      (!env.XDG_DATA_HOME || !path.isAbsolute(env.XDG_DATA_HOME))) {
    fail('XDG_DATA_HOME must be a non-empty absolute path when set');
  }
  if (Object.hasOwn(env, 'XDG_CONFIG_HOME') &&
      (!env.XDG_CONFIG_HOME || !path.isAbsolute(env.XDG_CONFIG_HOME))) {
    fail('XDG_CONFIG_HOME must be a non-empty absolute path when set');
  }
  const dataHome = env.XDG_DATA_HOME
    ? path.resolve(env.XDG_DATA_HOME)
    : path.join(home, '.local', 'share');
  const configHome = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(home, '.config');
  const base = path.join(dataHome, 'agygram');
  return {
    base,
    installRoot: path.join(base, 'manager'),
    envFile: path.join(configHome, 'agygram', '.env'),
    dataDir: path.join(base, 'data'),
    workspaceDir: path.join(base, 'workspace'),
  };
}

function isPathRoot(target) {
  return path.parse(target).root === target;
}

function pathsOverlap(left, right) {
  const fold = (value) => ['win32', 'darwin'].includes(process.platform)
    ? path.resolve(value).normalize('NFC').toLocaleLowerCase('en-US')
    : path.resolve(value);
  const relative = path.relative(fold(left), fold(right));
  const reverse = path.relative(fold(right), fold(left));
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ||
    (reverse !== '..' && !reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse));
}

function isStrictDescendant(parent, candidate) {
  const fold = (value) => ['win32', 'darwin'].includes(process.platform)
    ? path.resolve(value).normalize('NFC').toLocaleLowerCase('en-US')
    : path.resolve(value);
  const relative = path.relative(fold(parent), fold(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

async function canonicalPotentialPath(target) {
  const suffix = [];
  let current = path.resolve(target);
  while (true) {
    try {
      const resolved = await realpath(current);
      return path.resolve(resolved, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function assertNoPathOverlaps(entries) {
  const canonical = [];
  for (const [name, target] of entries) {
    canonical.push([name, await canonicalPotentialPath(target)]);
  }
  for (let left = 0; left < canonical.length; left += 1) {
    for (let right = left + 1; right < canonical.length; right += 1) {
      if (pathsOverlap(canonical[left][1], canonical[right][1])) {
        fail(`${canonical[left][0]} must not overlap ${canonical[right][0]}: ${canonical[left][1]} / ${canonical[right][1]}`);
      }
    }
  }
}

function assertAbsoluteSafePath(target, name) {
  if (!path.isAbsolute(target)) fail(`${name} must be an absolute path: ${target}`);
  assertNoControls(target, name);
  if (isPathRoot(path.resolve(target))) fail(`${name} cannot be a filesystem root`);
}

async function rejectSymlinkComponents(target, name) {
  let current = path.resolve(target);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail(`${name} cannot contain a symbolic link: ${current}`);
      if (current === path.resolve(target) && !info.isDirectory()) {
        fail(`${name} is not a directory: ${current}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function ensurePrivateDirectory(target, name, { mutateExisting = true } = {}) {
  assertAbsoluteSafePath(target, name);
  await rejectSymlinkComponents(target, name);
  let existed = true;
  try {
    await lstat(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existed = false;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory`);
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if (Number.isSafeInteger(uid) && info.uid !== uid) {
      fail(`${name} is owned by uid ${info.uid}, expected ${uid}`);
    }
    if (existed && !mutateExisting && (info.mode & 0o022) !== 0) {
      fail(`${name} is writable by other users; secure it before continuing: ${target}`);
    }
    if (!existed || mutateExisting) await chmod(target, 0o700);
  }
  return realpath(target);
}

async function atomicWrite(target, body, { mode = 0o600 } = {}) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    if (process.platform !== 'win32') await chmod(target, mode);
    try {
      const directoryHandle = await open(path.dirname(target), 'r');
      await directoryHandle.sync().catch(() => {});
      await directoryHandle.close();
    } catch {
      // Directory fsync is unavailable on some Windows/filesystem combinations.
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readJsonFile(target, { maxBytes = 128 * 1024, optional = false } = {}) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) fail(`Expected a regular file: ${target}`);
  if (info.size > maxBytes) fail(`File is unexpectedly large: ${target}`);
  let value;
  try {
    value = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    fail(`Cannot parse ${target}: ${error.message}`);
  }
  return value;
}

function rootMarkerBody(installRoot) {
  return `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    repository: REPOSITORY,
    installRoot,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`;
}

function validateRootMarker(marker, installRoot) {
  if (!marker || marker.schemaVersion !== SCHEMA_VERSION || marker.owner !== OWNER ||
      marker.repository !== REPOSITORY || marker.installRoot !== installRoot) {
    fail(`Install root is not owned by this installer: ${installRoot}`);
  }
}

async function claimInstallRoot(installRoot) {
  const resolved = await ensurePrivateDirectory(installRoot, 'install root');
  const markerPath = path.join(resolved, ROOT_MARKER);
  const existing = await readJsonFile(markerPath, { optional: true });
  if (existing) {
    validateRootMarker(existing, resolved);
    return resolved;
  }
  const entries = await readdir(resolved);
  if (entries.length !== 0) {
    fail(`Refusing to claim non-empty unmarked install root: ${resolved}`);
  }
  try {
    await writeFile(markerPath, rootMarkerBody(resolved), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    validateRootMarker(await readJsonFile(markerPath), resolved);
  }
  return resolved;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function acquireLock(installRoot) {
  const lockPath = path.join(installRoot, LOCK_FILE);
  const token = randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const body = `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      owner: OWNER,
      pid: process.pid,
      hostname: os.hostname(),
      token,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`;
    try {
      await writeFile(lockPath, body, { flag: 'wx', mode: 0o600 });
      return async () => {
        const raw = await readFile(lockPath, 'utf8').catch(() => null);
        const lock = raw ? JSON.parse(raw) : null;
        if (lock?.token !== token || lock?.pid !== process.pid) return;
        const quarantine = `${lockPath}.release-${token}`;
        await rename(lockPath, quarantine);
        const moved = await readFile(quarantine, 'utf8');
        if (moved !== raw) fail('Installer lock changed during release');
        await rm(quarantine, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const info = await lstat(lockPath).catch(() => null);
    const raw = await readFile(lockPath, 'utf8').catch(() => null);
    let lock = null;
    try { lock = raw ? JSON.parse(raw) : null; } catch { lock = null; }
    const ageMs = info ? Date.now() - info.mtimeMs : 0;
    const sameHost = lock?.hostname === os.hostname();
    const stalePid = sameHost && !processIsAlive(Number(lock?.pid));
    const staleMalformed = (!lock || lock.owner !== OWNER) && ageMs > 30 * 60_000;
    if (!stalePid && !staleMalformed) {
      const holder = lock?.pid ? `pid ${lock.pid} on ${lock.hostname || 'unknown host'}` : 'unknown process';
      fail(`Another install/update is active (${holder})`);
    }
    // Recheck both inode metadata and exact content, then atomically quarantine
    // the stale object. A newly acquired lock at lockPath is never unlinked.
    const recheckedInfo = await lstat(lockPath).catch(() => null);
    const recheckedRaw = await readFile(lockPath, 'utf8').catch(() => null);
    if (!info || !recheckedInfo || info.dev !== recheckedInfo.dev || info.ino !== recheckedInfo.ino ||
        info.size !== recheckedInfo.size || info.mtimeMs !== recheckedInfo.mtimeMs ||
        raw !== recheckedRaw) {
      fail('Installer lock changed while stale recovery was being evaluated');
    }
    const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    await rename(lockPath, quarantine);
    const movedRaw = await readFile(quarantine, 'utf8');
    if (movedRaw !== raw) fail('Installer lock changed during stale quarantine');
    await rm(quarantine, { force: true });
  }
  fail('Could not acquire the installer lock');
}

function parseSemver(version) {
  const match = SEMVER_RE.exec(version);
  if (!match) fail(`Invalid stored SemVer: ${version}`);
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] == null ? [] : match[4].split('.'),
  };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av == null) return -1;
    if (bv == null) return 1;
    if (av === bv) continue;
    const an = /^\d+$/u.test(av);
    const bn = /^\d+$/u.test(bv);
    if (an && bn) return BigInt(av) < BigInt(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function validateReleaseName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 180 ||
      !/^[A-Za-z0-9._+-]+$/u.test(value) || value === '.' || value === '..') {
    fail(`Invalid managed release name: ${value}`);
  }
  return value;
}

function releaseName(version, commit) {
  return validateReleaseName(`v${version}-${commit}`);
}

function validateManifest(manifest, installRoot, pointer) {
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || manifest.owner !== OWNER ||
      manifest.repository !== REPOSITORY) {
    fail(`Invalid managed manifest in ${installRoot}`);
  }
  if (!SEMVER_RE.test(manifest.version) || !COMMIT_RE.test(manifest.commit) ||
      manifest.currentRelease !== pointer ||
      manifest.currentRelease !== releaseName(manifest.version, manifest.commit) ||
      (manifest.tag != null && manifest.tag !== `v${manifest.version}`)) {
    fail('Managed manifest and current pointer are inconsistent');
  }
  validateReleaseName(manifest.currentRelease);
  if (manifest.previousRelease != null) {
    validateReleaseName(manifest.previousRelease);
    if (manifest.previousRelease === manifest.currentRelease) {
      fail('Managed manifest previousRelease cannot equal currentRelease');
    }
  }
  for (const key of ['configFile', 'dataDir', 'workspaceDir']) {
    if (typeof manifest[key] !== 'string' || !path.isAbsolute(manifest[key])) {
      fail(`Managed manifest has an invalid ${key}`);
    }
  }
  if (typeof manifest.serviceInstalled !== 'boolean') fail('Managed manifest has invalid service state');
  if (manifest.configSha256 != null && !SHA256_RE.test(manifest.configSha256)) {
    fail('Managed manifest has invalid configSha256');
  }
  if (manifest.serviceEnvironment != null) {
    const xdg = manifest.serviceEnvironment.xdgConfigHome;
    if (xdg != null && (typeof xdg !== 'string' || !path.isAbsolute(xdg))) {
      fail('Managed manifest has invalid serviceEnvironment');
    }
  }
  const launcherDirectory = path.join(installRoot, 'bin');
  if (!manifest.launcher || manifest.launcher.directory !== launcherDirectory ||
      !Array.isArray(manifest.launcher.files) || manifest.launcher.files.length !== 2) {
    fail('Managed manifest has invalid launcher ownership');
  }
  const launcherPaths = new Set();
  for (const file of manifest.launcher.files) {
    if (file?.kind !== 'file' || typeof file.path !== 'string' ||
        path.dirname(file.path) !== launcherDirectory || !SHA256_RE.test(file.sha256 || '') ||
        launcherPaths.has(file.path)) {
      fail('Managed manifest has invalid launcher file metadata');
    }
    launcherPaths.add(file.path);
  }
  return manifest;
}

async function loadInstalledState(installRoot) {
  const manifestPath = path.join(installRoot, MANIFEST_FILE);
  const currentPath = path.join(installRoot, CURRENT_FILE);
  const manifest = await readJsonFile(manifestPath, { optional: true });
  let pointer = null;
  try {
    const info = await lstat(currentPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256) fail('Invalid current pointer file');
    pointer = (await readFile(currentPath, 'utf8')).trim();
    validateReleaseName(pointer);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if ((manifest == null) !== (pointer == null)) fail('Managed manifest and current pointer are inconsistent');
  if (!manifest) return null;
  validateManifest(manifest, installRoot, pointer);
  await validateReleaseMarker(path.join(installRoot, 'releases', pointer), {
    releaseName: pointer,
    version: manifest.version,
    commit: manifest.commit,
  });
  if (manifest.previousRelease) {
    await validateReleaseMarker(
      path.join(installRoot, 'releases', manifest.previousRelease),
      { releaseName: manifest.previousRelease },
    );
  }
  return manifest;
}

function requestBuffer(url, { maxBytes = 2 * 1024 * 1024, redirects = 3 } = {}) {
  const allowedHosts = new Set(['api.github.com', 'codeload.github.com']);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
      reject(new Error(`Refusing network host: ${parsed.hostname}`));
      return;
    }
    const request = https.get(parsed, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agygram-managed-installer/1',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects < 1 || !response.headers.location) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        let redirected;
        try {
          redirected = new URL(response.headers.location, parsed).toString();
        } catch (error) {
          reject(error);
          return;
        }
        requestBuffer(redirected, { maxBytes, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub request failed with HTTP ${response.statusCode}`));
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy(new Error(`Download exceeds ${maxBytes} bytes`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(new Error(`Download exceeds ${maxBytes} bytes`));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve(Buffer.concat(chunks, size)));
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error(`Download timed out: ${url}`)));
    request.once('error', reject);
  });
}

async function githubJson(endpoint) {
  const body = await requestBuffer(`https://api.github.com/repos/${REPOSITORY}${endpoint}`);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    fail(`GitHub returned invalid JSON: ${error.message}`);
  }
}

async function resolveTarget(options) {
  let { version, tag, commit } = options;
  if (!version && !tag && !commit) {
    const release = await githubJson('/releases/latest');
    tag = release.tag_name;
    const match = TAG_RE.exec(tag || '');
    if (!match) fail(`Latest GitHub release has an invalid tag: ${tag}`);
    version = match[1];
  }
  tag ??= version ? `v${version}` : null;
  if (!commit) {
    if (!tag) fail('--commit is required when no release version/tag is selected');
    const target = await githubJson(`/commits/${encodeURIComponent(tag)}`);
    commit = String(target.sha || '').toLowerCase();
    if (!COMMIT_RE.test(commit)) fail(`GitHub did not resolve ${tag} to an exact commit`);
  }
  return { version, tag, commit };
}

async function readArchiveFile(archivePath, expectedSha256) {
  assertAbsoluteSafePath(archivePath, '--archive');
  const lexical = await lstat(archivePath);
  if (!lexical.isFile() || lexical.isSymbolicLink()) fail('--archive must be a regular, non-symlink file');
  if (lexical.size > MAX_ARCHIVE_BYTES) fail(`Archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  const handle = await open(archivePath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== lexical.size) fail('Archive changed while being opened');
    const body = await handle.readFile();
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== expectedSha256) {
      fail(`Archive SHA-256 mismatch: expected ${expectedSha256}, received ${digest}`);
    }
    return { body, digest };
  } finally {
    await handle.close();
  }
}

async function obtainArchive(options, target) {
  if (options._obtainedArchive) return options._obtainedArchive;
  if (options.archive) {
    if (!path.isAbsolute(options.archive)) fail('--archive must be an absolute path');
    options._obtainedArchive = await readArchiveFile(options.archive, options.archiveSha256);
    return options._obtainedArchive;
  }
  const url = `https://codeload.github.com/${REPOSITORY}/tar.gz/${target.commit}`;
  const body = await requestBuffer(url, { maxBytes: MAX_ARCHIVE_BYTES });
  options._obtainedArchive = {
    body,
    digest: createHash('sha256').update(body).digest('hex'),
  };
  return options._obtainedArchive;
}

function decodeUtf8(buffer, description) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail(`${description} is not valid UTF-8`);
  }
}

function tarString(block, start, length, description) {
  const slice = block.subarray(start, start + length);
  const zero = slice.indexOf(0);
  const body = zero === -1 ? slice : slice.subarray(0, zero);
  return decodeUtf8(body, description);
}

function tarNumber(block, start, length, description) {
  const field = block.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) fail(`Base-256 ${description} is not supported`);
  const text = field.toString('ascii').replace(/\0.*$/su, '').trim();
  if (!/^[0-7]*$/u.test(text)) fail(`Invalid tar ${description}`);
  const value = text === '' ? 0 : Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`Invalid tar ${description}`);
  return value;
}

function verifyTarChecksum(block) {
  const expected = tarNumber(block, 148, 8, 'checksum');
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (sum !== expected) fail('Archive contains a tar header with an invalid checksum');
}

function parsePax(body) {
  const result = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) fail('Invalid PAX record');
    const lengthText = body.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/u.test(lengthText)) fail('Invalid PAX record length');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length < 5 || offset + length > body.length) {
      fail('Invalid PAX record boundary');
    }
    const record = body.subarray(space + 1, offset + length);
    if (record.at(-1) !== 0x0a) fail('Invalid PAX record terminator');
    const text = decodeUtf8(record.subarray(0, -1), 'PAX record');
    const equals = text.indexOf('=');
    if (equals < 1) fail('Invalid PAX key/value record');
    result[text.slice(0, equals)] = text.slice(equals + 1);
    offset += length;
  }
  return result;
}

function validateRawArchivePath(value) {
  assertNoControls(value, 'archive path');
  if (!value || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value) ||
      value.includes('\\')) {
    fail(`Unsafe archive path: ${value}`);
  }
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = trimmed.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail(`Unsafe archive path: ${value}`);
  }
  for (const part of parts) {
    if (/[<>:"|?*]/u.test(part) || /[. ]$/u.test(part)) {
      fail(`Archive path is not portable across supported systems: ${value}`);
    }
    const stem = part.split('.')[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) {
      fail(`Archive path uses a reserved Windows device name: ${value}`);
    }
  }
  if (Buffer.byteLength(trimmed) > MAX_RELATIVE_PATH_BYTES || parts.length > MAX_TREE_DEPTH + 1) {
    fail(`Archive path exceeds managed limits: ${value}`);
  }
  return parts;
}

function parseTarGzip(archive) {
  let expanded;
  try {
    expanded = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch (error) {
    fail(`Cannot decompress release archive: ${error.message}`);
  }
  if (expanded.length > MAX_EXPANDED_BYTES) fail('Expanded archive exceeds managed limits');
  const rawEntries = [];
  let offset = 0;
  let pendingPax = null;
  let ended = false;
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    verifyTarChecksum(header);
    const magic = header.subarray(257, 263).toString('ascii').replace(/\0+$/u, '');
    if (magic !== 'ustar') fail('Archive is not a POSIX ustar/PAX archive');
    const name = tarString(header, 0, 100, 'tar path');
    const prefix = tarString(header, 345, 155, 'tar prefix');
    let entryPath = prefix ? `${prefix}/${name}` : name;
    const size = tarNumber(header, 124, 12, 'size');
    if (size > MAX_FILE_BYTES && header[156] !== 0x35) fail(`Archive entry is too large: ${entryPath}`);
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > expanded.length) fail('Truncated tar entry');
    const body = expanded.subarray(offset, offset + size);
    offset += padded;
    const typeByte = header[156];
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    if (type === 'x') {
      validateRawArchivePath(entryPath);
      if (pendingPax) fail('Consecutive PAX headers are not supported');
      pendingPax = parsePax(body);
      if (pendingPax.linkpath != null || pendingPax.size != null) {
        fail('PAX linkpath/size overrides are not permitted');
      }
      continue;
    }
    if (type === 'g' || type === 'L' || type === 'K') {
      fail(`Unsupported tar metadata entry type: ${type}`);
    }
    if (pendingPax?.path != null) entryPath = pendingPax.path;
    pendingPax = null;
    if (type === '1' || type === '2') fail(`Archive links are not permitted: ${entryPath}`);
    if (type !== '0' && type !== '5') fail(`Unsupported tar entry type ${JSON.stringify(type)}: ${entryPath}`);
    const parts = validateRawArchivePath(entryPath);
    rawEntries.push({ rawPath: entryPath, parts, type, body: type === '0' ? Buffer.from(body) : null });
    if (rawEntries.length > MAX_ENTRIES) fail(`Archive contains more than ${MAX_ENTRIES} entries`);
  }
  if (!ended || pendingPax) fail('Archive is missing a complete tar terminator');
  if (expanded.subarray(offset).some((byte) => byte !== 0)) fail('Archive has non-zero data after its terminator');
  if (rawEntries.length === 0) fail('Release archive is empty');

  const prefixes = new Set(rawEntries.map((entry) => entry.parts[0]));
  if (prefixes.size !== 1) fail('Release archive must have exactly one top-level directory');
  const prefix = [...prefixes][0];
  if (prefix !== 'package' && !/^antigravity-telegram-cli-[0-9a-f]{7,40}$/u.test(prefix)) {
    fail(`Unexpected release archive root: ${prefix}`);
  }
  const entries = [];
  const seen = new Map();
  let totalBytes = 0;
  for (const entry of rawEntries) {
    const relativeParts = entry.parts.slice(1);
    if (relativeParts.length === 0) {
      if (entry.type !== '5') fail('Top-level archive root must be a directory');
      continue;
    }
    const relative = relativeParts.join('/');
    const identity = relative.normalize('NFC').toLocaleLowerCase('en-US');
    if (seen.has(identity)) fail(`Duplicate/case-colliding archive path: ${relative}`);
    seen.set(identity, relative);
    if (relativeParts.length > MAX_TREE_DEPTH) fail(`Archive path is too deep: ${relative}`);
    totalBytes += entry.body?.length || 0;
    if (totalBytes > MAX_EXPANDED_BYTES) fail('Archive file content exceeds managed limits');
    entries.push({ ...entry, relative, relativeParts });
  }
  const fileNames = new Set(entries.filter((entry) => entry.type === '0').map((entry) => entry.relative));
  for (const required of ['package.json', 'npm-shrinkwrap.json', 'scripts/check.js', 'bin/agygram.js']) {
    if (!fileNames.has(required)) fail(`Release archive is missing ${required}`);
  }
  return entries;
}

async function extractEntries(entries, destination) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const directories = entries
    .filter((entry) => entry.type === '5')
    .sort((left, right) => left.relativeParts.length - right.relativeParts.length);
  for (const entry of directories) {
    await mkdir(path.join(destination, ...entry.relativeParts), { recursive: true, mode: 0o700 });
  }
  for (const entry of entries.filter((item) => item.type === '0')) {
    const target = path.join(destination, ...entry.relativeParts);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const executable = entry.relative === 'bin/agygram.js' ||
      entry.relative.startsWith('scripts/') && /\.(?:js|mjs|sh)$/u.test(entry.relative);
    await writeFile(target, entry.body, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
  }
}

async function auditExtractedTree(root) {
  const pending = [{ target: root, depth: 0 }];
  let count = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const { target, depth } = pending.pop();
    const info = await lstat(target);
    if (info.isSymbolicLink()) fail(`Extracted release contains a symbolic link: ${target}`);
    if (info.isDirectory()) {
      if (depth > MAX_TREE_DEPTH) fail('Extracted release exceeds the directory-depth limit');
      for (const name of await readdir(target)) {
        pending.push({ target: path.join(target, name), depth: depth + 1 });
      }
    } else if (info.isFile()) {
      bytes += info.size;
      if (info.size > MAX_FILE_BYTES) fail(`Extracted file exceeds the size limit: ${target}`);
    } else {
      fail(`Extracted release contains an unsupported filesystem object: ${target}`);
    }
    count += 1;
    if (count > MAX_ENTRIES + 1 || bytes > MAX_EXPANDED_BYTES) {
      fail('Extracted release exceeds managed tree limits');
    }
  }
}

function cleanChildEnvironment(overrides = {}) {
  const allowedExact = new Set([
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'LANG',
  ]);
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowedExact.has(key) || key.startsWith('LC_')) result[key] = value;
  }
  // Deliberately do not copy BOT_TOKEN, GH/GITHUB/NPM/NODE auth variables,
  // cloud credentials, API keys, loader controls, or arbitrary caller state.
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) delete result[key];
    else result[key] = value;
  }
  return result;
}

function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  if (signal === 'SIGKILL') {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      env: cleanChildEnvironment(),
    });
    killer.once('error', () => child.kill('SIGTERM'));
  } else {
    child.kill('SIGTERM');
  }
}

function runCommand(file, args, {
  cwd,
  timeoutMs = COMMAND_TIMEOUT_MS,
  allowFailure = false,
  env = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: cleanChildEnvironment(env),
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let timedOut = false;
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 5_000);
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (allowFailure) resolve(false);
      else reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (timedOut && allowFailure) resolve(false);
      else if (timedOut) reject(new Error(`${file} timed out after ${timeoutMs}ms`));
      else if (code === 0) resolve(true);
      else if (allowFailure) resolve(false);
      else {
        const reason = timedOut ? `timed out after ${timeoutMs}ms`
          : signal ? `stopped by signal ${signal}` : `failed with exit code ${code}`;
        reject(new Error(`${file} ${reason}`));
      }
    });
  });
}

async function findNpmCli() {
  // npm invokes child scripts with this absolute path. Accept it only when it
  // resolves inside the active Node distribution; never trust an arbitrary
  // environment-provided JavaScript path.
  let npmExecPath = null;
  if (process.env.npm_execpath && path.isAbsolute(process.env.npm_execpath)) {
    try {
      const nodeRoot = await realpath(path.resolve(path.dirname(process.execPath), '..'));
      const resolved = await realpath(process.env.npm_execpath);
      if (isStrictDescendant(nodeRoot, resolved)) npmExecPath = resolved;
    } catch {
      // Standard distribution locations below remain authoritative fallbacks.
    }
  }
  const candidates = [
    npmExecPath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.platform === 'linux' ? [
      '/usr/share/nodejs/npm/bin/npm-cli.js',
      '/usr/lib/node_modules/npm/bin/npm-cli.js',
      '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    ] : []),
  ].filter((candidate) => candidate && path.isAbsolute(candidate));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) continue;
      if (process.platform !== 'win32') {
        const uid = process.getuid?.();
        let current = resolved;
        while (true) {
          const info = await lstat(current);
          if ((info.uid !== 0 && info.uid !== uid) || (info.mode & 0o022) !== 0) {
            fail(`npm CLI has an untrusted writable/owned path component: ${current}`);
          }
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
      return resolved;
    } catch {
      // Try the next standard Node/npm layout.
    }
  }
  fail('Could not locate npm-cli.js beside the active Node.js installation');
}

async function readCandidatePackage(candidate) {
  const packagePath = path.join(candidate, 'package.json');
  const packageJson = await readJsonFile(packagePath, { maxBytes: 256 * 1024 });
  if (packageJson.name !== PACKAGE_NAME) fail(`Unexpected package name: ${packageJson.name}`);
  if (!SEMVER_RE.test(packageJson.version)) fail(`Candidate has invalid package version: ${packageJson.version}`);
  return packageJson;
}

const REQUIRED_RELEASE_FILES = [
  'package.json',
  'npm-shrinkwrap.json',
  '.env.example',
  'bin/agygram.js',
  'scripts/check.js',
  'scripts/uninstall.mjs',
  'src/index.js',
  'src/doctor.js',
  'src/config.js',
  'src/service/index.js',
  'src/service/file-runner.js',
  'src/service/runtime-paths.js',
];

async function validateCandidateArtifacts(candidate) {
  for (const relative of REQUIRED_RELEASE_FILES) {
    const target = path.join(candidate, ...relative.split('/'));
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error.code === 'ENOENT') fail(`Candidate release is missing ${relative}`);
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      fail(`Candidate artifact must be a regular non-symlink file: ${relative}`);
    }
  }
}

async function verifyCandidateSourceTree(candidate, entries) {
  const expected = new Map(entries.map((entry) => [entry.relative, entry]));
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const directory = relativeDirectory
      ? path.join(candidate, ...relativeDirectory.split('/'))
      : candidate;
    for (const name of await readdir(directory)) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relative === 'node_modules' || relative === RELEASE_MARKER ||
          relative === RELEASE_INVENTORY) continue;
      const expectedEntry = expected.get(relative);
      const target = path.join(directory, name);
      const info = await lstat(target);
      if (!expectedEntry && info.isDirectory() &&
          [...expected.keys()].some((candidate) => candidate.startsWith(`${relative}/`))) {
        pending.push(relative);
        continue;
      }
      if (!expectedEntry) fail(`Managed release source has an unexpected path: ${relative}`);
      if (info.isSymbolicLink()) fail(`Managed release source is a symlink: ${relative}`);
      if (expectedEntry.type === '5') {
        if (!info.isDirectory()) fail(`Managed release directory was replaced: ${relative}`);
        pending.push(relative);
      } else {
        if (!info.isFile() || info.size !== expectedEntry.body.length) {
          fail(`Managed release file was modified: ${relative}`);
        }
        const actual = createHash('sha256').update(await readFile(target)).digest('hex');
        const wanted = createHash('sha256').update(expectedEntry.body).digest('hex');
        if (actual !== wanted) fail(`Managed release file was modified: ${relative}`);
      }
      expected.delete(relative);
    }
  }
  // Tarballs need not carry explicit parent directory records. Only unvisited
  // file entries indicate an absent artifact; implicit directories are fine.
  const missingFile = [...expected.values()].find((entry) => entry.type === '0');
  if (missingFile) fail(`Managed release source is missing ${missingFile.relative}`);
}

async function buildReleaseInventory(root) {
  const records = [];
  const pending = [''];
  let totalBytes = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const directory = relativeDirectory
      ? path.join(root, ...relativeDirectory.split('/'))
      : root;
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relative === RELEASE_MARKER || relative === RELEASE_INVENTORY) continue;
      const target = path.join(directory, name);
      const info = await lstat(target);
      if (info.isDirectory()) {
        records.push({ path: relative, type: 'directory' });
        pending.push(relative);
      } else if (info.isFile()) {
        totalBytes += info.size;
        records.push({
          path: relative,
          type: 'file',
          size: info.size,
          sha256: createHash('sha256').update(await readFile(target)).digest('hex'),
        });
      } else if (info.isSymbolicLink()) {
        if (!relative.startsWith('node_modules/.bin/')) {
          fail(`Installed release has an unexpected symlink: ${relative}`);
        }
        const targetText = await readlink(target);
        const resolved = path.resolve(path.dirname(target), targetText);
        if (!isStrictDescendant(root, resolved)) {
          fail(`Installed release symlink escapes its release: ${relative}`);
        }
        records.push({ path: relative, type: 'symlink', target: targetText });
      } else {
        fail(`Installed release has an unsupported filesystem object: ${relative}`);
      }
      if (records.length > 50_000 || totalBytes > 512 * 1024 * 1024) {
        fail('Installed release exceeds inventory limits');
      }
    }
  }
  records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return {
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    repository: REPOSITORY,
    records,
  };
}

async function writeReleaseInventory(root) {
  const inventory = await buildReleaseInventory(root);
  await atomicWrite(
    path.join(root, RELEASE_INVENTORY),
    `${JSON.stringify(inventory)}\n`,
  );
  return inventory;
}

async function verifyReleaseInventory(root) {
  const recorded = await readJsonFile(path.join(root, RELEASE_INVENTORY), {
    maxBytes: 16 * 1024 * 1024,
  });
  if (recorded.schemaVersion !== SCHEMA_VERSION || recorded.owner !== OWNER ||
      recorded.repository !== REPOSITORY || !Array.isArray(recorded.records)) {
    fail('Managed release inventory is invalid');
  }
  const actual = await buildReleaseInventory(root);
  if (JSON.stringify(recorded.records) !== JSON.stringify(actual.records)) {
    fail('Managed release integrity check failed; uninstall and reinstall this version');
  }
}

function releaseMarker(target, targetRelease, archiveSha256) {
  return {
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    repository: REPOSITORY,
    version: target.version,
    tag: target.tag,
    commit: target.commit,
    releaseName: targetRelease,
    archiveSha256,
    installedAt: new Date().toISOString(),
  };
}

async function validateReleaseMarker(releaseDir, expected) {
  const rootInfo = await lstat(releaseDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail(`Invalid managed release directory: ${releaseDir}`);
  const marker = await readJsonFile(path.join(releaseDir, RELEASE_MARKER));
  if (marker.schemaVersion !== SCHEMA_VERSION || marker.owner !== OWNER ||
      marker.repository !== REPOSITORY || marker.releaseName !== expected.releaseName ||
      !SEMVER_RE.test(marker.version || '') || !COMMIT_RE.test(marker.commit || '') ||
      marker.releaseName !== releaseName(marker.version, marker.commit) ||
      (marker.tag != null && marker.tag !== `v${marker.version}`) ||
      (expected.version && marker.version !== expected.version) ||
      (expected.commit && marker.commit !== expected.commit)) {
    fail(`Release marker does not match ${expected.releaseName}`);
  }
  return marker;
}

async function prepareRelease(installRoot, options, target) {
  const releasesDir = path.join(installRoot, 'releases');
  await ensurePrivateDirectory(releasesDir, 'releases directory');
  const targetRelease = releaseName(target.version, target.commit);
  const finalDir = path.join(releasesDir, targetRelease);
  // Always compare an existing immutable release with the incoming, exact
  // archive—not merely with its self-authored marker.
  const archive = await obtainArchive(options, target);
  const entries = parseTarGzip(archive.body);
  try {
    const marker = await validateReleaseMarker(finalDir, {
      releaseName: targetRelease,
      version: target.version,
      commit: target.commit,
    });
    if (marker.archiveSha256 !== archive.digest) {
      fail('Existing release archive digest does not match the incoming release');
    }
    await verifyCandidateSourceTree(finalDir, entries);
    await verifyReleaseInventory(finalDir);
    const pkg = await readCandidatePackage(finalDir);
    if (pkg.version !== target.version) fail('Existing release package version does not match its marker');
    await validateCandidateArtifacts(finalDir);
    return { releaseDir: finalDir, targetRelease, reused: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const staging = path.join(releasesDir, `.staging-${process.pid}-${randomUUID()}`);
  try {
    await extractEntries(entries, staging);
    await auditExtractedTree(staging);
    await validateCandidateArtifacts(staging);
    const pkg = await readCandidatePackage(staging);
    if (pkg.version !== target.version) {
      fail(`Candidate package version ${pkg.version} does not match expected ${target.version}`);
    }
    const npmCli = await findNpmCli();
    await runCommand(process.execPath, ['--',
      npmCli,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ], { cwd: staging });
    await runCommand(
      process.execPath,
      ['--', path.join(staging, 'scripts', 'check.js')],
      { cwd: staging },
    );
    await writeReleaseInventory(staging);
    const marker = releaseMarker(target, targetRelease, archive.digest);
    await atomicWrite(path.join(staging, RELEASE_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    await rename(staging, finalDir);
    return { releaseDir: finalDir, targetRelease, reused: false };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function parseEnv(text) {
  const values = new Map();
  for (const original of text.split(/\r?\n/u)) {
    let line = original.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('`') && value.endsWith('`'))) {
      value = value.slice(1, -1);
      if (match[2].trim().startsWith('"')) {
        value = value.replace(/\\n/gu, '\n').replace(/\\r/gu, '\r');
      }
    } else {
      const comment = value.search(/\s+#/u);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    values.set(match[1], value);
  }
  return values;
}

function envLiteral(value) {
  assertNoControls(value, 'environment value');
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  if (!value.includes('#')) return value;
  if (!value.includes('"') && !/\\[nr]/u.test(value)) return `"${value}"`;
  fail('Environment path cannot be represented safely by dotenv');
}

function setEnvValue(text, key, value, { replaceActive = true } = {}) {
  const lines = text.split(/\r?\n/u);
  const active = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'u');
  const commented = new RegExp(`^\\s*#\\s*${key}\\s*=`, 'u');
  let changed = false;
  let foundActive = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (active.test(lines[index])) {
      foundActive = true;
      if (replaceActive) {
        const replacement = `${key}=${envLiteral(value)}`;
        if (lines[index] !== replacement) {
          lines[index] = replacement;
          changed = true;
        }
      }
    }
  }
  if (!foundActive) {
    const commentedIndex = lines.findIndex((line) => commented.test(line));
    if (commentedIndex >= 0) lines[commentedIndex] = `${key}=${envLiteral(value)}`;
    else lines.push(`${key}=${envLiteral(value)}`);
    changed = true;
  }
  return {
    text: changed ? `${lines.join('\n').replace(/\n+$/u, '')}\n` : text,
    changed,
  };
}

async function resolveExecutable(configured) {
  const names = process.platform === 'win32' ? ['agy.exe'] : ['agy'];
  const candidates = [];
  if (configured) {
    if (!path.isAbsolute(configured)) fail(`agy executable must be absolute: ${configured}`);
    candidates.push(configured);
  } else {
    for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
      if (directory && path.isAbsolute(directory)) {
        for (const name of names) candidates.push(path.join(directory, name));
      }
    }
    const home = os.homedir();
    for (const name of names) {
      candidates.push(path.join(home, '.local', 'bin', name), path.join(home, 'bin', name));
      if (process.platform === 'darwin') candidates.push(path.join('/opt/homebrew/bin', name));
      if (process.platform !== 'win32') candidates.push(path.join('/usr/local/bin', name));
      if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        candidates.push(
          path.join(process.env.LOCALAPPDATA, 'agy', 'bin', name),
          path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin', name),
        );
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) continue;
      await access(resolved, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      if (process.platform === 'win32' && path.extname(resolved).toLowerCase() !== '.exe') continue;
      return resolved;
    } catch {
      // Continue through deterministic candidates.
    }
  }
  fail('agy executable was not found; pass its absolute path with --agy-bin');
}

async function prepareExternalConfiguration(candidate, defaults, options, installRoot) {
  const configFile = path.resolve(options.envFile || defaults.envFile);
  assertAbsoluteSafePath(configFile, 'configuration file');
  let text;
  let originalText = null;
  let existed = true;
  try {
    const info = await lstat(configFile);
    if (!info.isFile() || info.isSymbolicLink()) fail(`Configuration must be a regular file: ${configFile}`);
    if (info.size > 1024 * 1024) fail('Configuration file is unexpectedly large');
    text = await readFile(configFile, 'utf8');
    originalText = text;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (options.requireExistingConfig) {
      fail(`Previously managed configuration is missing: ${configFile}`);
    }
    existed = false;
    text = await readFile(path.join(candidate, '.env.example'), 'utf8');
  }

  let parsed = parseEnv(text);
  const existingAgy = existed ? parsed.get('AGY_BIN') : null;
  const agyBin = await resolveExecutable(
    options.agyBin || (existingAgy && path.isAbsolute(existingAgy) ? existingAgy : null),
  );
  const existingData = existed ? parsed.get('DATA_DIR') : null;
  const existingWorkspace = existed ? parsed.get('WORKSPACE_DIR') : null;
  if (existingData && !path.isAbsolute(existingData)) {
    fail(`Existing DATA_DIR must be absolute for managed installs: ${existingData}`);
  }
  if (existingWorkspace && !path.isAbsolute(existingWorkspace)) {
    fail(`Existing WORKSPACE_DIR must be absolute for managed installs: ${existingWorkspace}`);
  }
  const dataDir = path.resolve(existingData || defaults.dataDir);
  const workspaceDir = path.resolve(existingWorkspace || defaults.workspaceDir);
  await assertNoPathOverlaps([
    ['managed install root', installRoot],
    ['configuration', configFile],
    ['data', dataDir],
    ['workspace', workspaceDir],
  ]);
  await ensurePrivateDirectory(path.dirname(configFile), 'configuration directory', {
    mutateExisting: false,
  });
  for (const [key, value, replaceActive] of [
    ['DATA_DIR', dataDir, !existed],
    ['WORKSPACE_DIR', workspaceDir, !existed],
    ['AGY_BIN', agyBin, Boolean(options.agyBin) || !existingAgy || !path.isAbsolute(existingAgy)],
  ]) {
    const result = setEnvValue(text, key, value, { replaceActive });
    text = result.text;
  }
  let contentChanged = !existed || text !== originalText;
  if (process.platform === 'win32' && contentChanged) {
    text = setEnvValue(text, 'WINDOWS_ACL_VERIFIED', 'false', { replaceActive: true }).text;
  }
  parsed = parseEnv(text);
  contentChanged = !existed || text !== originalText;
  if (!contentChanged && process.platform !== 'win32') {
    const configInfo = await lstat(configFile);
    if ((configInfo.mode & 0o077) !== 0) {
      fail(`Configuration permissions must be 0600: ${configFile}`);
    }
  }
  await ensurePrivateDirectory(dataDir, 'data directory', { mutateExisting: false });
  await ensurePrivateDirectory(workspaceDir, 'workspace directory', { mutateExisting: false });

  const incomplete = [];
  if (!parsed.get('BOT_TOKEN')?.trim()) incomplete.push('BOT_TOKEN');
  const allowed = parsed.get('ALLOWED_CHAT_IDS') || parsed.get('ALLOWED_CHAT_ID');
  if (!allowed?.trim() || !allowed.split(',').every((item) => /^-?\d+$/u.test(item.trim()))) {
    incomplete.push('ALLOWED_CHAT_IDS');
  }
  if (process.platform === 'win32' && !/^(?:1|true|yes|on)$/iu.test(parsed.get('WINDOWS_ACL_VERIFIED') || '')) {
    incomplete.push('WINDOWS_ACL_VERIFIED');
  }
  const serviceEnvironment = {
    xdgConfigHome: process.platform === 'linux'
      ? path.resolve(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'))
      : null,
  };
  return {
    configFile,
    dataDir,
    workspaceDir,
    agyBin,
    incomplete,
    created: !existed,
    serviceEnvironment,
    configMutation: {
      existed,
      before: originalText,
      beforeSha256: originalText == null ? null : hashText(originalText),
      afterSha256: hashText(text),
      changed: contentChanged,
      restored: false,
      proposed: text,
      applied: false,
    },
  };
}

async function applyExternalConfiguration(external) {
  const mutation = external.configMutation;
  if (!mutation.changed || mutation.applied) return;
  await atomicWrite(external.configFile, mutation.proposed, { mode: 0o600 });
  mutation.applied = true;
}

async function restoreExternalConfiguration(external) {
  const mutation = external?.configMutation;
  if (!mutation?.changed || !mutation.applied || mutation.restored) return true;
  if (!mutation.existed) {
    // A first-run config is useful operator input and contains no inherited
    // service state. Preserve it explicitly rather than deleting user edits.
    process.stderr.write(`warning: preserving newly created configuration after rollback: ${external.configFile}\n`);
    mutation.restored = true;
    return true;
  }
  const current = await readFile(external.configFile, 'utf8');
  const currentDigest = hashText(current);
  if (currentDigest !== mutation.afterSha256) {
    fail(`Configuration changed concurrently; refusing to overwrite it during rollback: ${external.configFile}`);
  }
  await atomicWrite(external.configFile, mutation.before, { mode: 0o600 });
  mutation.restored = true;
  return true;
}

function launcherSource(installRoot) {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = ${JSON.stringify(installRoot)};
const owner = ${JSON.stringify(OWNER)};
const repository = ${JSON.stringify(REPOSITORY)};
const semver = new RegExp(${JSON.stringify(SEMVER_RE.source)}, 'u');
const readJson = async (target) => {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) {
    throw new Error(\`invalid managed metadata: \${target}\`);
  }
  return JSON.parse(await readFile(target, 'utf8'));
};
const pointer = (await readFile(path.join(root, 'current'), 'utf8')).trim();
if (!/^[A-Za-z0-9._+-]{1,180}$/u.test(pointer) || pointer === '.' || pointer === '..') {
  throw new Error('agygram managed current pointer is invalid');
}
const manifest = await readJson(path.join(root, 'manifest.json'));
if (manifest.schemaVersion !== 1 || manifest.owner !== owner || manifest.repository !== repository ||
    !semver.test(manifest.version) || !/^[0-9a-f]{40}$/u.test(manifest.commit) ||
    manifest.currentRelease !== pointer || pointer !== \`v\${manifest.version}-\${manifest.commit}\` ||
    (manifest.tag != null && manifest.tag !== \`v\${manifest.version}\`) ||
    !path.isAbsolute(manifest.configFile) || !path.isAbsolute(manifest.dataDir)) {
  throw new Error('agygram managed manifest is invalid or inconsistent');
}
const release = path.join(root, 'releases', pointer);
const info = await lstat(release);
if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('agygram managed release is invalid');
const marker = await readJson(path.join(release, '.agygram-release.json'));
if (marker.schemaVersion !== 1 || marker.owner !== owner || marker.repository !== repository ||
    marker.version !== manifest.version || marker.commit !== manifest.commit ||
    marker.releaseName !== pointer) {
  throw new Error('agygram managed release marker is inconsistent');
}
const entry = path.join(release, 'bin', 'agygram.js');
const entryInfo = await lstat(entry);
if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new Error('agygram entrypoint is invalid');
const forwarded = process.argv.slice(2);
const managedFlags = new Set(['--config-file', '--data-dir', '--project-dir']);
if (forwarded.some((arg) => [...managedFlags].some((flag) => arg === flag || arg.startsWith(\`\${flag}=\`)))) {
  throw new Error('managed doctor/service paths cannot be overridden from the launcher');
}
const helpOnly = forwarded.includes('-h') || forwarded.includes('--help');
if (forwarded[0] === 'service' && ['install', 'uninstall'].includes(forwarded[1])) {
  throw new Error('managed service changes must use the installer or uninstaller');
}
if (!helpOnly && forwarded[0] === 'doctor') {
  forwarded.push('--config-file', manifest.configFile, '--data-dir', manifest.dataDir);
} else if (!helpOnly && forwarded[0] === 'service') {
  forwarded.push(
    '--project-dir', release,
    '--config-file', manifest.configFile,
    '--data-dir', manifest.dataDir,
  );
}
const child = spawn(process.execPath, ['--', entry, ...forwarded], {
  cwd: release,
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
});
const signalHandlers = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
  const handler = () => child.kill(signal);
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}
const removeSignalHandlers = () => {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
};
child.once('error', (error) => {
  removeSignalHandlers();
  console.error(\`agygram: \${error.message}\`);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  removeSignalHandlers();
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`;
}

function shellQuote(value) {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function planLaunchers(installRoot) {
  const directory = await ensurePrivateDirectory(path.join(installRoot, 'bin'), 'launcher directory');
  const jsPath = path.join(directory, 'agygram.mjs');
  const js = launcherSource(installRoot);
  const planned = [{ path: jsPath, body: js, mode: 0o700 }];
  if (process.platform === 'win32') {
    const commandPath = path.join(directory, 'agygram.cmd');
    const batchPath = (value) => value.replace(/%/gu, '%%').replace(/"/gu, '""');
    const command = `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${batchPath(process.execPath)}" -- "${batchPath(jsPath)}" %*\r\n`;
    planned.push({ path: commandPath, body: command, mode: 0o700 });
  } else {
    const commandPath = path.join(directory, 'agygram');
    const command = `#!/bin/sh\nexec ${shellQuote(process.execPath)} -- ${shellQuote(jsPath)} "$@"\n`;
    planned.push({ path: commandPath, body: command, mode: 0o700 });
  }
  let changed = false;
  for (const file of planned) {
    const current = await readFile(file.path).catch(() => null);
    if (!current || hashText(current) !== hashText(file.body)) changed = true;
  }
  return {
    receipt: {
      directory,
      files: planned.map((file) => ({
        path: file.path,
        kind: 'file',
        sha256: hashText(file.body),
      })),
    },
    files: planned,
    changed,
  };
}

async function applyLaunchers(plan) {
  for (const file of plan.files) {
    await atomicWrite(file.path, file.body, { mode: file.mode });
  }
}

async function invokeAgygram(releaseDir, action, external, { allowFailure = false } = {}) {
  const entry = path.join(releaseDir, 'bin', 'agygram.js');
  const common = [
    '--project-dir', releaseDir,
    '--config-file', external.configFile,
    '--data-dir', external.dataDir,
  ];
  const args = action === 'doctor'
    ? [entry, 'doctor', '--config-file', external.configFile, '--data-dir', external.dataDir]
    : [entry, 'service', action, ...common];
  return runCommand(process.execPath, ['--', ...args], {
    cwd: releaseDir,
    allowFailure,
    env: external.serviceEnvironment?.xdgConfigHome
      ? { XDG_CONFIG_HOME: external.serviceEnvironment.xdgConfigHome }
      : {},
  });
}

function makeManifest({ target, targetRelease, previousRelease, external, launcher, serviceInstalled, installedAt }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    repository: REPOSITORY,
    version: target.version,
    tag: target.tag,
    commit: target.commit,
    currentRelease: targetRelease,
    previousRelease,
    configFile: external.configFile,
    configSha256: external.configMutation?.afterSha256 || external.configSha256 || null,
    dataDir: external.dataDir,
    workspaceDir: external.workspaceDir,
    serviceEnvironment: external.serviceEnvironment || { xdgConfigHome: null },
    serviceInstalled,
    launcher,
    installedAt,
    updatedAt: new Date().toISOString(),
  };
}

function externalFromManifest(manifest) {
  return {
    configFile: manifest.configFile,
    dataDir: manifest.dataDir,
    workspaceDir: manifest.workspaceDir,
    configSha256: manifest.configSha256 || null,
    serviceEnvironment: manifest.serviceEnvironment || { xdgConfigHome: null },
  };
}

async function writeManifest(installRoot, manifest) {
  await atomicWrite(path.join(installRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeCurrent(installRoot, targetRelease) {
  validateReleaseName(targetRelease);
  await atomicWrite(path.join(installRoot, CURRENT_FILE), `${targetRelease}\n`);
}

async function removeCurrentState(installRoot) {
  await rm(path.join(installRoot, CURRENT_FILE), { force: true });
  await rm(path.join(installRoot, MANIFEST_FILE), { force: true });
}

function transactionConfigRollback(external) {
  const mutation = external.configMutation;
  return {
    path: external.configFile,
    existed: mutation.existed,
    beforeBase64: mutation.existed ? Buffer.from(mutation.before, 'utf8').toString('base64') : null,
    afterSha256: mutation.afterSha256,
  };
}

async function writeTransaction(installRoot, transaction) {
  const next = { ...transaction, updatedAt: new Date().toISOString() };
  await atomicWrite(
    path.join(installRoot, TRANSACTION_FILE),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}

async function removeTransaction(installRoot) {
  await rm(path.join(installRoot, TRANSACTION_FILE), { force: true });
}

async function removeUnreferencedRollbackRelease(installRoot, targetManifest, previousManifest) {
  const targetName = targetManifest.currentRelease;
  if (previousManifest && [
    previousManifest.currentRelease,
    previousManifest.previousRelease,
  ].includes(targetName)) return;
  const target = path.join(installRoot, 'releases', targetName);
  try {
    await validateReleaseMarker(target, {
      releaseName: targetName,
      version: targetManifest.version,
      commit: targetManifest.commit,
    });
    await rm(target, { recursive: true, force: false });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function restoreJournalConfig(rollback) {
  if (!rollback?.existed) return;
  if (typeof rollback.path !== 'string' || !path.isAbsolute(rollback.path) ||
      !SHA256_RE.test(rollback.afterSha256 || '') || typeof rollback.beforeBase64 !== 'string') {
    fail('Transaction has invalid configuration rollback metadata');
  }
  const current = await readFile(rollback.path, 'utf8');
  const before = Buffer.from(rollback.beforeBase64, 'base64');
  if (before.length > 1024 * 1024) fail('Transaction configuration backup is too large');
  const currentHash = hashText(current);
  if (currentHash === createHash('sha256').update(before).digest('hex')) return;
  if (currentHash !== rollback.afterSha256) {
    fail(`Configuration changed after an interrupted update: ${rollback.path}`);
  }
  await atomicWrite(rollback.path, before, { mode: 0o600 });
}

async function recoverInterruptedTransaction(installRoot, { invoke = invokeAgygram } = {}) {
  const journalPath = path.join(installRoot, TRANSACTION_FILE);
  const journal = await readJsonFile(journalPath, { maxBytes: 2 * 1024 * 1024, optional: true });
  if (!journal) return;
  if (journal.schemaVersion !== SCHEMA_VERSION || journal.owner !== OWNER ||
      journal.repository !== REPOSITORY ||
      !['prepared', 'old-service-stopped', 'state-written', 'new-service-started'].includes(journal.phase)) {
    fail('Interrupted-install transaction is invalid; refusing automatic recovery');
  }
  const previous = journal.previousManifest;
  const target = journal.targetManifest;
  if (previous) validateManifest(previous, installRoot, previous.currentRelease);
  validateManifest(target, installRoot, target.currentRelease);
  process.stderr.write(`Recovering interrupted update from phase ${journal.phase}...\n`);
  const targetDir = path.join(installRoot, 'releases', target.currentRelease);
  const targetExternal = externalFromManifest(target);
  const targetRemoved = await invoke(targetDir, 'uninstall', targetExternal, {
    allowFailure: true,
  });
  if (!targetRemoved && ['state-written', 'new-service-started'].includes(journal.phase)) {
    fail('Could not remove the interrupted target service; transaction was preserved');
  }
  await restoreJournalConfig(journal.configRollback);
  await applyJournalLaunchers(installRoot, journal);
  if (previous) {
    await writeManifest(installRoot, previous);
    await writeCurrent(installRoot, previous.currentRelease);
  } else {
    await removeCurrentState(installRoot);
  }
  if (previous && (journal.previousServiceActive || previous.serviceInstalled)) {
    const previousDir = path.join(installRoot, 'releases', previous.currentRelease);
    const restored = await invoke(
      previousDir,
      'install',
      externalFromManifest(previous),
      { allowFailure: true },
    );
    if (!restored) fail('Could not restore the previous service; transaction was preserved');
  }
  await removeUnreferencedRollbackRelease(installRoot, target, previous);
  await removeTransaction(installRoot);
  process.stderr.write('Interrupted update rolled back successfully.\n');
}

function newTransaction(
  previousManifest,
  targetManifest,
  external,
  previousServiceActive,
  launcherPlan,
) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    repository: REPOSITORY,
    phase: 'prepared',
    previousManifest,
    targetManifest,
    previousServiceActive,
    configRollback: transactionConfigRollback(external),
    launcherApply: launcherPlan.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      bodyBase64: Buffer.from(file.body).toString('base64'),
    })),
    createdAt: now,
    updatedAt: now,
  };
}

async function applyJournalLaunchers(installRoot, journal) {
  if (!Array.isArray(journal.launcherApply) || journal.launcherApply.length !== 2) {
    fail('Transaction has invalid launcher apply metadata');
  }
  const directory = path.join(installRoot, 'bin');
  for (const file of journal.launcherApply) {
    if (typeof file.path !== 'string' || path.dirname(file.path) !== directory ||
        typeof file.bodyBase64 !== 'string' || file.mode !== 0o700) {
      fail('Transaction launcher path is invalid');
    }
    const body = Buffer.from(file.bodyBase64, 'base64');
    if (body.length > 256 * 1024) fail('Transaction launcher is unexpectedly large');
    await atomicWrite(file.path, body, { mode: file.mode });
  }
}

async function pruneReleases(installRoot, keep) {
  const releasesDir = path.join(installRoot, 'releases');
  const names = await readdir(releasesDir).catch(() => []);
  for (const name of names) {
    if (keep.has(name) || name.startsWith('.staging-')) continue;
    let safeName;
    try {
      safeName = validateReleaseName(name);
    } catch {
      continue;
    }
    const target = path.join(releasesDir, safeName);
    try {
      await validateReleaseMarker(target, { releaseName: safeName });
      await rm(target, { recursive: true, force: false });
    } catch (error) {
      process.stderr.write(`warning: preserving unowned/invalid release ${target}: ${error.message}\n`);
    }
  }
}

async function configureSameRelease(
  installRoot,
  installed,
  prepared,
  external,
  launcher,
  launcherPlan,
  wantService,
  previousServiceActive,
) {
  const oldExternal = externalFromManifest(installed);
  const runtimeChanged = oldExternal.configFile !== external.configFile ||
    oldExternal.dataDir !== external.dataDir ||
    (installed.configSha256 || external.configMutation?.beforeSha256) !==
      external.configMutation?.afterSha256;
  const needsTransition = wantService
    ? runtimeChanged || launcherPlan.changed || !previousServiceActive
    : previousServiceActive || installed.serviceInstalled;
  const manifest = makeManifest({
    target: { version: installed.version, tag: installed.tag, commit: installed.commit },
    targetRelease: installed.currentRelease,
    previousRelease: installed.previousRelease,
    external,
    launcher,
    serviceInstalled: wantService,
    installedAt: installed.installedAt,
  });
  const needsJournal = needsTransition || external.configMutation.changed || launcherPlan.changed;
  if (!needsJournal) {
    await writeManifest(installRoot, manifest);
    return manifest;
  }
  const rollbackManifest = { ...installed, launcher };
  let transaction = newTransaction(
    rollbackManifest,
    manifest,
    external,
    previousServiceActive,
    launcherPlan,
  );
  transaction = await writeTransaction(installRoot, transaction);
  try {
    await applyExternalConfiguration(external);
    await applyLaunchers(launcherPlan);
    if (wantService && needsTransition) {
      await invokeAgygram(prepared.releaseDir, 'doctor', external);
    }
    // Uninstall is idempotent and also removes a stale service that the old
    // manifest failed to record.
    if (previousServiceActive || installed.serviceInstalled) {
      const removed = await invokeAgygram(prepared.releaseDir, 'uninstall', oldExternal, {
        allowFailure: !previousServiceActive,
      });
      if (!removed && previousServiceActive) fail('Could not remove the active previous service');
    }
    transaction = await writeTransaction(installRoot, {
      ...transaction,
      phase: 'old-service-stopped',
    });
    if (wantService && needsTransition) {
      await invokeAgygram(prepared.releaseDir, 'install', external);
      transaction = await writeTransaction(installRoot, {
        ...transaction,
        phase: 'new-service-started',
      });
    }
    await writeManifest(installRoot, manifest);
    await removeTransaction(installRoot);
    return manifest;
  } catch (error) {
    const problems = [];
    if (needsTransition) {
      await invokeAgygram(prepared.releaseDir, 'uninstall', external, { allowFailure: true });
    }
    try { await restoreExternalConfiguration(external); } catch (cause) {
      problems.push(`configuration restore failed: ${cause.message}`);
    }
    try { await writeManifest(installRoot, rollbackManifest); } catch (cause) {
      problems.push(`manifest restore failed: ${cause.message}`);
    }
    if (previousServiceActive || installed.serviceInstalled) {
      const restored = await invokeAgygram(prepared.releaseDir, 'install', oldExternal, {
        allowFailure: true,
      });
      if (!restored) problems.push('previous service restart failed');
    }
    if (problems.length === 0) {
      await removeUnreferencedRollbackRelease(installRoot, manifest, rollbackManifest);
      await removeTransaction(installRoot);
    }
    else error.message += `; rollback warning: ${problems.join(', ')}`;
    throw error;
  }
}

async function switchRelease(
  installRoot,
  installed,
  prepared,
  target,
  external,
  launcher,
  launcherPlan,
  wantService,
  previousServiceActive,
) {
  const oldReleaseDir = installed
    ? path.join(installRoot, 'releases', installed.currentRelease)
    : null;
  const oldExternal = installed ? externalFromManifest(installed) : null;
  const installedAt = new Date().toISOString();
  let manifest = makeManifest({
    target,
    targetRelease: prepared.targetRelease,
    previousRelease: installed?.currentRelease || null,
    external,
    launcher,
    serviceInstalled: false,
    installedAt,
  });
  const rollbackManifest = installed ? { ...installed, launcher } : null;
  let transaction = newTransaction(
    rollbackManifest,
    manifest,
    external,
    previousServiceActive,
    launcherPlan,
  );
  transaction = await writeTransaction(installRoot, transaction);
  try {
    await applyExternalConfiguration(external);
    await applyLaunchers(launcherPlan);
    if (wantService) await invokeAgygram(prepared.releaseDir, 'doctor', external);
    if (installed && (previousServiceActive || installed.serviceInstalled)) {
      const removed = await invokeAgygram(oldReleaseDir, 'uninstall', oldExternal, {
        allowFailure: !previousServiceActive,
      });
      if (!removed && previousServiceActive) fail('Could not remove the active previous service');
    }
    transaction = await writeTransaction(installRoot, {
      ...transaction,
      phase: 'old-service-stopped',
    });
    await writeManifest(installRoot, manifest);
    await writeCurrent(installRoot, prepared.targetRelease);
    transaction = await writeTransaction(installRoot, {
      ...transaction,
      phase: 'state-written',
    });
    if (wantService) {
      await invokeAgygram(prepared.releaseDir, 'install', external);
      manifest = { ...manifest, serviceInstalled: true, updatedAt: new Date().toISOString() };
      await writeManifest(installRoot, manifest);
      transaction = await writeTransaction(installRoot, {
        ...transaction,
        phase: 'new-service-started',
        targetManifest: manifest,
      });
    }
    await removeTransaction(installRoot);
    return manifest;
  } catch (error) {
    const rollbackProblems = [];
    const removed = await invokeAgygram(prepared.releaseDir, 'uninstall', external, { allowFailure: true });
    if (!removed && wantService) rollbackProblems.push('candidate service cleanup failed');
    try { await restoreExternalConfiguration(external); } catch (restoreError) {
      rollbackProblems.push(`configuration restore failed: ${restoreError.message}`);
    }
    try {
      if (rollbackManifest) {
        await writeManifest(installRoot, rollbackManifest);
        await writeCurrent(installRoot, rollbackManifest.currentRelease);
      } else await removeCurrentState(installRoot);
    } catch (restoreError) {
      rollbackProblems.push(`pointer restore failed: ${restoreError.message}`);
    }
    if (installed && (previousServiceActive || installed.serviceInstalled)) {
      const restored = await invokeAgygram(oldReleaseDir, 'install', oldExternal, { allowFailure: true });
      if (!restored) rollbackProblems.push('previous service restart failed');
    }
    if (rollbackProblems.length === 0) {
      await removeUnreferencedRollbackRelease(installRoot, manifest, rollbackManifest);
      await removeTransaction(installRoot);
    }
    else error.message += `; rollback warning: ${rollbackProblems.join(', ')}`;
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  assertNodeVersion();
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (process.platform !== 'win32' && process.getuid?.() === 0) {
    fail('Refusing to install as root; run as the user who owns the agy OAuth credentials');
  }

  const defaults = platformDefaults();
  if (Object.hasOwn(process.env, 'AGYGRAM_INSTALL_ROOT') &&
      (!process.env.AGYGRAM_INSTALL_ROOT || !path.isAbsolute(process.env.AGYGRAM_INSTALL_ROOT))) {
    fail('AGYGRAM_INSTALL_ROOT must be a non-empty absolute path when set');
  }
  const requestedRoot = path.resolve(
    options.installRoot || process.env.AGYGRAM_INSTALL_ROOT || defaults.installRoot,
  );
  assertAbsoluteSafePath(requestedRoot, 'install root');
  const home = path.resolve(os.homedir());
  if (requestedRoot === home) fail('Install root cannot be the user home directory');
  for (const [name, externalPath] of [
    ...(options.envFile ? [['configuration', path.resolve(options.envFile)]] : []),
    ['data', defaults.dataDir],
    ['workspace', defaults.workspaceDir],
  ]) {
    if (pathsOverlap(requestedRoot, externalPath)) {
      fail(`Install root must not overlap the external ${name} path: ${externalPath}`);
    }
  }
  const installRoot = await claimInstallRoot(requestedRoot);
  const releaseLock = await acquireLock(installRoot);
  let pendingExternal = null;
  let pendingPrepared = null;
  let pendingInstalled = null;
  let pendingTarget = null;
  let completed = false;
  try {
    await recoverInterruptedTransaction(installRoot);
    const installed = await loadInstalledState(installRoot);
    pendingInstalled = installed;
    options.envFile ??= installed?.configFile || defaults.envFile;
    options.requireExistingConfig = Boolean(installed && options.envFile === installed.configFile);
    const selectedConfig = path.resolve(options.envFile);
    if (pathsOverlap(installRoot, selectedConfig)) {
      fail(`Install root must not overlap the selected configuration: ${selectedConfig}`);
    }
    try {
      const configInfo = await lstat(selectedConfig);
      if (!configInfo.isFile() || configInfo.isSymbolicLink() || configInfo.size > 1024 * 1024) {
        fail(`Existing configuration is not a safe regular file: ${selectedConfig}`);
      }
      const selectedValues = parseEnv(await readFile(selectedConfig, 'utf8'));
      const selectedEntries = [['managed install root', installRoot], ['configuration', selectedConfig]];
      for (const [key, name] of [['DATA_DIR', 'data'], ['WORKSPACE_DIR', 'workspace']]) {
        const configured = selectedValues.get(key);
        if (!configured) continue;
        if (!path.isAbsolute(configured)) {
          fail(`Existing ${key} must be absolute for a managed installation: ${configured}`);
        }
        selectedEntries.push([name, path.resolve(configured)]);
      }
      await assertNoPathOverlaps(selectedEntries);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const partialTarget = await resolveTarget(options);
    process.stdout.write(
      `Current: ${installed ? `${installed.version} (${installed.commit})` : 'not installed'}\n` +
      `Target:  ${partialTarget.version || 'from package'} (${partialTarget.commit})\n`,
    );

    if (partialTarget.version && installed) {
      const order = compareSemver(partialTarget.version, installed.version);
      if (order < 0 && !options.allowDowngrade) {
        fail(`Refusing downgrade from ${installed.version} to ${partialTarget.version}; pass --allow-downgrade to confirm`);
      }
      if (order === 0 && partialTarget.commit !== installed.commit) {
        fail(`Refusing to replace version ${installed.version} with a different commit`);
      }
    }

    let target = partialTarget;
    if (!target.version) {
      // Commit-only developer installs learn the immutable version from the candidate.
      const archive = await obtainArchive(options, target);
      const entries = parseTarGzip(archive.body);
      const packageEntry = entries.find((entry) => entry.relative === 'package.json');
      const packageJson = JSON.parse(packageEntry.body.toString('utf8'));
      if (packageJson.name !== PACKAGE_NAME || !SEMVER_RE.test(packageJson.version)) {
        fail('Commit archive contains an invalid package identity/version');
      }
      target = { ...target, version: packageJson.version, tag: null };
      if (installed) {
        const order = compareSemver(target.version, installed.version);
        if (order < 0 && !options.allowDowngrade) fail(`Refusing downgrade from ${installed.version} to ${target.version}`);
        if (order === 0 && target.commit !== installed.commit) fail(`Refusing same-version commit replacement for ${target.version}`);
      }
    }

    const prepared = await prepareRelease(installRoot, options, target);
    pendingPrepared = prepared;
    pendingTarget = target;
    const previousServiceActive = installed
      ? await invokeAgygram(
        path.join(installRoot, 'releases', installed.currentRelease),
        'status',
        externalFromManifest(installed),
        { allowFailure: true },
      )
      : false;
    const preservedDefaults = {
      ...defaults,
      dataDir: installed?.dataDir || defaults.dataDir,
      workspaceDir: installed?.workspaceDir || defaults.workspaceDir,
    };
    const external = await prepareExternalConfiguration(
      prepared.releaseDir,
      preservedDefaults,
      options,
      installRoot,
    );
    pendingExternal = external;
    for (const [name, externalPath] of [
      ['configuration', external.configFile],
      ['data', external.dataDir],
      ['workspace', external.workspaceDir],
    ]) {
      if (pathsOverlap(installRoot, externalPath)) fail(`Managed code overlaps external ${name}: ${externalPath}`);
    }
    const launcherPlan = await planLaunchers(installRoot);
    const launcher = launcherPlan.receipt;
    const wantService = !options.noService && external.incomplete.length === 0;
    if (external.incomplete.length > 0) {
      process.stdout.write(
        `Configuration requires ${external.incomplete.join(', ')}; native service will remain uninstalled.\n` +
        `Edit ${external.configFile}, then run the installer again.\n`,
      );
    }

    const same = installed?.version === target.version && installed?.commit === target.commit;
    const manifest = same
      ? await configureSameRelease(
        installRoot,
        installed,
        prepared,
        external,
        launcher,
        launcherPlan,
        wantService,
        previousServiceActive,
      )
      : await switchRelease(
        installRoot,
        installed,
        prepared,
        target,
        external,
        launcher,
        launcherPlan,
        wantService,
        previousServiceActive,
      );
    completed = true;
    const keep = new Set([manifest.currentRelease]);
    if (manifest.previousRelease) keep.add(manifest.previousRelease);
    await pruneReleases(installRoot, keep);
    process.stdout.write(
      `${same ? 'Already current' : 'Installed'}: ${manifest.version} (${manifest.commit})\n` +
      `Add to PATH: ${launcher.directory}\n` +
      `Config:   ${external.configFile}\n` +
      `Service:  ${manifest.serviceInstalled ? 'installed' : 'not installed'}\n`,
    );
    return 0;
  } finally {
    try {
      if (!completed && pendingExternal) await restoreExternalConfiguration(pendingExternal);
      if (!completed && pendingPrepared && !pendingPrepared.reused && pendingTarget) {
        await removeUnreferencedRollbackRelease(installRoot, {
          currentRelease: pendingPrepared.targetRelease,
          version: pendingTarget.version,
          commit: pendingTarget.commit,
        }, pendingInstalled);
      }
    } finally {
      await releaseLock();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`agygram install: ${error.message}\n`);
      process.exitCode = 1;
    });
}

export const _private = {
  parseOptions,
  parseSemver,
  compareSemver,
  platformDefaults,
  parseTarGzip,
  parseEnv,
  setEnvValue,
  validateReleaseName,
  releaseName,
  pathsOverlap,
  recoverInterruptedTransaction,
};

export { main };
