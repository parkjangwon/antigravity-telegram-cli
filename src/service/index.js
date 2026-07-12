import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  lstat,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsTaskControlScript,
  buildWindowsTaskXml,
  LAUNCHD_LABEL,
  SERVICE_NAME,
  WINDOWS_TASK_NAME,
  platformPath,
} from './templates.js';
import { buildServiceRuntimePaths, resolveServiceDataDir } from './runtime-paths.js';

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const POSIX_MANAGER_PREVIEW_PATHS = Object.freeze({
  darwin: Object.freeze({ launchctl: '/bin/launchctl' }),
  linux: Object.freeze({
    systemctl: '/usr/bin/systemctl',
    loginctl: '/usr/bin/loginctl',
  }),
});

async function auditPosixRuntimeTree(root, { uid, trustedGroups, skipBinLinks = false }) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      if (skipBinLinks && path.basename(path.dirname(current)) === '.bin') continue;
      throw new Error(`service runtime code must not be a symlink: ${current}`);
    }
    if (info.uid !== 0 && info.uid !== uid) {
      throw new Error(`service runtime code has an untrusted uid (${info.uid}): ${current}`);
    }
    if ((info.mode & 0o002) !== 0) {
      throw new Error(`service runtime code is writable by other users: ${current}`);
    }
    if ((info.mode & 0o020) !== 0 && !trustedGroups.has(info.gid)) {
      throw new Error(
        `service runtime code is group-writable by untrusted gid ${info.gid}: ${current}`,
      );
    }
    if (info.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (skipBinLinks && current === root && entry.name === '.bin') continue;
        pending.push(path.join(current, entry.name));
      }
    } else if (!info.isFile()) {
      throw new Error(`service runtime code has an unsupported file type: ${current}`);
    }
  }
}

function assertAbsolute(targetPath, pathApi, name) {
  const isAbsolute = pathApi.sep === '\\'
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(targetPath)
    : pathApi.isAbsolute(targetPath);
  if (!isAbsolute) {
    throw new Error(`${name} must be an absolute path: ${targetPath}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(targetPath)) {
    throw new Error(`${name} cannot contain control characters`);
  }
}

function currentWindowsUser(env) {
  const username = env.USERNAME?.trim();
  const domain = env.USERDOMAIN?.trim();
  if (!username) {
    throw new Error('USERNAME is unavailable; cannot bind the task to the current Windows user');
  }
  return domain ? `${domain}\\${username}` : username;
}

function command(file, args, options = {}) {
  return { type: 'command', file, args, ...options };
}

async function auditPosixServicePaths(plan) {
  if (!['darwin', 'linux'].includes(plan.platform)) return;
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) return;
  const checks = [
    ['project directory', plan.projectDir, true],
    ['Node executable', plan.nodePath, true],
    ...(plan.agyBin ? [['agy executable', plan.agyBin, true]] : []),
    ['service entry', plan.entryPath, true],
    ...Object.entries(plan.managerExecutables || {})
      .filter(([, executable]) => Boolean(executable))
      .map(([name, executable]) => [`${name} executable`, executable, true]),
    ...String(plan.managerSearchPath || plan.environmentPath || '')
      .split(':')
      .filter(Boolean)
      .map((entry) => ['PATH directory', entry, false]),
    ...(plan.definitionPath
      ? [['service definition directory', path.dirname(plan.definitionPath), false]]
      : []),
  ];

  const trustedGroups = new Set([...(plan.trustedGroupGids || [])].map(Number));
  for (const [kind, target, mustExist] of checks) {
    const original = path.resolve(target);
    let lexicalStart = original;
    let resolved;
    try {
      resolved = await realpath(original);
    } catch (error) {
      if (mustExist || error.code !== 'ENOENT') throw error;
      while (true) {
        const parent = path.dirname(lexicalStart);
        if (parent === lexicalStart) throw error;
        lexicalStart = parent;
        try {
          resolved = await realpath(lexicalStart);
          break;
        } catch (parentError) {
          if (parentError.code !== 'ENOENT') throw parentError;
        }
      }
    }
    for (const start of new Set([lexicalStart, resolved])) {
      let current = start;
      while (true) {
        const info = await lstat(current);
        const protectedDarwinCryptex = plan.platform === 'darwin'
          && (
            current === '/System/Volumes/Preboot/Cryptexes'
            || current.startsWith('/System/Volumes/Preboot/Cryptexes/')
          )
          && info.uid === 0;
        if (info.uid !== 0 && info.uid !== uid) {
          throw new Error(`${kind} path is owned by an untrusted uid (${info.uid}): ${current}`);
        }
        // A symlink's apparent 0777 mode is not an access grant; its parent
        // directory controls replacement. Both original and resolved chains
        // are audited, so only regular path components use write-bit checks.
        if (!protectedDarwinCryptex && !info.isSymbolicLink() && (info.mode & 0o002) !== 0) {
          throw new Error(`${kind} path is writable by other users: ${current}`);
        }
        if (
          !protectedDarwinCryptex &&
          !info.isSymbolicLink() &&
          (info.mode & 0o020) !== 0 &&
          !trustedGroups.has(info.gid)
        ) {
          throw new Error(
            `${kind} path is group-writable by untrusted gid ${info.gid}: ${current}; ` +
              'add it to TRUSTED_SERVICE_GROUP_GIDS only after reviewing membership',
          );
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }

  // The doctor and service entry import the rest of src plus installed npm
  // dependencies. Auditing only the first JavaScript file would still allow a
  // group-writable imported module to execute before the service starts.
  await auditPosixRuntimeTree(path.join(plan.projectDir, 'src'), { uid, trustedGroups });
  await auditPosixRuntimeTree(path.join(plan.projectDir, 'node_modules'), {
    uid,
    trustedGroups,
    skipBinLinks: true,
  });
  await auditPosixRuntimeTree(path.join(plan.projectDir, 'package.json'), {
    uid,
    trustedGroups,
  });
}

function normalizeServicePath(value, platform, { allowDefault = true } = {}) {
  const pathApi = platformPath(platform);
  const delimiter = platform === 'win32' ? ';' : ':';
  const fallback = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  if (value == null && !allowDefault) {
    throw new Error('PATH is unavailable; service manager executables cannot be resolved safely');
  }
  const entries = String(value == null ? fallback.join(delimiter) : value).split(delimiter);
  const isAbsolute = (entry) => platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(entry)
    : pathApi.isAbsolute(entry);
  if (entries.some((entry) => !entry || !isAbsolute(entry))) {
    throw new Error('PATH must contain only non-empty absolute directories for service installation');
  }
  return [...new Set(entries)].join(delimiter);
}

function resolvePosixManagerExecutable(name, managerSearchPath, platform, {
  required = true,
  structuralPreview = false,
} = {}) {
  if (!['darwin', 'linux'].includes(platform)) {
    throw new Error(`Cannot resolve POSIX service manager on ${platform}`);
  }
  if (structuralPreview) return POSIX_MANAGER_PREVIEW_PATHS[platform][name];

  for (const directory of managerSearchPath.split(':')) {
    const candidate = path.posix.join(directory, name);
    try {
      const resolved = realpathSync(candidate);
      if (!path.posix.isAbsolute(resolved) || !statSync(resolved).isFile()) continue;
      accessSync(resolved, constants.X_OK);
      return resolved;
    } catch {
      // Match executable lookup semantics: unusable candidates do not shadow
      // a valid executable in a later, already-normalized PATH directory.
    }
  }

  if (!required) return undefined;
  throw new Error(`${name} was not found as an executable in the normalized service PATH`);
}

export function buildServicePlan(action, options = {}) {
  if (!['install', 'uninstall', 'status'].includes(action)) {
    throw new Error(`Unknown service action: ${action}`);
  }

  const platform = options.platform ?? process.platform;
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported operating system: ${platform}`);
  }

  const pathApi = platformPath(platform);
  const projectDir = options.projectDir;
  const nodePath = options.nodePath ?? process.execPath;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  assertAbsolute(projectDir, pathApi, 'projectDir');
  assertAbsolute(nodePath, pathApi, 'nodePath');
  if (options.agyBin) assertAbsolute(options.agyBin, pathApi, 'agyBin');
  if (platform !== 'win32') assertAbsolute(homeDir, pathApi, 'homeDir');
  const dataDir = resolveServiceDataDir({
    projectDir,
    configuredDataDir: options.dataDir,
    env,
    platform,
  });
  assertAbsolute(dataDir, pathApi, 'dataDir');
  const runtimePaths = buildServiceRuntimePaths(dataDir, platform);

  // Task Scheduler has no useful output sink and launchd file redirection has
  // no rotation. A tiny bootstrap supplies bounded logs on those platforms.
  const entryPath = platform === 'linux'
    ? pathApi.join(projectDir, 'src', 'index.js')
    : pathApi.join(projectDir, 'src', 'service', 'file-runner.js');
  const operations = [];
  const warnings = [];
  const structuralPreview = Boolean(options.previewNote) || platform !== process.platform;
  const sourceEnvironmentPath = options.environmentPath ??
    (structuralPreview ? undefined : env.PATH);
  const managerSearchPath = platform === 'win32'
    ? undefined
    : normalizeServicePath(sourceEnvironmentPath, platform, {
      allowDefault: structuralPreview,
    });
  const environmentPath = action !== 'install'
    ? undefined
    : platform === 'win32'
      ? (options.environmentPath == null
        ? undefined
        : normalizeServicePath(options.environmentPath, platform))
      : managerSearchPath;
  const managerExecutables = {};
  if (platform === 'darwin') {
    managerExecutables.launchctl = resolvePosixManagerExecutable(
      'launchctl',
      managerSearchPath,
      platform,
      { structuralPreview },
    );
  } else if (platform === 'linux') {
    managerExecutables.systemctl = resolvePosixManagerExecutable(
      'systemctl',
      managerSearchPath,
      platform,
      { structuralPreview },
    );
    if (action === 'install' && options.enableLinger !== false) {
      managerExecutables.loginctl = resolvePosixManagerExecutable(
        'loginctl',
        managerSearchPath,
        platform,
        { required: false, structuralPreview },
      );
      if (!managerExecutables.loginctl) {
        warnings.push(
          'loginctl was not found in the normalized service PATH; optional linger setup was skipped',
        );
      }
    }
  }
  let definitionPath;
  let definition;
  let definitionEncoding = 'utf8';

  if (platform === 'darwin') {
    const uid = options.uid ?? process.getuid?.();
    if (!Number.isSafeInteger(uid) || uid < 0) {
      throw new Error('Unable to determine the macOS user ID for launchctl');
    }
    const domain = `gui/${uid}`;
    const logDir = pathApi.dirname(runtimePaths.logPath);
    definitionPath = pathApi.join(homeDir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    if (action === 'install') {
      definition = buildLaunchdPlist({
        nodePath,
        entryPath,
        entryArguments: ['--data-dir', dataDir],
        projectDir,
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
        environmentPath,
      });
      operations.push(
        { type: 'mkdir', path: pathApi.dirname(definitionPath) },
        { type: 'mkdir', path: logDir },
        command(managerExecutables.launchctl, ['bootout', `${domain}/${LAUNCHD_LABEL}`], {
          allowFailure: true,
        }),
        { type: 'write', path: definitionPath, content: definition, encoding: definitionEncoding },
        command(managerExecutables.launchctl, ['enable', `${domain}/${LAUNCHD_LABEL}`]),
        command(managerExecutables.launchctl, ['bootstrap', domain, definitionPath]),
        command(managerExecutables.launchctl, ['kickstart', '-k', `${domain}/${LAUNCHD_LABEL}`]),
        { type: 'delay', milliseconds: 1_000 },
        command(managerExecutables.launchctl, ['print', `${domain}/${LAUNCHD_LABEL}`]),
      );
    } else if (action === 'uninstall') {
      operations.push(
        command(managerExecutables.launchctl, ['bootout', `${domain}/${LAUNCHD_LABEL}`]),
        { type: 'remove', path: definitionPath },
      );
    } else {
      operations.push(command(managerExecutables.launchctl, [
        'print',
        `${domain}/${LAUNCHD_LABEL}`,
      ]));
    }
  } else if (platform === 'linux') {
    const configHome = options.xdgConfigHome || env.XDG_CONFIG_HOME
      ? options.xdgConfigHome || env.XDG_CONFIG_HOME
      : pathApi.join(homeDir, '.config');
    assertAbsolute(configHome, pathApi, 'XDG_CONFIG_HOME');
    definitionPath = pathApi.join(configHome, 'systemd', 'user', `${SERVICE_NAME}.service`);
    if (action === 'install') {
      definition = buildSystemdUnit({
        nodePath,
        entryPath,
        entryArguments: ['--data-dir', dataDir],
        projectDir,
        environmentPath,
      });
      operations.push(
        { type: 'mkdir', path: pathApi.dirname(definitionPath) },
        { type: 'write', path: definitionPath, content: definition, encoding: definitionEncoding },
        ...(options.enableLinger === false
          ? []
          : managerExecutables.loginctl
            ? [command(managerExecutables.loginctl, ['enable-linger'], { allowFailure: true })]
            : []),
        command(managerExecutables.systemctl, ['--user', 'daemon-reload']),
        command(managerExecutables.systemctl, ['--user', 'enable', `${SERVICE_NAME}.service`]),
        command(managerExecutables.systemctl, ['--user', 'restart', `${SERVICE_NAME}.service`]),
        { type: 'delay', milliseconds: 1_000 },
        command(managerExecutables.systemctl, [
          '--user',
          'is-active',
          '--quiet',
          `${SERVICE_NAME}.service`,
        ]),
      );
    } else if (action === 'uninstall') {
      operations.push(
        command(managerExecutables.systemctl, [
          '--user',
          'disable',
          '--now',
          `${SERVICE_NAME}.service`,
        ]),
        { type: 'remove', path: definitionPath },
        command(managerExecutables.systemctl, ['--user', 'daemon-reload']),
        command(managerExecutables.systemctl, [
          '--user',
          'reset-failed',
          `${SERVICE_NAME}.service`,
        ], {
          allowFailure: true,
        }),
      );
    } else {
      operations.push(command(managerExecutables.systemctl, [
        '--user',
        'status',
        `${SERVICE_NAME}.service`,
        '--no-pager',
        '--full',
      ]));
    }
  } else {
    const configuredSystemRoot = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows';
    assertAbsolute(configuredSystemRoot, pathApi, 'SystemRoot');
    const systemDirectory = pathApi.join(configuredSystemRoot, 'System32');
    const schtasksPath = pathApi.join(systemDirectory, 'schtasks.exe');
    const taskkillPath = pathApi.join(systemDirectory, 'taskkill.exe');
    const powershellPath = pathApi.join(
      systemDirectory,
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const windowsCommandEnv = {
      SystemRoot: configuredSystemRoot,
      WINDIR: configuredSystemRoot,
      PATH: systemDirectory,
    };
    const runtimeEnvironmentPath = runtimePaths.environmentPath;
    const controlScriptPath = runtimePaths.controlScriptPath;
    const stopRequestPath = runtimePaths.stopRequestPath;
    const lockPath = pathApi.join(dataDir, 'bot.lock');
    definitionPath = runtimePaths.definitionPath;
    definitionEncoding = 'utf16le';
    if (action === 'install') {
      for (const [name, value] of Object.entries({
        nodePath,
        entryPath,
        projectDir,
        dataDir,
        definitionPath,
        controlScriptPath,
        runtimeEnvironmentPath,
        stopRequestPath,
        lockPath,
      })) {
        if (value.length > 260) {
          throw new Error(`${name} exceeds the Windows Task Scheduler 260-character path limit`);
        }
      }
      const userId = options.windowsUserId ?? currentWindowsUser(env);
      definition = buildWindowsTaskXml({
        nodePath,
        entryPath,
        entryArguments: ['--data-dir', dataDir],
        projectDir,
        userId,
      });
      operations.push(
        { type: 'mkdir', path: runtimePaths.serviceDir },
        {
          type: 'write',
          path: controlScriptPath,
          content: buildWindowsTaskControlScript(),
          encoding: 'utf8',
        },
        command(powershellPath, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          controlScriptPath,
          '-Action',
          'Stop',
          '-StopRequestPath',
          stopRequestPath,
          '-LockPath',
          lockPath,
          '-TaskkillPath',
          taskkillPath,
        ], { env: windowsCommandEnv }),
        { type: 'remove', path: stopRequestPath },
        ...(environmentPath
          ? [{
            type: 'write',
            path: runtimeEnvironmentPath,
            content: `${JSON.stringify({ NODE_ENV: 'production', PATH: environmentPath }, null, 2)}\n`,
            encoding: 'utf8',
          }]
          : []),
        {
          type: 'write',
          path: definitionPath,
          content: definition,
          encoding: definitionEncoding,
          bom: true,
        },
        command(schtasksPath, ['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', definitionPath, '/F'], { env: windowsCommandEnv }),
        command(schtasksPath, ['/Run', '/TN', WINDOWS_TASK_NAME], { env: windowsCommandEnv }),
        command(powershellPath, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          controlScriptPath,
          '-Action',
          'Check',
        ], { env: windowsCommandEnv }),
      );
    } else if (action === 'uninstall') {
      operations.push(
        { type: 'mkdir', path: runtimePaths.serviceDir },
        {
          type: 'write',
          path: controlScriptPath,
          content: buildWindowsTaskControlScript(),
          encoding: 'utf8',
        },
        command(powershellPath, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          controlScriptPath,
          '-Action',
          'Remove',
          '-StopRequestPath',
          stopRequestPath,
          '-LockPath',
          lockPath,
          '-TaskkillPath',
          taskkillPath,
        ], { env: windowsCommandEnv }),
        { type: 'remove', path: stopRequestPath },
        { type: 'remove', path: definitionPath },
        { type: 'remove', path: runtimeEnvironmentPath },
        { type: 'remove', path: controlScriptPath },
      );
    } else {
      operations.push(command(schtasksPath, [
        '/Query',
        '/TN',
        WINDOWS_TASK_NAME,
        '/V',
        '/FO',
        'LIST',
      ], { env: windowsCommandEnv }));
    }
  }

  return {
    action,
    platform,
    projectDir,
    dataDir,
    nodePath,
    entryPath,
    agyBin: options.agyBin,
    definitionPath,
    definition: action === 'install' ? definition : undefined,
    definitionEncoding,
    environmentPath,
    managerSearchPath,
    managerExecutables,
    trustedGroupGids: options.trustedGroupGids || [],
    previewNote: options.previewNote,
    warnings,
    operations,
  };
}

function printableArg(value) {
  if (/^[A-Za-z0-9_./:@=+,-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}

export function formatServicePlan(plan) {
  const lines = [
    `platform: ${plan.platform}`,
    `action: ${plan.action}`,
    `project: ${plan.projectDir}`,
    `data: ${plan.dataDir}`,
  ];
  if (plan.definitionPath) lines.push(`definition: ${plan.definitionPath}`);
  if (plan.previewNote) lines.push(`note: ${plan.previewNote}`);
  for (const warning of plan.warnings || []) lines.push(`warning: ${warning}`);
  if (plan.definition) lines.push('', '--- definition ---', plan.definition.trimEnd());
  lines.push('', '--- operations ---');
  for (const operation of plan.operations) {
    if (operation.type === 'command') {
      lines.push(`$ ${[operation.file, ...operation.args].map(printableArg).join(' ')}`);
    } else if (operation.type === 'write') {
      lines.push(`write ${operation.path} (${operation.encoding}${operation.bom ? ', BOM' : ''})`);
    } else if (operation.type === 'delay') {
      lines.push(`wait ${operation.milliseconds}ms`);
    } else {
      lines.push(`${operation.type} ${operation.path}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function atomicWrite(operation) {
  const temporary = `${operation.path}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    const body = operation.encoding === 'utf16le'
      ? Buffer.from(`${operation.bom ? '\ufeff' : ''}${operation.content}`, 'utf16le')
      : operation.content;
    await handle.writeFile(body, operation.encoding === 'utf16le' ? undefined : operation.encoding);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, operation.path);
    if (process.platform !== 'win32') await chmod(operation.path, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function spawnCommand(file, args, {
  stdio = 'inherit',
  timeoutMs = 120_000,
  env,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('command timeoutMs must be a positive integer');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio,
      windowsHide: true,
      shell: false,
      ...(env ? { env } : {}),
    });
    let timedOut = false;
    let settled = false;
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (timedOut) {
        reject(new Error(`${file} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) resolve({ code, signal });
      else {
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        reject(new Error(`${file} failed with ${reason}`));
      }
    });
  });
}

export async function executeServicePlan(plan, options = {}) {
  const runner = options.runner ?? spawnCommand;
  for (const operation of plan.operations) {
    if (operation.type === 'mkdir') {
      await mkdir(operation.path, { recursive: true, mode: 0o700 });
    } else if (operation.type === 'write') {
      await atomicWrite(operation);
    } else if (operation.type === 'remove') {
      await rm(operation.path, { force: true });
    } else if (operation.type === 'command') {
      try {
        await runner(operation.file, operation.args, {
          stdio: 'inherit',
          ...(operation.timeoutMs ? { timeoutMs: operation.timeoutMs } : {}),
          ...(operation.env ? { env: operation.env } : {}),
        });
      } catch (error) {
        if (!operation.allowFailure) throw error;
        options.onWarning?.(`${error.message} (continuing)`);
      }
    } else if (operation.type === 'delay') {
      await new Promise((resolve) => setTimeout(resolve, operation.milliseconds));
    } else {
      throw new Error(`Unknown service operation: ${operation.type}`);
    }
  }
}

export async function manageService(action, options = {}) {
  const requestedPlatform = options.platform ?? process.platform;
  const buildOptions = !options.dryRun &&
    requestedPlatform === process.platform &&
    options.environmentPath == null
    ? { ...options, environmentPath: process.env.PATH }
    : options;
  const plan = buildServicePlan(action, buildOptions);
  if (options.dryRun) {
    (options.output ?? process.stdout.write.bind(process.stdout))(formatServicePlan(plan));
    return plan;
  }

  if (options.platform && options.platform !== process.platform) {
    throw new Error('--platform may only override the current OS together with --dry-run');
  }
  if (options.homeDir != null || options.uid != null || options.windowsUserId != null) {
    throw new Error('service identity overrides may only be used together with --dry-run');
  }
  if (action === 'install') await access(plan.entryPath, constants.R_OK);
  const onWarning = options.onWarning ?? ((message) => process.stderr.write(`warning: ${message}\n`));
  for (const warning of plan.warnings) onWarning(warning);
  if (action === 'install') await auditPosixServicePaths(plan, onWarning);
  await executeServicePlan(plan, {
    runner: options.runner,
    onWarning,
  });
  return plan;
}

/**
 * Validate a native install plan without writing files or executing the
 * configured Node/agy binaries. The CLI runs this before its doctor child.
 */
export async function preflightServiceInstall(options = {}) {
  const requestedPlatform = options.platform ?? process.platform;
  if (requestedPlatform !== process.platform) {
    throw new Error('native service preflight cannot target another operating system');
  }
  if (options.homeDir != null || options.uid != null || options.windowsUserId != null) {
    throw new Error('service identity overrides are not allowed for native preflight');
  }
  const buildOptions = options.environmentPath == null
    ? { ...options, environmentPath: process.env.PATH }
    : options;
  const plan = buildServicePlan('install', buildOptions);
  await access(plan.entryPath, constants.R_OK);
  await auditPosixServicePaths(plan);
  return plan;
}

export const _private = {
  assertAbsolute,
  currentWindowsUser,
  atomicWrite,
  printableArg,
  normalizeServicePath,
  resolvePosixManagerExecutable,
  auditPosixServicePaths,
  auditPosixRuntimeTree,
};
