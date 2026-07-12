import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function prepareWorkspaces(defaultWorkspace, allowedRoots) {
  await mkdir(defaultWorkspace, { recursive: true, mode: 0o700 });
  const roots = [];
  for (const root of allowedRoots) {
    try {
      const info = await stat(root);
      if (!info.isDirectory()) throw new Error(`${root} is not a directory`);
      roots.push(await realpath(root));
    } catch (error) {
      if (path.resolve(root) === path.resolve(defaultWorkspace)) throw error;
      console.warn(`Ignoring unavailable ALLOWED_WORKSPACE_ROOTS entry: ${root}`);
    }
  }
  return [...new Set(roots)];
}

export async function resolveWorkspace(requested, { defaultWorkspace, allowedRoots }) {
  const candidate = requested
    ? path.resolve(defaultWorkspace, requested)
    : path.resolve(defaultWorkspace);
  let resolved;
  try {
    const info = await stat(candidate);
    if (!info.isDirectory()) throw new Error('The workspace path is not a directory');
    resolved = await realpath(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Workspace directory does not exist');
    throw error;
  }

  if (!allowedRoots.some((root) => isInside(root, resolved))) {
    throw new Error('Workspace is outside ALLOWED_WORKSPACE_ROOTS');
  }
  return resolved;
}

export const _private = { isInside };
