import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

// CreateProcessW accepts at most 32,767 UTF-16 code units including the NUL.
// Keep headroom for runtime differences in argv[0] handling.
export const WINDOWS_HARD_COMMAND_LINE_UNITS = 32_767;
export const DEFAULT_WINDOWS_SAFE_COMMAND_LINE_UNITS = 30_000;

const WINDOWS_NATIVE_EXTENSION = '.exe';
const WINDOWS_SHELL_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1']);

export class ProcessPlatformError extends Error {
  constructor(message, { code = 'PROCESS_PLATFORM_ERROR', cause } = {}) {
    super(message, { cause });
    this.name = 'ProcessPlatformError';
    this.code = code;
  }
}

function assertNoNul(value, label) {
  if (value.includes('\0')) {
    throw new ProcessPlatformError(`${label} contains a NUL character`, {
      code: 'INVALID_PROCESS_ARGUMENT',
    });
  }
}

function normalizeArguments(args) {
  if (!Array.isArray(args)) {
    throw new ProcessPlatformError('process arguments must be an array', {
      code: 'INVALID_PROCESS_ARGUMENT',
    });
  }

  return args.map((argument, index) => {
    if (typeof argument !== 'string') {
      throw new ProcessPlatformError(`process argument ${index} must be a string`, {
        code: 'INVALID_PROCESS_ARGUMENT',
      });
    }
    assertNoNul(argument, `process argument ${index}`);
    return argument;
  });
}

// This is the quoting algorithm used by the common Windows C argv parser when
// Node's windowsVerbatimArguments option is left at its safe default (false).
export function quoteWindowsArgument(value) {
  const argument = String(value);
  assertNoNul(argument, 'Windows process argument');
  if (argument && !/[\s"]/u.test(argument)) return argument;

  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += '\\'.repeat(backslashes) + character;
    }
    backslashes = 0;
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
}

export function estimateWindowsCommandLineUnits(command, args = []) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new ProcessPlatformError('process command must be a non-empty string', {
      code: 'INVALID_PROCESS_COMMAND',
    });
  }
  assertNoNul(command, 'process command');
  const normalizedArgs = normalizeArguments(args);

  // JavaScript string length is UTF-16 code units. The extra unit is the NUL
  // included in CreateProcessW's documented limit.
  return [command, ...normalizedArgs].map(quoteWindowsArgument).join(' ').length + 1;
}

export function assertWindowsCommandLineSupported(
  command,
  args = [],
  {
    platform = process.platform,
    maxUnits = DEFAULT_WINDOWS_SAFE_COMMAND_LINE_UNITS,
  } = {},
) {
  if (platform !== 'win32') return null;
  if (!Number.isSafeInteger(maxUnits) || maxUnits < 1 || maxUnits > WINDOWS_HARD_COMMAND_LINE_UNITS) {
    throw new ProcessPlatformError(
      `Windows command-line limit must be an integer between 1 and ${WINDOWS_HARD_COMMAND_LINE_UNITS}`,
      { code: 'INVALID_WINDOWS_COMMAND_LINE_LIMIT' },
    );
  }

  const units = estimateWindowsCommandLineUnits(command, args);
  if (units > maxUnits) {
    // Deliberately omit argv contents: the final argument is commonly a secret
    // or user prompt and must not be copied into logs.
    throw new ProcessPlatformError(
      `process command exceeds the safe Windows command-line limit (${units} UTF-16 units; limit ${maxUnits})`,
      { code: 'WINDOWS_COMMAND_LINE_LIMIT' },
    );
  }
  return { units, maxUnits };
}

function environmentValue(env, name, { caseInsensitive = false } = {}) {
  if (!env || typeof env !== 'object') return undefined;
  if (!caseInsensitive) return env[name];

  const matching = Object.keys(env).filter((key) => key.toLowerCase() === name.toLowerCase());
  if (matching.length === 0) return undefined;
  const values = new Set(matching.map((key) => String(env[key])));
  if (values.size > 1) {
    throw new ProcessPlatformError(`environment contains conflicting ${name} keys`, {
      code: 'AMBIGUOUS_PROCESS_ENVIRONMENT',
    });
  }
  return env[matching.sort()[0]];
}

function pathImplementation(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isFullyQualifiedPath(value, platform, pathApi) {
  if (!pathApi.isAbsolute(value)) return false;
  if (platform !== 'win32') return true;
  // `\foo` is rooted but still depends on the process's ambient current drive.
  return /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(value);
}

function hasPathComponent(command, platform, pathApi) {
  if (pathApi.isAbsolute(command)) return true;
  if (platform === 'win32') {
    return command.includes('\\') || command.includes('/') || pathApi.parse(command).root !== '';
  }
  return command.includes('/');
}

function searchDirectories({ env, cwd, platform, pathApi }) {
  const pathValue = environmentValue(env, 'PATH', { caseInsensitive: platform === 'win32' });
  if (typeof pathValue !== 'string' || pathValue.length === 0) return [];

  return pathValue.split(pathApi.delimiter).map((entry) => {
    // Quotes are not part of an executable directory. POSIX whitespace is a
    // valid filename character, so never trim it into a different directory.
    const unquoted = platform === 'win32' && /^".*"$/u.test(entry)
      ? entry.slice(1, -1)
      : entry;
    if (!unquoted || !isFullyQualifiedPath(unquoted, platform, pathApi)) {
      throw new ProcessPlatformError(
        'PATH must contain only non-empty absolute directories; relative and current-directory entries are unsafe',
        { code: 'UNSAFE_PROCESS_PATH' },
      );
    }
    return pathApi.normalize(unquoted);
  });
}

function normalizeChildEnvironment(env, { platform, cwd, pathApi }) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new ProcessPlatformError('process environment must be an object', {
      code: 'INVALID_PROCESS_ENVIRONMENT',
    });
  }

  const normalized = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name || name.includes('\0') || name.includes('=')) {
      throw new ProcessPlatformError('process environment contains an invalid variable name', {
        code: 'INVALID_PROCESS_ENVIRONMENT',
      });
    }
    if (value == null) continue;
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new ProcessPlatformError(`process environment variable ${name} must be a NUL-free string`, {
        code: 'INVALID_PROCESS_ENVIRONMENT',
      });
    }
    normalized[name] = value;
  }

  const pathValue = environmentValue(normalized, 'PATH', { caseInsensitive: platform === 'win32' });
  if (pathValue !== undefined) {
    const safeDirectories = searchDirectories({ env: normalized, cwd, platform, pathApi });
    if (platform === 'win32') {
      for (const name of Object.keys(normalized)) {
        if (name.toLowerCase() === 'path') delete normalized[name];
      }
      normalized.PATH = safeDirectories.join(pathApi.delimiter);
    } else {
      normalized.PATH = safeDirectories.join(pathApi.delimiter);
    }
  }
  return Object.freeze(normalized);
}

async function defaultFileProbe(candidate, { platform }) {
  try {
    const details = await stat(candidate);
    if (!details.isFile()) return false;
    if (platform !== 'win32') await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstAvailable(candidates, probeFile, platform) {
  for (const candidate of candidates) {
    if (await probeFile(candidate, { platform })) return candidate;
  }
  return null;
}

function windowsCandidateNames(command, pathApi) {
  const extension = pathApi.extname(command).toLowerCase();
  if (WINDOWS_SHELL_EXTENSIONS.has(extension)) {
    throw new ProcessPlatformError(
      'Windows .cmd, .bat, and .ps1 launchers require a command shell and are not accepted; configure the native agy.exe path',
      { code: 'WINDOWS_SHELL_SHIM_UNSUPPORTED' },
    );
  }
  if (extension && extension !== WINDOWS_NATIVE_EXTENSION) {
    throw new ProcessPlatformError(
      `Windows process command must resolve to a native ${WINDOWS_NATIVE_EXTENSION} executable`,
      { code: 'WINDOWS_NON_NATIVE_EXECUTABLE' },
    );
  }
  return extension === WINDOWS_NATIVE_EXTENSION ? [command] : [`${command}${WINDOWS_NATIVE_EXTENSION}`];
}

/**
 * Resolve a process executable without invoking a shell.
 *
 * On Windows only native .exe files are accepted. Batch/PowerShell/npm .cmd
 * shims are intentionally rejected because cmd.exe ultimately receives one
 * command-line string; safely supporting arbitrary shims would require parsing
 * and trusting their shell program. The native Antigravity Windows executable
 * should be selected via PATH or an explicit AGY_BIN path instead.
 *
 * `probeFile` is injectable so all platform policies can be unit-tested on one
 * host. Its signature is `(absoluteCandidate, { platform }) => Promise<boolean>`.
 */
export async function resolveProcessExecutable(
  command,
  {
    platform = process.platform,
    env = process.env,
    cwd = process.cwd(),
    probeFile = defaultFileProbe,
  } = {},
) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new ProcessPlatformError('process command must be a non-empty string', {
      code: 'INVALID_PROCESS_COMMAND',
    });
  }
  assertNoNul(command, 'process command');
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    throw new ProcessPlatformError(`unsupported process platform: ${platform}`, {
      code: 'UNSUPPORTED_PROCESS_PLATFORM',
    });
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new ProcessPlatformError('process cwd must be a non-empty string', {
      code: 'INVALID_PROCESS_CWD',
    });
  }
  assertNoNul(cwd, 'process cwd');

  const pathApi = pathImplementation(platform);
  if (!isFullyQualifiedPath(cwd, platform, pathApi)) {
    throw new ProcessPlatformError('process cwd must be a fully qualified absolute path', {
      code: 'INVALID_PROCESS_CWD',
    });
  }
  if (platform === 'win32' && /^[a-z]:[^\\/]/iu.test(command)) {
    throw new ProcessPlatformError('drive-relative Windows process commands are not allowed', {
      code: 'INVALID_PROCESS_COMMAND',
    });
  }
  const explicit = hasPathComponent(command, platform, pathApi);
  const names = platform === 'win32' ? windowsCandidateNames(command, pathApi) : [command];
  const directories = explicit
    ? [cwd]
    : searchDirectories({ env, cwd, platform, pathApi });
  const candidates = explicit
    ? names.map((name) => pathApi.resolve(cwd, name))
    : directories.flatMap((directory) => names.map((name) => pathApi.resolve(directory, name)));

  const resolvedPath = await firstAvailable(candidates, probeFile, platform);
  if (resolvedPath) {
    return {
      requested: command,
      path: resolvedPath,
      source: explicit ? 'explicit' : 'PATH',
      platform,
    };
  }

  if (platform === 'win32' && pathApi.extname(command) === '') {
    const shellNames = [`${command}.cmd`, `${command}.bat`, `${command}.ps1`];
    const shellCandidates = explicit
      ? shellNames.map((name) => pathApi.resolve(cwd, name))
      : directories.flatMap((directory) => shellNames.map((name) => pathApi.resolve(directory, name)));
    if (await firstAvailable(shellCandidates, probeFile, platform)) {
      throw new ProcessPlatformError(
        'only a shell-based Windows launcher was found; install or configure the native agy.exe executable',
        { code: 'WINDOWS_SHELL_SHIM_UNSUPPORTED' },
      );
    }
  }

  throw new ProcessPlatformError(`process executable not found: ${command}`, {
    code: 'PROCESS_EXECUTABLE_NOT_FOUND',
  });
}

/**
 * Build the exact values to pass to child_process.spawn(). The returned spec
 * always disables shells and Windows verbatim argument handling.
 */
export async function createSafeSpawnSpec(
  command,
  args = [],
  {
    platform = process.platform,
    env = {},
    cwd = process.cwd(),
    probeFile,
    maxWindowsUnits = DEFAULT_WINDOWS_SAFE_COMMAND_LINE_UNITS,
  } = {},
) {
  const normalizedArgs = normalizeArguments(args);
  const pathApi = pathImplementation(platform);
  if (typeof cwd !== 'string' || !isFullyQualifiedPath(cwd, platform, pathApi)) {
    throw new ProcessPlatformError('process cwd must be a fully qualified absolute path', {
      code: 'INVALID_PROCESS_CWD',
    });
  }
  assertNoNul(cwd, 'process cwd');
  const childEnvironment = normalizeChildEnvironment(env, { platform, cwd, pathApi });
  const resolution = await resolveProcessExecutable(command, {
    platform,
    env: childEnvironment,
    cwd,
    ...(probeFile ? { probeFile } : {}),
  });
  const commandLine = assertWindowsCommandLineSupported(resolution.path, normalizedArgs, {
    platform,
    maxUnits: maxWindowsUnits,
  });

  return {
    command: resolution.path,
    args: normalizedArgs,
    options: Object.freeze({
      cwd,
      env: childEnvironment,
      shell: false,
      windowsHide: platform === 'win32',
      windowsVerbatimArguments: false,
    }),
    resolution,
    commandLine,
  };
}
