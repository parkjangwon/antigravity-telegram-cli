import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  buildServicePlan,
  executeServicePlan,
  formatServicePlan,
  manageService,
  spawnCommand,
  _private as servicePrivate,
} from '../src/service/index.js';
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsTaskControlScript,
  buildWindowsTaskXml,
  systemdQuote,
  windowsQuoteArg,
} from '../src/service/templates.js';
import { main as cliMain, _private as cliPrivate } from '../bin/agygram.js';
import {
  appendBoundedLog,
  formatLogLine,
  installFileConsole,
  rotateLogFile,
} from '../src/service/file-console.js';

const execFileAsync = promisify(execFile);

test('launchd plist preserves tokenized paths and XML-escapes special characters', () => {
  const plist = buildLaunchdPlist({
    nodePath: '/Users/me/Node & Tools/node',
    entryPath: '/Users/me/My <Bot>/src/index.js',
    entryArguments: ['--data-dir', '/Users/me/Data & State'],
    projectDir: '/Users/me/My <Bot>',
    stdoutPath: '/tmp/a & b.log',
    stderrPath: '/tmp/error.log',
  });
  assert.match(plist, /<string>\/Users\/me\/Node &amp; Tools\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/me\/Node &amp; Tools\/node<\/string>\s*<string>--<\/string>/);
  assert.match(plist, /<string>\/Users\/me\/My &lt;Bot&gt;\/src\/index\.js<\/string>/);
  assert.match(plist, /<string>--data-dir<\/string>\s*<string>\/Users\/me\/Data &amp; State<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.doesNotMatch(plist, /sh -c/);
});

test('systemd unit quotes spaces, specifiers, dollars, and backslashes without a shell', () => {
  assert.equal(systemdQuote('/opt/100%/$bot\\node'), '"/opt/100%%/$bot\\\\node"');
  assert.equal(
    systemdQuote('/opt/$bot', { escapeDollar: true }),
    '"/opt/$$bot"',
  );
  const unit = buildSystemdUnit({
    nodePath: '/opt/Node Tools/node',
    entryPath: '/srv/Bot %i/$entry/index.js',
    entryArguments: ['--data-dir', '/srv/State %s/$data'],
    projectDir: '/srv/Bot $HOME',
  });
  assert.match(
    unit,
    /ExecStart="\/opt\/Node Tools\/node" "--" "\/srv\/Bot %%i\/\$\$entry\/index\.js" "--data-dir" "\/srv\/State %%s\/\$\$data"/,
  );
  assert.match(unit, /WorkingDirectory="\/srv\/Bot \$HOME"/);
  assert.match(unit, /Restart=on-failure/);
  assert.doesNotMatch(unit, /\/bin\/sh/);
});

test('Windows argv quoting follows trailing backslash and embedded quote rules', () => {
  assert.equal(windowsQuoteArg('C:\\Program Files\\node.exe'), '"C:\\Program Files\\node.exe"');
  assert.equal(windowsQuoteArg('C:\\has space\\'), '"C:\\has space\\\\"');
  assert.equal(windowsQuoteArg('a"b'), '"a\\"b"');
});

test('Windows task XML is least privilege, restartable, and path-safe', () => {
  const xml = buildWindowsTaskXml({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    entryPath: 'C:\\Users\\A & B\\bot\\src\\index.js',
    entryArguments: ['--data-dir', 'D:\\Bot State'],
    projectDir: 'C:\\Users\\A & B\\bot',
    userId: 'DESKTOP\\A&B',
  });
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.match(xml, /<Arguments>-- &quot;C:\\Users\\A &amp; B\\bot\\src\\index\.js&quot; --data-dir &quot;D:\\Bot State&quot;<\/Arguments>/);
  assert.match(xml, /<WorkingDirectory>C:\\Users\\A &amp; B\\bot<\/WorkingDirectory>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
});

test('all three install plans use absolute native paths and argv arrays', () => {
  const mac = buildServicePlan('install', {
    platform: 'darwin',
    projectDir: '/Users/me/My Bot',
    nodePath: '/opt/homebrew/bin/node',
    homeDir: '/Users/me',
    uid: 501,
    dataDir: '/Volumes/Private Bot Data',
    envFile: '/Users/me/.config/agygram/bot.env',
  });
  assert.equal(mac.entryPath, '/Users/me/My Bot/src/service/file-runner.js');
  assert.match(mac.definition, /<string>\/dev\/null<\/string>/);
  assert.match(mac.definition, /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>--<\/string>/);
  assert.match(mac.definition, /<string>--data-dir<\/string>\s*<string>\/Volumes\/Private Bot Data<\/string>/);
  assert.match(mac.definition, /<string>--config-file<\/string>\s*<string>\/Users\/me\/\.config\/agygram\/bot\.env<\/string>/);
  assert.doesNotMatch(mac.definition, /--env-file/);
  assert.ok(path.posix.isAbsolute(mac.managerExecutables.launchctl));
  assert.deepEqual(
    mac.operations.find(
      (item) => path.posix.basename(item.file || '') === 'launchctl' &&
        item.args[0] === 'bootstrap',
    ).args,
    ['bootstrap', 'gui/501', '/Users/me/Library/LaunchAgents/dev.agygram.bot.plist'],
  );

  const linux = buildServicePlan('install', {
    platform: 'linux',
    projectDir: '/home/me/My Bot',
    nodePath: '/usr/bin/node',
    homeDir: '/home/me',
    envFile: '/home/me/.config/agygram/bot.env',
    env: { PATH: process.env.PATH },
  });
  assert.equal(linux.definitionPath, '/home/me/.config/systemd/user/agygram.service');
  assert.match(linux.definition, /ExecStart="\/usr\/bin\/node" "--"/);
  assert.match(linux.definition, /"--data-dir" "\/home\/me\/My Bot\/data"/);
  assert.match(linux.definition, /"--config-file" "\/home\/me\/\.config\/agygram\/bot\.env"/);
  assert.doesNotMatch(linux.definition, /--env-file/);
  assert.ok(path.posix.isAbsolute(linux.managerExecutables.systemctl));
  const restart = linux.operations.find(
    (item) => path.posix.basename(item.file || '') === 'systemctl' &&
      item.args.includes('restart'),
  );
  assert.deepEqual(restart.args, [
    '--user',
    'restart',
    'agygram.service',
  ]);
  assert.deepEqual(linux.operations.at(-1).args, [
    '--user',
    'is-active',
    '--quiet',
    'agygram.service',
  ]);
  assert.ok(linux.operations.some(
    (item) => path.posix.basename(item.file || '') === 'loginctl',
  ));

  const windows = buildServicePlan('install', {
    platform: 'win32',
    projectDir: 'C:\\Users\\Me\\My Bot',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    homeDir: 'C:\\Users\\Me',
    windowsUserId: 'PC\\Me',
    environmentPath: 'C:\\Tools;C:\\Windows\\System32',
    dataDir: 'D:\\Private Bot Data',
    envFile: 'C:\\Users\\Me\\Private Config\\bot.env',
  });
  assert.equal(windows.entryPath, 'C:\\Users\\Me\\My Bot\\src\\service\\file-runner.js');
  const create = windows.operations.find(
    (item) => path.win32.basename(item.file || '').toLowerCase() === 'schtasks.exe' && item.args[0] === '/Create',
  );
  assert.deepEqual(create.args.slice(0, 3), ['/Create', '/TN', 'agygram']);
  assert.equal(create.args.at(-1), '/F');
  const pinnedEnvironment = windows.operations.find(
    (item) => item.type === 'write' && item.path.endsWith('environment.json'),
  );
  assert.deepEqual(JSON.parse(pinnedEnvironment.content), {
    NODE_ENV: 'production',
    PATH: 'C:\\Tools;C:\\Windows\\System32',
  });
  const stop = windows.operations.find(
    (item) => path.win32.basename(item.file || '').toLowerCase() === 'powershell.exe' &&
      item.args.includes('Stop'),
  );
  assert.ok(stop.args.includes('-File'));
  const stopRequestArgument = stop.args.indexOf('-StopRequestPath');
  assert.equal(
    stop.args[stopRequestArgument + 1],
    'D:\\Private Bot Data\\runtime\\service\\stop.request.json',
  );
  assert.equal(stop.args[stop.args.indexOf('-Action') + 1], 'Stop');
  assert.equal(stop.args[stop.args.indexOf('-LockPath') + 1], 'D:\\Private Bot Data\\bot.lock');
  assert.equal(
    stop.args[stop.args.indexOf('-TaskkillPath') + 1],
    'C:\\Windows\\System32\\taskkill.exe',
  );
  assert.ok(windows.definition.includes(
    '-- &quot;C:\\Users\\Me\\My Bot\\src\\service\\file-runner.js&quot; --data-dir ' +
      '&quot;D:\\Private Bot Data&quot; --config-file ' +
      '&quot;C:\\Users\\Me\\Private Config\\bot.env&quot;',
  ));
  assert.doesNotMatch(windows.definition, /--env-file/);
  assert.equal(
    windows.definitionPath,
    'D:\\Private Bot Data\\runtime\\service\\agygram.xml',
  );
  assert.ok(
    windows.operations.indexOf(stop) < windows.operations.indexOf(create),
    'the old task must stop before its registration is replaced',
  );
});

test('status and uninstall plans do not contain an install definition', () => {
  const status = buildServicePlan('status', {
    platform: 'linux',
    projectDir: '/srv/bot',
    nodePath: '/usr/bin/node',
    homeDir: '/home/me',
  });
  assert.equal(status.definition, undefined);
  assert.equal(status.operations.length, 1);

  const remove = buildServicePlan('uninstall', {
    platform: 'win32',
    projectDir: 'C:\\Bot',
    nodePath: 'C:\\Node\\node.exe',
    homeDir: 'C:\\Users\\Me',
    windowsUserId: 'PC\\Me',
  });
  assert.equal(remove.definition, undefined);
  assert.ok(remove.operations.some((item) => item.type === 'remove'));
});

test('POSIX uninstall plans narrowly classify already-absent native services', () => {
  const mac = buildServicePlan('uninstall', {
    platform: 'darwin',
    projectDir: '/Users/me/agygram',
    nodePath: '/usr/bin/node',
    homeDir: '/Users/me',
    uid: 501,
  });
  const bootout = mac.operations.find((item) => item.args?.[0] === 'bootout');
  assert.equal(bootout.absentService, 'launchd');
  assert.equal(bootout.serviceName, 'dev.agygram.bot');
  assert.deepEqual(bootout.envOverrides, { LANG: 'C', LC_ALL: 'C' });

  const linux = buildServicePlan('uninstall', {
    platform: 'linux',
    projectDir: '/srv/agygram',
    nodePath: '/usr/bin/node',
    homeDir: '/home/me',
  });
  const disable = linux.operations.find((item) => item.args?.includes('disable'));
  assert.equal(disable.absentService, 'systemd');
  assert.equal(disable.serviceName, 'agygram.service');
  assert.deepEqual(disable.envOverrides, { LANG: 'C', LC_ALL: 'C' });
  assert.equal(
    linux.operations.find((item) => item.args?.includes('daemon-reload')).absentService,
    undefined,
  );
});

test('POSIX uninstall continues only for manager-confirmed absence', async () => {
  const cases = [
    {
      operation: {
        type: 'command',
        file: '/bin/launchctl',
        args: ['bootout', 'gui/501/dev.agygram.bot'],
        absentService: 'launchd',
        serviceName: 'dev.agygram.bot',
        envOverrides: { LANG: 'C', LC_ALL: 'C' },
      },
      error: Object.assign(new Error('launchctl failed'), {
        exitCode: 3,
        stdout: '',
        stderr: 'Boot-out failed: 3: No such process\n',
      }),
    },
    {
      operation: {
        type: 'command',
        file: '/usr/bin/systemctl',
        args: ['--user', 'disable', '--now', 'agygram.service'],
        absentService: 'systemd',
        serviceName: 'agygram.service',
        envOverrides: { LANG: 'C', LC_ALL: 'C' },
      },
      error: Object.assign(new Error('systemctl failed'), {
        exitCode: 1,
        stdout: '',
        stderr: 'Failed to disable unit: Unit file agygram.service does not exist.\n',
      }),
    },
  ];

  for (const { operation, error } of cases) {
    const calls = [];
    const warnings = [];
    await executeServicePlan({
      operations: [
        operation,
        { type: 'command', file: '/safe/next-step', args: [] },
      ],
    }, {
      commandEnvironment: { HOME: '/safe/home', PATH: '/safe/bin' },
      onWarning: (message) => warnings.push(message),
      async runner(file, args, options) {
        calls.push({ file, args, options });
        if (file === operation.file) throw error;
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /already absent/);
    assert.equal(calls[0].options.captureOutput, true);
    assert.deepEqual(calls[0].options.env, {
      HOME: '/safe/home',
      PATH: '/safe/bin',
      LANG: 'C',
      LC_ALL: 'C',
    });
  }
});

test('POSIX uninstall surfaces permission, executable, signal, and ambiguous errors', async () => {
  const operation = {
    type: 'command',
    file: '/usr/bin/systemctl',
    args: ['--user', 'disable', '--now', 'agygram.service'],
    absentService: 'systemd',
    serviceName: 'agygram.service',
    envOverrides: { LANG: 'C', LC_ALL: 'C' },
  };
  const failures = [
    Object.assign(new Error('permission denied'), {
      exitCode: 1,
      stderr: 'Failed to connect to bus: Permission denied\n',
    }),
    Object.assign(new Error('wrong unit'), {
      exitCode: 1,
      stderr: 'Failed to disable unit: Unit file another.service does not exist.\n',
    }),
    Object.assign(new Error('manager executable missing'), { code: 'ENOENT' }),
    Object.assign(new Error('manager stopped by signal'), { signal: 'SIGTERM' }),
    new Error('manager timed out'),
  ];

  for (const failure of failures) {
    let calls = 0;
    await assert.rejects(
      executeServicePlan({
        operations: [
          operation,
          { type: 'command', file: '/safe/must-not-run', args: [] },
        ],
      }, {
        async runner() {
          calls += 1;
          throw failure;
        },
      }),
      failure,
    );
    assert.equal(calls, 1);
  }

  const launchdAmbiguity = Object.assign(new Error('not confirmed absent'), {
    exitCode: 3,
    stderr: 'Boot-out failed: 3: Permission denied\n',
  });
  await assert.rejects(
    executeServicePlan({
      operations: [{
        ...operation,
        file: '/bin/launchctl',
        absentService: 'launchd',
        serviceName: 'dev.agygram.bot',
      }],
    }, { runner: async () => { throw launchdAmbiguity; } }),
    launchdAmbiguity,
  );
});

test('plan formatting is diagnostic only and execution passes argv without a shell', async () => {
  const plan = buildServicePlan('status', {
    platform: 'linux',
    projectDir: '/srv/My Bot',
    nodePath: '/usr/bin/node',
    homeDir: '/home/me',
  });
  assert.match(formatServicePlan(plan), /systemctl --user status/);

  const calls = [];
  await executeServicePlan(plan, {
    runner: async (file, args, options) => calls.push({ file, args, options }),
  });
  assert.deepEqual(calls, [{
    file: plan.managerExecutables.systemctl,
    args: ['--user', 'status', 'agygram.service', '--no-pager', '--full'],
    options: { stdio: 'inherit' },
  }]);
});

test('templates reject control characters', () => {
  assert.throws(
    () => buildSystemdUnit({ nodePath: '/usr/bin/node', entryPath: '/tmp/a\nb', projectDir: '/tmp' }),
    /control characters/,
  );
  assert.throws(
    () => servicePrivate.normalizeServicePath('\\root-relative;C:\\Windows\\System32', 'win32'),
    /absolute directories/,
  );
  assert.throws(() => buildServicePlan('status', {
    platform: 'win32',
    projectDir: '\\root-relative',
    nodePath: 'C:\\Node\\node.exe',
    homeDir: 'C:\\Users\\Me',
  }), /projectDir must be an absolute path/);
});

test('Windows control script requests lifecycle shutdown before a bounded hard fallback', () => {
  const script = buildWindowsTaskControlScript();
  assert.match(script, /ValidateSet\('Stop', 'Remove', 'Check'\)/);
  assert.match(script, /Get-ScheduledTask -ErrorAction Stop/);
  assert.match(script, /if \(\$task\.State -eq 'Running'\)/);
  assert.match(script, /StopRequestPath must be an absolute path/);
  assert.match(script, /Move-Item .*\$StopRequestPath -Force/);
  assert.match(script, /Wait-ForTaskExit 30/);
  assert.match(script, /Get-VerifiedLockOwnerProcess/);
  assert.match(script, /\$RegisteredTask\.Actions/);
  assert.match(script, /--data-dir/);
  assert.match(script, /\& \$TaskkillPath \/PID .* \/T \/F/);
  assert.match(script, /\$taskkillExitCode = \$LASTEXITCODE/);
  assert.match(script, /\$null -ne \$remainingOwner/);
  assert.match(script, /Stop-ScheduledTask/);
  assert.match(script, /Wait-ForTaskExit 15/);
  assert.match(script, /Remove-StopRequest/);
  assert.match(script, /Unregister-ScheduledTask/);
  assert.match(script, /if \(\$null -eq \$task\)[\s\S]*Remove-StopRequest[\s\S]*exit 0/);
  assert.match(script, /did not become ready/);
});

test('Windows service environment retains only the identity needed for native task install', () => {
  const env = cliPrivate.loadServiceManagerEnvironment({
    USERNAME: 'Alice',
    USERDOMAIN: 'DEVBOX',
    SystemRoot: 'C:\\Windows',
    PATH: 'C:\\Windows\\System32',
    BOT_TOKEN: 'must-not-be-copied',
    NODE_OPTIONS: '--require=C:\\attacker.cjs',
  });
  assert.deepEqual(env, {
    USERNAME: 'Alice',
    USERDOMAIN: 'DEVBOX',
    PATH: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
  });
  assert.equal(cliPrivate.SERVICE_CONFIG_KEYS.has('USERNAME'), false);
  assert.equal(cliPrivate.SERVICE_CONFIG_KEYS.has('USERDOMAIN'), false);

  const plan = buildServicePlan('install', {
    platform: 'win32',
    projectDir: 'C:\\Agygram',
    nodePath: 'C:\\Node\\node.exe',
    dataDir: 'C:\\Agygram Data',
    env,
  });
  assert.match(plan.definition, /<UserId>DEVBOX\\Alice<\/UserId>/);
});

test('CLI option parsing accepts dry-run and rejects missing values', () => {
  assert.deepEqual(
    cliPrivate.parseOptions(['--dry-run', '--platform', 'linux']),
    {
      dryRun: true,
      platform: 'linux',
      projectDir: cliPrivate.PROJECT_DIR,
      nodePath: process.execPath,
      enableLinger: true,
    },
  );
  assert.throws(() => cliPrivate.parseOptions(['--node']), /Missing value/);
  assert.equal(cliPrivate.parseOptions(['--uid', '501']).uid, 501);
  assert.throws(() => cliPrivate.parseOptions(['--uid', '-1']), /Invalid uid/);
  assert.deepEqual(
    cliPrivate.parseOptions([
      '--config-file',
      path.join(os.homedir(), '.config', 'agygram', 'bot.env'),
      '--data-dir',
      path.join(os.homedir(), '.local', 'share', 'agygram'),
    ]),
    {
      dryRun: false,
      platform: undefined,
      projectDir: cliPrivate.PROJECT_DIR,
      nodePath: process.execPath,
      enableLinger: true,
      envFile: path.join(os.homedir(), '.config', 'agygram', 'bot.env'),
      dataDir: path.join(os.homedir(), '.local', 'share', 'agygram'),
    },
  );
  assert.throws(
    () => cliPrivate.parseOptions(['--config-file', 'relative.env']),
    /must be absolute/,
  );
  assert.throws(
    () => cliPrivate.parseOptions(['--data-dir', `${os.homedir()}\ndata`]),
    /control characters/,
  );
  assert.throws(
    () => cliPrivate.parseOptions(['--config-file', '/one', '--config-file', '/two']),
    /Duplicate option/,
  );
  assert.throws(
    () => cliPrivate.parseOptions(['--env-file', path.join(os.homedir(), '.env')]),
    /Unknown option: --env-file/,
  );
  assert.throws(() => cliPrivate.parseOptions(['--bogus']), /Unknown option/);
});

test('doctor spawn argv places the Node option boundary before the JavaScript entrypoint', () => {
  assert.deepEqual(cliPrivate.buildDoctorArguments({
    projectDir: '/srv/agygram',
    dataDir: '/var/lib/agygram',
    envFile: '/etc/agygram/bot.env',
  }), [
    '--',
    path.join('/srv/agygram', 'src', 'doctor.js'),
    '--data-dir',
    '/var/lib/agygram',
    '--config-file',
    '/etc/agygram/bot.env',
  ]);
});

test('help cannot bypass unknown option validation', async () => {
  await assert.rejects(
    cliMain(['service', 'install', '--bogus', '--help']),
    /Unknown option/,
  );
});

test('Node 22+ passes a missing --config-file path to agygram for validation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-missing-config-'));
  const missingConfig = path.join(directory, 'missing.env');
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        path.join(process.cwd(), 'bin', 'agygram.js'),
        'service',
        'status',
        '--dry-run',
        '--project-dir',
        directory,
        '--config-file',
        missingConfig,
      ], {
        cwd: process.cwd(),
        env: {
          HOME: os.homedir(),
          USERPROFILE: process.env.USERPROFILE,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        },
        timeout: 10_000,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /^agygram: /u);
        assert.match(error.stderr, /ENOENT/u);
        assert.match(error.stderr, new RegExp(
          missingConfig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        ));
        assert.doesNotMatch(error.stderr, /^node:/u);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('doctor CLI forwards and trust-checks the exact external env file', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-doctor-env-'));
  const envFile = path.join(directory, 'external.env');
  try {
    await writeFile(envFile, 'BOT_TOKEN=must-not-be-loaded\n', { mode: 0o644 });
    await assert.rejects(
      execFileAsync(process.execPath, [
        path.join(process.cwd(), 'bin', 'agygram.js'),
        'doctor',
        '--config-file',
        envFile,
      ], {
        cwd: process.cwd(),
        env: {
          HOME: os.homedir(),
          PATH: process.env.PATH,
        },
        timeout: 10_000,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /FAIL 환경 파일 권한:/);
        assert.match(error.stdout, new RegExp(envFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.stdout, /deny group\/other access/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('doctor treats an explicit env file as authoritative over ambient app config', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-doctor-authority-'));
  const envFile = path.join(directory, 'external.env');
  try {
    await writeFile(envFile, 'DEFAULT_MODE=invalid\n', { mode: 0o600 });
    await assert.rejects(
      execFileAsync(process.execPath, [
        path.join(process.cwd(), 'bin', 'agygram.js'),
        'doctor',
        '--config-file',
        envFile,
      ], {
        cwd: process.cwd(),
        env: {
          HOME: os.homedir(),
          PATH: process.env.PATH,
          BOT_TOKEN: '123456:ambient-token',
          ALLOWED_CHAT_ID: '123456',
          DEFAULT_MODE: 'plan',
        },
        timeout: 10_000,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /FAIL 환경 설정: DEFAULT_MODE must be accept-edits or plan/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Linux can skip linger and Windows rejects task paths over 260 characters', () => {
  const linux = buildServicePlan('install', {
    platform: 'linux',
    projectDir: '/srv/bot',
    nodePath: '/usr/bin/node',
    homeDir: '/home/me',
    enableLinger: false,
  });
  assert.ok(!linux.operations.some(
    (item) => path.posix.basename(item.file || '') === 'loginctl',
  ));

  assert.throws(() => buildServicePlan('install', {
    platform: 'win32',
    projectDir: `C:\\${'a'.repeat(261)}`,
    nodePath: 'C:\\Node\\node.exe',
    homeDir: 'C:\\Users\\Me',
    windowsUserId: 'PC\\Me',
  }), /260-character/);
});

test('Windows service log formatting and one-generation rotation are bounded', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-service-'));
  const logFile = path.join(directory, 'service.log');
  try {
    await writeFile(logFile, '12345', { mode: 0o600 });
    assert.equal(rotateLogFile(logFile, 5), true);
    assert.equal(await readFile(`${logFile}.1`, 'utf8'), '12345');
    await writeFile(logFile, 'x'.repeat(20), { mode: 0o600 });
    assert.equal(rotateLogFile(logFile, 5), true);
    assert.equal((await readFile(`${logFile}.1`)).length, 5);
    assert.equal(
      formatLogLine('warn', ['hello %s', 'world'], new Date('2026-01-02T03:04:05.000Z')),
      `${JSON.stringify({ time: '2026-01-02T03:04:05.000Z', level: 'warn', pid: process.pid, msg: 'hello world' })}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file console rotates while running before the active log exceeds its limit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-console-'));
  const logFile = path.join(directory, 'service.log');
  const sink = [];
  const target = Object.fromEntries(
    ['debug', 'info', 'log', 'warn', 'error'].map((level) => [
      level,
      (...args) => sink.push([level, args]),
    ]),
  );
  try {
    const restore = installFileConsole({ logFile, maxBytes: 100, target });
    target.log('a'.repeat(40));
    target.log('b'.repeat(40));
    restore();
    const active = await readFile(logFile);
    const previous = await readFile(`${logFile}.1`);
    assert.ok(active.length <= 100);
    assert.ok(previous.length <= 100);
    assert.equal(sink.length, 2);
    assert.throws(
      () => installFileConsole({ logFile, maxBytes: 0, target }),
      /positive integer/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bootstrap fallback logging uses a fixed bounded file and one generation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-bootstrap-log-'));
  const logFile = path.join(directory, 'bootstrap.log');
  try {
    appendBoundedLog(logFile, 'a'.repeat(60), 100);
    appendBoundedLog(logFile, 'b'.repeat(60), 100);
    appendBoundedLog(logFile, 'c'.repeat(160), 100);
    assert.ok((await readFile(logFile)).length <= 100);
    assert.ok((await readFile(`${logFile}.1`)).length <= 100);
    assert.deepEqual((await readdir(directory)).sort(), ['bootstrap.log', 'bootstrap.log.1']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('dry-run prints a plan without accessing or creating the project path', async () => {
  const output = [];
  await manageService('install', {
    platform: 'linux',
    projectDir: '/definitely/missing/agygram project',
    nodePath: '/missing/node',
    homeDir: '/missing/home',
    dryRun: true,
    output: (text) => output.push(text),
  });
  assert.match(output.join(''), /action: install/);
  assert.match(output.join(''), /loginctl enable-linger/);
});

test('cross-OS preview uses the target platform PATH instead of the host PATH', () => {
  const plan = buildServicePlan('install', {
    platform: 'linux',
    projectDir: '/opt/agygram',
    nodePath: '/usr/bin/node',
    homeDir: '/home/agygram',
    env: { PATH: '/host-only/path' },
    previewNote: 'cross-OS structural preview',
  });

  assert.match(plan.definition, /PATH=\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/);
  assert.doesNotMatch(plan.definition, /host-only/);
  assert.deepEqual(plan.managerExecutables, {
    systemctl: '/usr/bin/systemctl',
    loginctl: '/usr/bin/loginctl',
  });
});

test('native POSIX plans resolve and pin service managers from the service PATH', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-managers-'));
  const managerName = process.platform === 'darwin' ? 'launchctl' : 'systemctl';
  const managerPath = path.join(directory, managerName);
  try {
    await writeFile(managerPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const plan = buildServicePlan(process.platform === 'linux' ? 'install' : 'status', {
      platform: process.platform,
      projectDir: path.join(directory, 'project'),
      nodePath: process.execPath,
      homeDir: os.homedir(),
      environmentPath: directory,
    });
    const resolved = await realpath(managerPath);
    assert.equal(plan.managerExecutables[managerName], resolved);
    assert.ok(plan.operations
      .filter((operation) => operation.type === 'command')
      .every((operation) => path.isAbsolute(operation.file)));

    if (process.platform === 'linux') {
      assert.equal(plan.managerExecutables.loginctl, undefined);
      assert.ok(!plan.operations.some(
        (operation) => path.basename(operation.file || '') === 'loginctl',
      ));
      assert.match(plan.warnings.join('\n'), /optional linger setup was skipped/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native POSIX plans fail closed when PATH or a required manager is unavailable', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-no-manager-'));
  const common = {
    platform: process.platform,
    projectDir: path.join(directory, 'project'),
    nodePath: process.execPath,
    homeDir: os.homedir(),
  };
  try {
    assert.throws(
      () => buildServicePlan('status', { ...common, env: {} }),
      /PATH is unavailable/,
    );
    assert.throws(
      () => buildServicePlan('status', { ...common, environmentPath: directory }),
      /was not found as an executable in the normalized service PATH/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('service preflight reads control settings from .env and requires absolute agy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-env-'));
  const agyBin = path.join(directory, process.platform === 'win32' ? 'agy.exe' : 'agy');
  const servicePath = [path.dirname(process.execPath), path.parse(process.execPath).root]
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .join(path.delimiter);
  try {
    await writeFile(path.join(directory, '.env'), [
      'BOT_TOKEN=123456:service-token',
      'ALLOWED_CHAT_ID=123456',
      `AGY_BIN=${agyBin}`,
      `PATH=${servicePath}`,
      'NODE_OPTIONS=--require=/tmp/attacker.cjs',
      'LD_PRELOAD=/tmp/attacker.so',
      '',
    ].join('\n'));
    const env = cliPrivate.loadServiceEnvironment(directory, {
      BOT_TOKEN: 'interactive-token-must-not-leak',
      HOME: os.homedir(),
      PATH: process.env.PATH,
    });
    assert.equal(env.BOT_TOKEN, '123456:service-token');
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.LD_PRELOAD, undefined);
    assert.equal(cliPrivate.verifyServiceConfig(directory, env).agyBin, agyBin);

    env.AGY_BIN = 'agy';
    assert.throws(
      () => cliPrivate.verifyServiceConfig(directory, env),
      /absolute executable/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('service .env allowlist covers every application config key', async () => {
  const source = await readFile(path.join(process.cwd(), 'src', 'config.js'), 'utf8');
  const referenced = new Set(
    [...source.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]),
  );
  // LOCALAPPDATA is inherited as a platform environment key rather than an
  // application setting loaded from .env.
  referenced.delete('LOCALAPPDATA');
  assert.deepEqual(
    [...referenced].filter((key) => !cliPrivate.SERVICE_CONFIG_KEYS.has(key)).sort(),
    [],
  );
});

test('Linux service definition honors XDG_CONFIG_HOME and pins DATA_DIR', () => {
  const plan = buildServicePlan('install', {
    platform: 'linux',
    projectDir: '/srv/agygram',
    nodePath: '/usr/bin/node',
    homeDir: '/home/service',
    dataDir: '/var/lib/agygram-user',
    env: { XDG_CONFIG_HOME: '/home/service/.xdg-config' },
    previewNote: 'structural preview',
  });
  assert.equal(
    plan.definitionPath,
    '/home/service/.xdg-config/systemd/user/agygram.service',
  );
  assert.match(plan.definition, /"--data-dir" "\/var\/lib\/agygram-user"/);
});

test('native status dry-run resolves custom DATA_DIR from .env', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-service-data-'));
  const configuredDataDir = path.join(directory, 'private service data');
  const originalWrite = process.stdout.write;
  const output = [];
  try {
    await writeFile(path.join(directory, '.env'), [
      `DATA_DIR=${configuredDataDir}`,
      ...(process.platform === 'win32' ? ['WINDOWS_ACL_VERIFIED=true'] : []),
      '',
    ].join('\n'));
    if (process.platform !== 'win32') await chmod(path.join(directory, '.env'), 0o600);
    process.stdout.write = (value) => {
      output.push(String(value));
      return true;
    };
    await cliMain([
      'service',
      'status',
      '--dry-run',
      '--project-dir',
      directory,
    ]);
    assert.equal(output.length, 1);
    assert.ok(output[0].includes(`data: ${configuredDataDir}`));
  } finally {
    process.stdout.write = originalWrite;
    await rm(directory, { recursive: true, force: true });
  }
});

test('native install and status read an external env file while uninstall uses explicit pins', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-external-env-'));
  const envFile = path.join(directory, 'managed bot.env');
  const configuredDataDir = path.join(directory, 'managed data');
  const ignoredDataDir = path.join(directory, 'project data');
  const agyBin = path.join(directory, process.platform === 'win32' ? 'agy.exe' : 'agy');
  const originalWrite = process.stdout.write;
  const output = [];
  try {
    await writeFile(path.join(directory, '.env'), `DATA_DIR=${ignoredDataDir}\n`);
    await writeFile(envFile, [
      'BOT_TOKEN=123456:service-token',
      'ALLOWED_CHAT_ID=123456',
      `AGY_BIN=${agyBin}`,
      `DATA_DIR=${configuredDataDir}`,
      ...(process.platform === 'win32' ? ['WINDOWS_ACL_VERIFIED=true'] : []),
      '',
    ].join('\n'));
    if (process.platform !== 'win32') {
      await chmod(path.join(directory, '.env'), 0o600);
      await chmod(envFile, 0o600);
    }
    process.stdout.write = (value) => {
      output.push(String(value));
      return true;
    };
    for (const action of ['install', 'status']) {
      await cliMain([
        'service',
        action,
        '--dry-run',
        '--project-dir',
        directory,
        '--config-file',
        envFile,
      ]);
    }
    await cliMain([
      'service',
      'uninstall',
      '--dry-run',
      '--project-dir',
      directory,
      '--config-file',
      envFile,
      '--data-dir',
      configuredDataDir,
    ]);
    assert.equal(output.length, 3);
    assert.ok(output.every((value) => value.includes(`environment: ${envFile}`)));
    assert.ok(output.every((value) => value.includes(`data: ${configuredDataDir}`)));
    assert.ok(output.every((value) => !value.includes(ignoredDataDir)));
    assert.match(output[0], /--config-file/);
    assert.doesNotMatch(output[0], /--env-file/);
  } finally {
    process.stdout.write = originalWrite;
    await rm(directory, { recursive: true, force: true });
  }
});

test('an explicitly selected missing env file is rejected before service lookup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-missing-env-'));
  try {
    await assert.rejects(
      cliMain([
        'service',
        'status',
        '--dry-run',
        '--project-dir',
        directory,
        '--config-file',
        path.join(directory, 'missing.env'),
      ]),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('managed uninstall invocation ignores a missing config and preserves Node option boundary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-uninstall-missing-config-'));
  const missingConfig = path.join(directory, 'removed.env');
  const dataDir = path.join(directory, 'managed data');
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--',
      path.join(process.cwd(), 'bin', 'agygram.js'),
      'service',
      'uninstall',
      '--dry-run',
      '--project-dir',
      directory,
      '--config-file',
      missingConfig,
      '--data-dir',
      dataDir,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_TOKEN: 'must-not-reach-service-manager',
        NODE_OPTIONS: '',
      },
      timeout: 10_000,
    });
    assert.equal(stderr, '');
    assert.match(stdout, new RegExp(
      `environment: ${missingConfig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ));
    assert.match(stdout, new RegExp(
      `data: ${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ));
    await assert.rejects(
      cliMain([
        'service',
        'install',
        '--dry-run',
        '--project-dir',
        directory,
        '--config-file',
        missingConfig,
        '--data-dir',
        dataDir,
      ]),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uninstall never reads a chmod-drifted config, while install remains fail-closed', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-uninstall-config-drift-'));
  const envFile = path.join(directory, 'managed.env');
  const dataDir = path.join(directory, 'managed data');
  const attackerDataDir = path.join(directory, 'attacker-selected-data');
  const originalWrite = process.stdout.write;
  const output = [];
  try {
    await writeFile(envFile, [
      `DATA_DIR=${attackerDataDir}`,
      'DEFAULT_MODE=invalid-if-loaded',
      'BOT_TOKEN=must-not-be-loaded',
      '',
    ].join('\n'), { mode: 0o644 });
    await chmod(envFile, 0o644);
    process.stdout.write = (value) => {
      output.push(String(value));
      return true;
    };

    await cliMain([
      'service',
      'uninstall',
      '--dry-run',
      '--project-dir',
      directory,
      '--config-file',
      envFile,
      '--data-dir',
      dataDir,
    ]);
    assert.equal(output.length, 1);
    assert.match(output[0], new RegExp(
      `data: ${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ));
    assert.doesNotMatch(output[0], new RegExp(
      attackerDataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ));

    await assert.rejects(
      cliMain([
        'service',
        'install',
        '--dry-run',
        '--project-dir',
        directory,
        '--config-file',
        envFile,
        '--data-dir',
        dataDir,
      ]),
      /deny group\/other access/u,
    );
  } finally {
    process.stdout.write = originalWrite;
    await rm(directory, { recursive: true, force: true });
  }
});

test('uninstall service-manager commands receive only the sanitized OS environment', async () => {
  const commandEnvironment = cliPrivate.loadServiceManagerEnvironment({
    HOME: '/safe/home',
    PATH: '/safe/bin',
    XDG_RUNTIME_DIR: '/safe/runtime',
    BOT_TOKEN: 'secret',
    NODE_OPTIONS: '--require=/tmp/attacker.cjs',
    LD_PRELOAD: '/tmp/attacker.so',
  });
  assert.deepEqual(commandEnvironment, {
    HOME: '/safe/home',
    PATH: '/safe/bin',
    XDG_RUNTIME_DIR: '/safe/runtime',
  });

  const calls = [];
  await executeServicePlan({
    operations: [{ type: 'command', file: '/safe/bin/service-manager', args: ['remove'] }],
  }, {
    commandEnvironment,
    async runner(file, args, options) {
      calls.push({ file, args, options });
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.env, commandEnvironment);
  assert.equal(calls[0].options.env.BOT_TOKEN, undefined);
  assert.equal(calls[0].options.env.NODE_OPTIONS, undefined);
});

test('native service-manager commands have a bounded execution time', async () => {
  await assert.rejects(
    spawnCommand(process.execPath, [
      '-e',
      'process.stdout.write("manager stdout"); process.stderr.write("manager stderr"); process.exit(7)',
    ], {
      stdio: 'ignore',
      captureOutput: true,
      timeoutMs: 2_000,
    }),
    (error) => {
      assert.equal(error.exitCode, 7);
      assert.equal(error.signal, null);
      assert.equal(error.stdout, 'manager stdout');
      assert.equal(error.stderr, 'manager stderr');
      return true;
    },
  );
  await assert.rejects(
    spawnCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      timeoutMs: 30,
    }),
    /timed out after 30ms/,
  );
});

test('POSIX service trust audit rejects world-writable executable roots', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-trust-'));
  const nodePath = path.join(directory, 'node');
  const entryPath = path.join(directory, 'index.js');
  try {
    await writeFile(nodePath, 'node');
    await writeFile(entryPath, 'entry');
    await chmod(directory, 0o777);
    await assert.rejects(
      servicePrivate.auditPosixServicePaths({
        platform: 'linux',
        projectDir: directory,
        nodePath,
        entryPath,
        environmentPath: '',
      }),
      /writable by other users/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('POSIX service trust audit includes pinned manager executables', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.agygram-manager-trust-'));
  const managerDirectory = path.join(directory, 'managers');
  const nodePath = path.join(directory, 'node');
  const entryPath = path.join(directory, 'index.js');
  const managerPath = path.join(managerDirectory, 'service-manager');
  try {
    await mkdir(managerDirectory, { mode: 0o700 });
    await writeFile(nodePath, 'node', { mode: 0o700 });
    await writeFile(entryPath, 'entry', { mode: 0o600 });
    await writeFile(managerPath, 'manager', { mode: 0o700 });
    await chmod(managerDirectory, 0o777);
    await assert.rejects(
      servicePrivate.auditPosixServicePaths({
        platform: process.platform,
        projectDir: directory,
        nodePath,
        entryPath,
        managerExecutables: { manager: managerPath },
        managerSearchPath: '',
      }),
      /manager executable path is writable by other users/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('POSIX service trust audit rejects a writable imported runtime module', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agygram-runtime-tree-'));
  const modulePath = path.join(directory, 'imported.js');
  try {
    await writeFile(modulePath, 'export default true;\n', { mode: 0o600 });
    await chmod(modulePath, 0o622);
    await assert.rejects(
      servicePrivate.auditPosixRuntimeTree(directory, {
        uid: process.getuid(),
        trustedGroups: new Set(),
      }),
      /runtime code is writable by other users/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
