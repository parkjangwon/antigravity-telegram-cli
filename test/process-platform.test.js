import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertWindowsCommandLineSupported,
  createSafeSpawnSpec,
  estimateWindowsCommandLineUnits,
  ProcessPlatformError,
  quoteWindowsArgument,
  resolveProcessExecutable,
  WINDOWS_HARD_COMMAND_LINE_UNITS,
} from '../src/process-platform.js';

function virtualFiles(paths) {
  const available = new Set(paths.map((entry) => entry.toLowerCase()));
  return async (candidate) => available.has(candidate.toLowerCase());
}

test('Linux and macOS resolve executable PATH entries without a shell', async () => {
  for (const platform of ['linux', 'darwin']) {
    const resolved = await resolveProcessExecutable('agy', {
      platform,
      cwd: '/srv/bot',
      env: { PATH: '/opt/antigravity/bin:/usr/bin' },
      probeFile: virtualFiles(['/opt/antigravity/bin/agy']),
    });
    assert.deepEqual(resolved, {
      requested: 'agy',
      path: '/opt/antigravity/bin/agy',
      source: 'PATH',
      platform,
    });
  }
});

test('POSIX default probe requires a real executable file', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-platform-'));
  const executable = path.join(root, 'agy');
  const nonExecutable = path.join(root, 'agy-disabled');
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await writeFile(nonExecutable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    await chmod(nonExecutable, 0o600);

    assert.equal(
      (await resolveProcessExecutable(executable, { platform: process.platform })).path,
      executable,
    );
    await assert.rejects(
      resolveProcessExecutable(nonExecutable, { platform: process.platform }),
      (error) => error instanceof ProcessPlatformError && error.code === 'PROCESS_EXECUTABLE_NOT_FOUND',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows resolves a native agy.exe from PATH case-insensitively', async () => {
  const resolved = await resolveProcessExecutable('agy', {
    platform: 'win32',
    cwd: 'C:\\service',
    env: { Path: 'C:\\Program Files\\Antigravity;C:\\Windows\\System32' },
    probeFile: virtualFiles(['C:\\Program Files\\Antigravity\\agy.exe']),
  });
  assert.deepEqual(resolved, {
    requested: 'agy',
    path: 'C:\\Program Files\\Antigravity\\agy.exe',
    source: 'PATH',
    platform: 'win32',
  });
});

test('Windows accepts explicit .exe paths and rejects shell launchers', async () => {
  const executable = 'C:\\Users\\bot\\Antigravity\\agy.exe';
  const resolved = await resolveProcessExecutable(executable, {
    platform: 'win32',
    cwd: 'C:\\service',
    env: {},
    probeFile: virtualFiles([executable]),
  });
  assert.equal(resolved.path, executable);

  for (const extension of ['cmd', 'bat', 'ps1']) {
    await assert.rejects(
      resolveProcessExecutable(`C:\\tools\\agy.${extension}`, {
        platform: 'win32',
        cwd: 'C:\\service',
        probeFile: virtualFiles([`C:\\tools\\agy.${extension}`]),
      }),
      (error) => error instanceof ProcessPlatformError && error.code === 'WINDOWS_SHELL_SHIM_UNSUPPORTED',
    );
  }
});

test('Windows bare command fails closed when PATH contains only an npm .cmd shim', async () => {
  await assert.rejects(
    resolveProcessExecutable('agy', {
      platform: 'win32',
      cwd: 'C:\\service',
      env: { PATH: 'C:\\Users\\bot\\AppData\\Roaming\\npm' },
      probeFile: virtualFiles(['C:\\Users\\bot\\AppData\\Roaming\\npm\\agy.cmd']),
    }),
    (error) => error instanceof ProcessPlatformError &&
      error.code === 'WINDOWS_SHELL_SHIM_UNSUPPORTED' &&
      !error.message.includes('prompt'),
  );
});

test('safe spawn spec preserves hostile prompt text as one literal argv item', async () => {
  const prompt = '$(touch /tmp/pwned) & whoami | echo %PATH% `id`';
  const spec = await createSafeSpawnSpec('agy', ['--print', prompt], {
    platform: 'win32',
    cwd: 'C:\\bot',
    env: { PATH: 'C:\\Antigravity' },
    probeFile: virtualFiles(['C:\\Antigravity\\agy.exe']),
  });
  assert.equal(spec.command, 'C:\\Antigravity\\agy.exe');
  assert.deepEqual(spec.args, ['--print', prompt]);
  assert.deepEqual(spec.options, {
    cwd: 'C:\\bot',
    env: { PATH: 'C:\\Antigravity' },
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: false,
  });
  assert.ok(spec.commandLine.units > prompt.length);
});

test('Windows command-line estimator counts UTF-16 units and the terminator', () => {
  assert.equal(estimateWindowsCommandLineUnits('agy.exe', ['😀']), 11);
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('hello world'), '"hello world"');
  assert.equal(quoteWindowsArgument('C:\\path with space\\'), '"C:\\path with space\\\\"');
  assert.equal(quoteWindowsArgument('say"hello'), '"say\\"hello"');
});

test('Windows command-line guard fails without copying prompt contents into errors', () => {
  const secretPrompt = `secret-${'x'.repeat(80)}`;
  assert.throws(
    () => assertWindowsCommandLineSupported('agy.exe', [secretPrompt], {
      platform: 'win32',
      maxUnits: 40,
    }),
    (error) => error instanceof ProcessPlatformError &&
      error.code === 'WINDOWS_COMMAND_LINE_LIMIT' &&
      !error.message.includes(secretPrompt),
  );
  assert.throws(
    () => assertWindowsCommandLineSupported('agy.exe', [], {
      platform: 'win32',
      maxUnits: WINDOWS_HARD_COMMAND_LINE_UNITS + 1,
    }),
    (error) => error.code === 'INVALID_WINDOWS_COMMAND_LINE_LIMIT',
  );
});

test('Windows rejects conflicting, empty, and relative PATH entries', async () => {
  await assert.rejects(
    resolveProcessExecutable('agy', {
      platform: 'win32',
      cwd: 'C:\\service',
      env: { PATH: 'C:\\one', Path: 'C:\\two' },
      probeFile: virtualFiles(['C:\\one\\agy.exe']),
    }),
    (error) => error.code === 'AMBIGUOUS_PROCESS_ENVIRONMENT',
  );

  await assert.rejects(
    resolveProcessExecutable('agy', {
      platform: 'win32',
      cwd: 'C:\\service',
      env: { PATH: ';C:\\tools' },
      probeFile: virtualFiles(['C:\\service\\agy.exe']),
    }),
    (error) => error.code === 'UNSAFE_PROCESS_PATH',
  );

  for (const unsafePath of ['.\\bin;C:\\tools', 'bin;C:\\tools', '\\rooted;C:\\tools']) {
    await assert.rejects(
      resolveProcessExecutable('agy', {
        platform: 'win32',
        cwd: 'C:\\service',
        env: { PATH: unsafePath },
        probeFile: virtualFiles(['C:\\service\\bin\\agy.exe']),
      }),
      (error) => error.code === 'UNSAFE_PROCESS_PATH',
    );
  }
});

test('POSIX PATH whitespace and relative entries are never normalized into trusted directories', async () => {
  for (const unsafePath of [' /trusted/bin:/usr/bin', './bin:/usr/bin', ':/usr/bin']) {
    await assert.rejects(
      resolveProcessExecutable('agy', {
        platform: 'linux',
        cwd: '/srv/bot',
        env: { PATH: unsafePath },
        probeFile: virtualFiles(['/trusted/bin/agy']),
      }),
      (error) => error.code === 'UNSAFE_PROCESS_PATH',
    );
  }
});

test('drive-relative Windows commands and non-absolute cwd fail closed', async () => {
  await assert.rejects(
    resolveProcessExecutable('C:agy.exe', {
      platform: 'win32',
      cwd: 'C:\\service',
      probeFile: virtualFiles(['C:\\service\\agy.exe']),
    }),
    (error) => error.code === 'INVALID_PROCESS_COMMAND',
  );
  await assert.rejects(
    resolveProcessExecutable('agy', {
      platform: 'win32',
      cwd: '\\service',
      env: { PATH: 'C:\\tools' },
      probeFile: virtualFiles(['C:\\tools\\agy.exe']),
    }),
    (error) => error.code === 'INVALID_PROCESS_CWD',
  );
});

test('spawn spec carries cwd and only the caller-supplied environment into a real child', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-safe-spawn-'));
  const parentSecretName = `AGY_PARENT_SECRET_${process.pid}`;
  process.env[parentSecretName] = 'must-not-leak';
  try {
    const script = [
      'process.stdout.write(JSON.stringify({',
      'cwd: process.cwd(),',
      'marker: process.env.SAFE_MARKER,',
      `parentSecret: process.env[${JSON.stringify(parentSecretName)}],`,
      'argument: process.argv[1]',
      '}))',
    ].join('');
    const hostile = '& whoami | echo %PATH% `id`';
    const spec = await createSafeSpawnSpec(process.execPath, ['-e', script, hostile], {
      platform: process.platform,
      cwd: root,
      env: { SAFE_MARKER: 'present' },
    });

    const result = await new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        ...spec.options,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => code === 0
        ? resolve(JSON.parse(stdout))
        : reject(new Error(`child exited ${code}: ${stderr}`)));
    });

    assert.deepEqual(result, {
      cwd: root,
      marker: 'present',
      argument: hostile,
    });
  } finally {
    delete process.env[parentSecretName];
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid platforms, NULs, and non-string args are rejected before spawn', async () => {
  await assert.rejects(
    resolveProcessExecutable('agy', { platform: 'freebsd' }),
    (error) => error.code === 'UNSUPPORTED_PROCESS_PLATFORM',
  );
  await assert.rejects(
    createSafeSpawnSpec('agy', ['ok\0bad'], {
      platform: 'linux',
      probeFile: virtualFiles(['/bin/agy']),
      env: { PATH: '/bin' },
    }),
    (error) => error.code === 'INVALID_PROCESS_ARGUMENT',
  );
  await assert.rejects(
    createSafeSpawnSpec('agy', [42], {
      platform: 'linux',
      probeFile: virtualFiles(['/bin/agy']),
      env: { PATH: '/bin' },
    }),
    (error) => error.code === 'INVALID_PROCESS_ARGUMENT',
  );
  await assert.rejects(
    createSafeSpawnSpec(process.execPath, [], {
      platform: process.platform,
      cwd: `${process.cwd()}\0escape`,
    }),
    (error) => error.code === 'INVALID_PROCESS_CWD' || error.code === 'INVALID_PROCESS_ARGUMENT',
  );
});
