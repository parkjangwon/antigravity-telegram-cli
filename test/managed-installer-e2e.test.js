import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const installer = path.join(projectRoot, 'scripts', 'install.mjs');
const uninstaller = path.join(projectRoot, 'scripts', 'uninstall.mjs');

async function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => candidate && path.isAbsolute(candidate));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard Node/npm location.
    }
  }
  throw new Error('test fixture could not locate npm-cli.js');
}

async function sha256(target) {
  return createHash('sha256').update(await readFile(target)).digest('hex');
}

async function createFixtureArchive(root, version) {
  const fixture = path.join(root, `fixture-${version}`);
  const destination = path.join(root, `archive-${version}`);
  await Promise.all([
    mkdir(path.join(fixture, 'bin'), { recursive: true }),
    mkdir(path.join(fixture, 'scripts'), { recursive: true }),
    mkdir(path.join(fixture, 'src', 'service'), { recursive: true }),
    mkdir(destination, { recursive: true }),
  ]);
  const packageJson = {
    name: 'antigravity-telegram-cli',
    version,
    type: 'module',
    repository: {
      type: 'git',
      url: 'git+https://github.com/parkjangwon/antigravity-telegram-cli.git',
    },
    bin: { agygram: 'bin/agygram.js' },
    files: ['bin', 'scripts', 'src', '.env.example', 'npm-shrinkwrap.json'],
  };
  const shrinkwrap = {
    name: packageJson.name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: packageJson.name,
        version,
        bin: packageJson.bin,
      },
    },
  };
  await Promise.all([
    writeFile(path.join(fixture, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(path.join(fixture, 'npm-shrinkwrap.json'), `${JSON.stringify(shrinkwrap, null, 2)}\n`),
    writeFile(
      path.join(fixture, '.env.example'),
      [
        'BOT_TOKEN=',
        'ALLOWED_CHAT_IDS=',
        'OWNER_USER_IDS=',
        'DATA_DIR=',
        'WORKSPACE_DIR=',
        'AGY_BIN=agy',
        '',
      ].join('\n'),
    ),
    writeFile(
      path.join(fixture, 'bin', 'agygram.js'),
      `#!/usr/bin/env node\nif (process.argv[2] === '--version') process.stdout.write('${version}\\n');\nelse process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    ),
    writeFile(
      path.join(fixture, 'scripts', 'check.js'),
      '#!/usr/bin/env node\nprocess.stdout.write("fixture syntax check passed\\n");\n',
    ),
    writeFile(
      path.join(fixture, 'scripts', 'uninstall.mjs'),
      '#!/usr/bin/env node\nprocess.stdout.write("fixture uninstaller\\n");\n',
    ),
    ...[
      'src/index.js',
      'src/doctor.js',
      'src/setup.js',
      'src/config.js',
      'src/service/index.js',
      'src/service/file-runner.js',
      'src/service/runtime-paths.js',
    ].map((relative) => writeFile(
      path.join(fixture, ...relative.split('/')),
      'export {};\n',
    )),
  ]);
  if (process.platform !== 'win32') {
    await Promise.all([
      chmod(path.join(fixture, 'bin', 'agygram.js'), 0o700),
      chmod(path.join(fixture, 'scripts', 'check.js'), 0o700),
    ]);
  }

  const npmCli = await findNpmCli();
  await execFileAsync(process.execPath, [
    npmCli,
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    destination,
  ], {
    cwd: fixture,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
    },
    timeout: 30_000,
    windowsHide: true,
  });
  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, `expected one fixture archive for ${version}`);
  const archive = path.join(destination, archives[0]);
  return { archive, digest: await sha256(archive) };
}

function managedPaths(root) {
  const home = path.join(root, 'home');
  if (process.platform === 'win32') {
    const base = path.join(root, 'local-app-data', 'agygram');
    return {
      home,
      localAppData: path.join(root, 'local-app-data'),
      configFile: path.join(base, 'config', '.env'),
      dataDir: path.join(base, 'data'),
      workspaceDir: path.join(base, 'workspace'),
    };
  }
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support', 'agygram');
    return {
      home,
      configFile: path.join(base, 'config', '.env'),
      dataDir: path.join(base, 'data'),
      workspaceDir: path.join(base, 'workspace'),
    };
  }
  const dataBase = path.join(root, 'xdg-data', 'agygram');
  return {
    home,
    xdgDataHome: path.join(root, 'xdg-data'),
    xdgConfigHome: path.join(root, 'xdg-config'),
    configFile: path.join(root, 'xdg-config', 'agygram', '.env'),
    dataDir: path.join(dataBase, 'data'),
    workspaceDir: path.join(dataBase, 'workspace'),
  };
}

function hermeticEnvironment(root, paths) {
  const environment = {
    ...process.env,
    HOME: paths.home,
    USERPROFILE: paths.home,
    LOCALAPPDATA: paths.localAppData ?? path.join(root, 'local-app-data'),
    XDG_CONFIG_HOME: paths.xdgConfigHome ?? path.join(root, 'xdg-config'),
    XDG_DATA_HOME: paths.xdgDataHome ?? path.join(root, 'xdg-data'),
    npm_config_audit: 'false',
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
  };
  delete environment.AGYGRAM_INSTALL_ROOT;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return environment;
}

async function runScript(script, args, environment, { reject = false } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: projectRoot,
      env: environment,
      timeout: 90_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (reject) assert.fail(`command unexpectedly succeeded:\n${result.stdout}${result.stderr}`);
    return result;
  } catch (error) {
    if (!reject) throw error;
    assert.notEqual(error.code, 0);
    return {
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

function installArguments({ version, commit, fixture, installRoot, extra = [] }) {
  return [
    '--version', version,
    '--tag', `v${version}`,
    '--commit', commit,
    '--archive', fixture.archive,
    '--archive-sha256', fixture.digest,
    '--install-root', installRoot,
    '--agy-bin', process.execPath,
    '--no-service',
    ...extra,
  ];
}

test('managed install, repair, update, downgrade guard, and uninstall stay hermetic', {
  timeout: 180_000,
}, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agygram-managed-e2e-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = managedPaths(root);
  const installRoot = path.join(root, 'managed-code');
  const environment = hermeticEnvironment(root, paths);
  await mkdir(paths.home, { recursive: true });
  const [v010, v020] = await Promise.all([
    createFixtureArchive(root, '0.1.0'),
    createFixtureArchive(root, '0.2.0'),
  ]);
  const commit010 = 'a'.repeat(40);
  const commit020 = 'b'.repeat(40);

  await t.test('fresh install creates immutable code and external state', async () => {
    const result = await runScript(
      installer,
      installArguments({ version: '0.1.0', commit: commit010, fixture: v010, installRoot }),
      environment,
    );
    assert.match(result.stdout, /Installed: 0\.1\.0/u);

    const manifest = JSON.parse(await readFile(path.join(installRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '0.1.0');
    assert.equal(manifest.commit, commit010);
    assert.equal(manifest.currentRelease, `v0.1.0-${commit010}`);
    assert.equal(manifest.previousRelease, null);
    assert.equal(manifest.configFile, paths.configFile);
    assert.equal(manifest.dataDir, paths.dataDir);
    assert.equal(manifest.workspaceDir, paths.workspaceDir);
    assert.equal(manifest.serviceInstalled, false);
    assert.equal(
      (await readFile(path.join(installRoot, 'current'), 'utf8')).trim(),
      manifest.currentRelease,
    );
    assert.equal((await stat(path.join(installRoot, 'releases', manifest.currentRelease))).isDirectory(), true);
    assert.match(await readFile(paths.configFile, 'utf8'), /AGY_BIN=/u);
    assert.equal((await stat(paths.dataDir)).isDirectory(), true);
    assert.equal((await stat(paths.workspaceDir)).isDirectory(), true);

    const managedLauncher = path.join(installRoot, 'bin', 'agygram.mjs');
    const versionResult = await execFileAsync(process.execPath, ['--', managedLauncher, '--version'], {
      env: environment,
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(versionResult.stdout, '0.1.0\n');
    const helpResult = await execFileAsync(
      process.execPath,
      ['--', managedLauncher, 'doctor', '--help'],
      { env: environment, timeout: 10_000, windowsHide: true },
    );
    assert.deepEqual(JSON.parse(helpResult.stdout), ['doctor', '--help']);
    const doctorResult = await execFileAsync(
      process.execPath,
      ['--', managedLauncher, 'doctor'],
      { env: environment, timeout: 10_000, windowsHide: true },
    );
    assert.deepEqual(JSON.parse(doctorResult.stdout), [
      'doctor',
      '--config-file',
      paths.configFile,
      '--data-dir',
      paths.dataDir,
    ]);

    await Promise.all([
      writeFile(paths.configFile, `${await readFile(paths.configFile, 'utf8')}CUSTOM_SENTINEL="keep-config"\n`),
      writeFile(path.join(paths.dataDir, 'keep-data.txt'), 'keep-data\n'),
      writeFile(path.join(paths.workspaceDir, 'keep-workspace.txt'), 'keep-workspace\n'),
    ]);
  });

  await t.test('same-version rerun repairs managed launchers without replacing external state', async () => {
    const launcher = path.join(installRoot, 'bin', process.platform === 'win32' ? 'agygram.cmd' : 'agygram');
    await writeFile(launcher, 'tampered launcher\n');
    const result = await runScript(
      installer,
      installArguments({ version: '0.1.0', commit: commit010, fixture: v010, installRoot }),
      environment,
    );
    assert.match(result.stdout, /Already current: 0\.1\.0/u);
    assert.doesNotMatch(await readFile(launcher, 'utf8'), /^tampered launcher$/mu);
    assert.match(await readFile(paths.configFile, 'utf8'), /CUSTOM_SENTINEL="keep-config"/u);
    assert.equal(await readFile(path.join(paths.dataDir, 'keep-data.txt'), 'utf8'), 'keep-data\n');
    assert.equal(
      await readFile(path.join(paths.workspaceDir, 'keep-workspace.txt'), 'utf8'),
      'keep-workspace\n',
    );
  });

  await t.test('upgrade retains the prior release and refuses an implicit downgrade', async () => {
    await runScript(
      installer,
      installArguments({ version: '0.2.0', commit: commit020, fixture: v020, installRoot }),
      environment,
    );
    const upgraded = JSON.parse(await readFile(path.join(installRoot, 'manifest.json'), 'utf8'));
    assert.equal(upgraded.version, '0.2.0');
    assert.equal(upgraded.currentRelease, `v0.2.0-${commit020}`);
    assert.equal(upgraded.previousRelease, `v0.1.0-${commit010}`);
    assert.deepEqual(
      new Set(await readdir(path.join(installRoot, 'releases'))),
      new Set([upgraded.currentRelease, upgraded.previousRelease]),
    );

    const rejected = await runScript(
      installer,
      installArguments({ version: '0.1.0', commit: commit010, fixture: v010, installRoot }),
      environment,
      { reject: true },
    );
    assert.match(rejected.stderr, /Refusing downgrade from 0\.2\.0 to 0\.1\.0/u);
    const unchanged = JSON.parse(await readFile(path.join(installRoot, 'manifest.json'), 'utf8'));
    assert.equal(unchanged.version, '0.2.0');
    assert.equal(unchanged.currentRelease, upgraded.currentRelease);
    assert.match(await readFile(paths.configFile, 'utf8'), /CUSTOM_SENTINEL="keep-config"/u);
  });

  await t.test('uninstaller removes only owned code and is idempotent', async () => {
    const first = await runScript(
      uninstaller,
      ['--install-root', installRoot],
      environment,
    );
    assert.match(first.stdout, /Removed agygram 0\.2\.0/u);
    await assert.rejects(access(installRoot));
    assert.match(await readFile(paths.configFile, 'utf8'), /CUSTOM_SENTINEL="keep-config"/u);
    assert.equal(await readFile(path.join(paths.dataDir, 'keep-data.txt'), 'utf8'), 'keep-data\n');
    assert.equal(
      await readFile(path.join(paths.workspaceDir, 'keep-workspace.txt'), 'utf8'),
      'keep-workspace\n',
    );

    const second = await runScript(
      uninstaller,
      ['--install-root', installRoot],
      environment,
    );
    assert.match(second.stdout, /already uninstalled/u);
  });
});

test('managed installer rejects overlapping and unowned install roots without deleting them', {
  timeout: 60_000,
}, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agygram-managed-reject-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = managedPaths(root);
  const environment = hermeticEnvironment(root, paths);
  await mkdir(paths.home, { recursive: true });
  const fixture = await createFixtureArchive(root, '0.1.0');
  const commit = 'c'.repeat(40);

  const overlapRoot = path.join(root, 'overlap-root');
  const overlapConfig = path.join(overlapRoot, 'config', '.env');
  const overlap = await runScript(
    installer,
    installArguments({
      version: '0.1.0',
      commit,
      fixture,
      installRoot: overlapRoot,
      extra: ['--config-file', overlapConfig],
    }),
    environment,
    { reject: true },
  );
  assert.match(overlap.stderr, /must not overlap the external configuration path/u);
  await assert.rejects(access(overlapRoot));

  const unownedRoot = path.join(root, 'unowned-root');
  await mkdir(unownedRoot);
  const sentinel = path.join(unownedRoot, 'do-not-delete.txt');
  await writeFile(sentinel, 'not installer owned\n');
  const unowned = await runScript(
    installer,
    installArguments({ version: '0.1.0', commit, fixture, installRoot: unownedRoot }),
    environment,
    { reject: true },
  );
  assert.match(unowned.stderr, /Refusing to claim non-empty unmarked install root/u);
  assert.equal(await readFile(sentinel, 'utf8'), 'not installer owned\n');

  const uninstallRefusal = await runScript(
    uninstaller,
    ['--install-root', unownedRoot],
    environment,
    { reject: true },
  );
  assert.match(uninstallRefusal.stderr, /refusing to remove an unmanaged directory/u);
  assert.equal(await readFile(sentinel, 'utf8'), 'not installer owned\n');
});
