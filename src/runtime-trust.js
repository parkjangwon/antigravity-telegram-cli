import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function inspectTarget(target, { optional = false, directory = false } = {}) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (optional && isMissing(error)) return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Sensitive runtime path must not be a symlink: ${target}`);
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`Sensitive runtime path has the wrong type: ${target}`);
  }
  return info;
}

function assertTrustedOwner(info, target, uid) {
  if (Number.isSafeInteger(uid) && info.uid !== uid && info.uid !== 0) {
    throw new Error(`Sensitive runtime path has an untrusted owner uid ${info.uid}: ${target}`);
  }
}

function writableByAnotherPrincipal(info) {
  return !info.isSymbolicLink() && (info.mode & 0o022) !== 0;
}

function protectedStickyAncestor(info, targetExists) {
  return targetExists && info.isDirectory() && (info.mode & 0o1000) !== 0;
}

async function auditAncestorChain(start, { uid, targetExists }) {
  let current = path.resolve(start);
  let protectedChildExists = targetExists;
  while (true) {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (info) {
      assertTrustedOwner(info, current, uid);
      // A sticky temporary directory cannot replace an existing child owned
      // by this user. It is not safe for a missing secret file because another
      // user could create that name first.
      if (writableByAnotherPrincipal(info) && !protectedStickyAncestor(info, protectedChildExists)) {
        throw new Error(`Sensitive runtime ancestor is writable by another principal: ${current}`);
      }
      protectedChildExists = true;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function closestExistingRealPath(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing ancestor for sensitive path: ${target}`);
    current = parent;
  }
}

async function auditTarget(target, options) {
  const info = await inspectTarget(target, options);
  if (info) {
    assertTrustedOwner(info, target, options.uid);
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `Sensitive runtime path must deny group/other access (expected 0600/0700): ${target}`,
      );
    }
  }
  const targetExists = Boolean(info);
  await auditAncestorChain(target, { uid: options.uid, targetExists });
  const resolved = await closestExistingRealPath(target);
  if (resolved !== path.resolve(target)) {
    await auditAncestorChain(resolved, { uid: options.uid, targetExists });
  }
}

export async function assertRuntimeFilesystemTrust({
  envFile = path.resolve('.env'),
  dataDirectories = [],
  dataFiles = [],
  platform = process.platform,
  uid = process.getuid?.(),
  windowsAclVerified = false,
}) {
  if (platform === 'win32') {
    if (!windowsAclVerified) throw new Error('Windows runtime ACL verification is required');
    return { platform, attested: true };
  }
  if (!['darwin', 'linux'].includes(platform)) {
    throw new Error(`Unsupported runtime platform: ${platform}`);
  }
  await auditTarget(path.resolve(envFile), { optional: true, directory: false, uid });
  for (const target of dataDirectories) {
    await auditTarget(path.resolve(target), { optional: false, directory: true, uid });
  }
  for (const target of dataFiles) {
    await auditTarget(path.resolve(target), { optional: true, directory: false, uid });
  }
  return { platform, attested: false };
}

function isSameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function closestExistingPath(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      return { lexical: current, resolved: await realpath(current) };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing ancestor for managed path: ${target}`);
    current = parent;
  }
}

/**
 * Resolve every managed runtime location after creation so symlinks/junctions
 * cannot redirect state or cleanup operations outside the configured DATA_DIR.
 */
export async function assertManagedStorageBoundary({
  dataDir,
  files = [],
  directories = [],
}) {
  const root = await realpath(path.resolve(dataDir));
  for (const target of directories) {
    const absolute = path.resolve(target);
    let info = null;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error(`Managed runtime directory must be a real directory: ${absolute}`);
    }
    const resolved = info
      ? await realpath(absolute)
      : (await closestExistingPath(path.dirname(absolute))).resolved;
    if (!isSameOrDescendant(root, resolved)) {
      throw new Error(`Managed runtime directory escapes DATA_DIR: ${absolute}`);
    }
  }
  for (const target of files) {
    const absolute = path.resolve(target);
    let info = null;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new Error(`Managed runtime file must be a regular file: ${absolute}`);
    }
    const resolvedParent = (await closestExistingPath(path.dirname(absolute))).resolved;
    if (!isSameOrDescendant(root, resolvedParent)) {
      throw new Error(`Managed runtime file escapes DATA_DIR: ${absolute}`);
    }
  }
  return { dataDir: root };
}
