import path from 'node:path';

export const SERVICE_NAME = 'antigravity-telegram-cli';
export const LAUNCHD_LABEL = 'dev.antigravity.telegram-cli';
export const WINDOWS_TASK_NAME = 'Antigravity Telegram CLI';

export function buildWindowsTaskControlScript() {
  return `param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Stop', 'Remove', 'Check')]
  [string]$Action,

  [string]$StopRequestPath,

  [string]$LockPath,

  [string]$TaskkillPath
)

$ErrorActionPreference = 'Stop'

function Get-AntigravityTask {
  Get-ScheduledTask -ErrorAction Stop |
    Where-Object { $_.TaskName -eq '${WINDOWS_TASK_NAME}' -and $_.TaskPath -eq '\\' } |
    Select-Object -First 1
}

function Remove-StopRequest {
  if (-not [string]::IsNullOrWhiteSpace($StopRequestPath)) {
    Remove-Item -LiteralPath $StopRequestPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$StopRequestPath.$PID.tmp" -Force -ErrorAction SilentlyContinue
  }
}

function Wait-ForTaskExit([int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $current = Get-AntigravityTask
    if ($null -eq $current -or $current.State -ne 'Running') { return $true }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Get-CandidateLockPaths($RegisteredTask) {
  $candidates = @($LockPath)
  $taskAction = @($RegisteredTask.Actions)[0]
  if ($null -ne $taskAction) {
    $dataMatch = [regex]::Match(
      [string]$taskAction.Arguments,
      '(?:^|\\s)--data-dir\\s+(?:"(?<quoted>[^"]+)"|(?<bare>\\S+))',
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if ($dataMatch.Success) {
      $registeredDataDir = if ($dataMatch.Groups['quoted'].Success) {
        $dataMatch.Groups['quoted'].Value
      } else {
        $dataMatch.Groups['bare'].Value
      }
      $candidates += [System.IO.Path]::Combine($registeredDataDir, 'bot.lock')
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$taskAction.WorkingDirectory)) {
      $candidates += [System.IO.Path]::Combine(
        [string]$taskAction.WorkingDirectory,
        'data',
        'bot.lock'
      )
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidates += [System.IO.Path]::Combine($env:LOCALAPPDATA, 'agygram', 'data', 'bot.lock')
  }
  return @($candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

function Test-ProcessMatchesTaskAction($CandidateProcess, $TaskAction) {
  if ($null -eq $CandidateProcess -or
      [string]::IsNullOrWhiteSpace($CandidateProcess.ExecutablePath) -or
      [string]::IsNullOrWhiteSpace($CandidateProcess.CommandLine)) {
    return $false
  }
  if (-not [string]::Equals(
    [System.IO.Path]::GetFullPath($CandidateProcess.ExecutablePath),
    [System.IO.Path]::GetFullPath([string]$TaskAction.Execute),
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    return $false
  }
  return $CandidateProcess.CommandLine.IndexOf(
    [string]$TaskAction.Arguments,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -ge 0
}

function Get-VerifiedLockOwnerProcess($RegisteredTask) {
  $taskAction = @($RegisteredTask.Actions)[0]
  if ($null -eq $taskAction -or
      [string]::IsNullOrWhiteSpace([string]$taskAction.Execute) -or
      [string]::IsNullOrWhiteSpace([string]$taskAction.Arguments)) {
    throw 'The registered task action cannot be verified for process-tree termination.'
  }

  foreach ($candidateLockPath in (Get-CandidateLockPaths $RegisteredTask)) {
    if (-not (Test-Path -LiteralPath $candidateLockPath -PathType Leaf)) { continue }
    $lockFile = Get-Item -LiteralPath $candidateLockPath -Force -ErrorAction Stop
    if ($lockFile.Length -gt 4096 -or
        (($lockFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      continue
    }
    try {
      $owner = Get-Content -LiteralPath $candidateLockPath -Raw -ErrorAction Stop |
        ConvertFrom-Json -ErrorAction Stop
    } catch {
      continue
    }
    $ownerPid = [int64]$owner.pid
    if ($owner.version -ne 1 -or $ownerPid -lt 1 -or
        [string]::IsNullOrWhiteSpace([string]$owner.token) -or
        ([string]$owner.token).Length -lt 8) {
      continue
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop |
      Select-Object -First 1
    if ($null -eq $process) { continue }
    if (-not (Test-ProcessMatchesTaskAction $process $taskAction)) {
      throw 'The lock owner command line does not match the registered task action.'
    }
    try {
      $lockCreated = [DateTime]::Parse(
        [string]$owner.createdAt,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
      ).ToUniversalTime()
      $processCreated = ([DateTime]$process.CreationDate).ToUniversalTime()
    } catch {
      throw 'The lock/process creation window cannot be verified.'
    }
    if ([Math]::Abs(($lockCreated - $processCreated).TotalMinutes) -gt 10) {
      throw 'The lock owner creation time does not match the registered task process.'
    }
    return $process
  }

  # A pre-upgrade task or a task whose DATA_DIR changed may not have a lock in
  # any current candidate path. The registered action still supplies a stable
  # executable+argv identity. Only an unambiguous exact action match is safe.
  $matchingProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object { Test-ProcessMatchesTaskAction $_ $taskAction })
  if ($matchingProcesses.Count -gt 1) {
    throw 'Multiple processes match the registered task action; refusing a broad tree kill.'
  }
  if ($matchingProcesses.Count -eq 1) { return $matchingProcesses[0] }
  return $null
}

if ($Action -ne 'Check') {
  if ([string]::IsNullOrWhiteSpace($StopRequestPath) -or
      -not [System.IO.Path]::IsPathRooted($StopRequestPath)) {
    throw 'StopRequestPath must be an absolute path for Stop and Remove.'
  }
  foreach ($requiredPath in @($LockPath, $TaskkillPath)) {
    if ([string]::IsNullOrWhiteSpace($requiredPath) -or
        -not [System.IO.Path]::IsPathRooted($requiredPath)) {
      throw 'LockPath and TaskkillPath must be absolute.'
    }
  }
}

$task = Get-AntigravityTask

if ($null -eq $task) {
  if ($Action -ne 'Check') {
    Remove-StopRequest
    exit 0
  }
  throw 'The freshly registered Antigravity task was not found.'
}

if ($Action -eq 'Check') {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ($task.State -ne 'Running' -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
    $task = Get-AntigravityTask
  }
  if ($null -eq $task -or $task.State -ne 'Running') {
    throw "Antigravity task did not become ready (state: $($task.State))."
  }
  Start-Sleep -Seconds 1
  $task = Get-AntigravityTask
  if ($null -eq $task -or $task.State -ne 'Running') {
    throw "Antigravity task did not remain running (state: $($task.State))."
  }
  exit 0
}

if ($task.State -eq 'Running') {
  $requestDirectory = Split-Path -Parent $StopRequestPath
  [System.IO.Directory]::CreateDirectory($requestDirectory) | Out-Null
  $requestedAt = [DateTime]::UtcNow
  $request = [ordered]@{
    version = 1
    requestedAtUtc = $requestedAt.ToString('o')
    expiresAtUtc = $requestedAt.AddMinutes(2).ToString('o')
    requestId = [Guid]::NewGuid().ToString('D')
  } | ConvertTo-Json -Compress
  $temporaryRequest = "$StopRequestPath.$PID.tmp"
  try {
    [System.IO.File]::WriteAllText(
      $temporaryRequest,
      $request,
      [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryRequest -Destination $StopRequestPath -Force

    # The Node process consumes the request, asks LifecycleController to cancel
    # active agy/auth work, and exits. Task Scheduler state is the cross-process
    # acknowledgement. Retain a bounded hard-terminate fallback for a hung or
    # pre-upgrade process that does not understand the request.
    if (-not (Wait-ForTaskExit 30)) {
      # Stop-ScheduledTask is not documented to terminate descendants. When
      # the private instance lock still identifies this exact Node executable,
      # entry path, and creation window, taskkill /T closes the whole tree.
      $ownerProcess = Get-VerifiedLockOwnerProcess $task
      if ($null -ne $ownerProcess) {
        & $TaskkillPath /PID ([string]$ownerProcess.ProcessId) /T /F | Out-Null
        $taskkillExitCode = $LASTEXITCODE
        $remainingOwner = Get-CimInstance Win32_Process -Filter (
          "ProcessId = $($ownerProcess.ProcessId)"
        ) -ErrorAction Stop | Select-Object -First 1
        if ($taskkillExitCode -ne 0 -or $null -ne $remainingOwner) {
          throw "taskkill process-tree termination failed (exit code: $taskkillExitCode)."
        }
      }
      $task = Get-AntigravityTask
      if ($null -ne $task -and $task.State -eq 'Running') {
        Stop-ScheduledTask -InputObject $task -ErrorAction Stop
      }
      if (-not (Wait-ForTaskExit 15)) {
        throw 'Timed out waiting for the existing Antigravity task to stop.'
      }
    }
  } finally {
    Remove-StopRequest
  }
}
if ($Action -eq 'Remove') {
  $task = Get-AntigravityTask
  if ($null -eq $task) { exit 0 }
  Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop
}
`;
}

function assertTemplateValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} cannot contain control characters`);
  }
  return value;
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Quote one systemd directive argument. systemd parses this itself; no shell is
 * involved. Percent signs are doubled so paths cannot become specifiers.
 * Exec*= directives additionally need literal dollar escaping.
 */
export function systemdQuote(value, { escapeDollar = false } = {}) {
  const checked = assertTemplateValue(value, 'systemd value');
  return `"${checked
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => (escapeDollar ? '$$' : '$'))}"`;
}

/** Quote a single argv item using CommandLineToArgvW-compatible rules. */
export function windowsQuoteArg(value) {
  const checked = assertTemplateValue(value, 'Windows argument');
  if (!/[\s"]/u.test(checked)) return checked;

  let result = '"';
  let slashes = 0;
  for (const character of checked) {
    if (character === '\\') {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      result += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    result += '\\'.repeat(slashes) + character;
    slashes = 0;
  }
  result += '\\'.repeat(slashes * 2) + '"';
  return result;
}

export function buildLaunchdPlist({
  nodePath,
  entryPath,
  entryArguments = [],
  projectDir,
  stdoutPath,
  stderrPath,
  environmentPath = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
}) {
  for (const [name, value] of Object.entries({
    nodePath,
    entryPath,
    projectDir,
    stdoutPath,
    stderrPath,
    environmentPath,
  })) assertTemplateValue(value, name);
  for (const value of entryArguments) assertTemplateValue(value, 'entry argument');

  const extraArguments = entryArguments
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(entryPath)}</string>
${extraArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${xmlEscape(environmentPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`;
}

export function buildSystemdUnit({
  nodePath,
  entryPath,
  entryArguments = [],
  projectDir,
  environmentPath = '/usr/local/bin:/usr/bin:/bin',
}) {
  for (const [name, value] of Object.entries({
    nodePath,
    entryPath,
    projectDir,
    environmentPath,
  })) {
    assertTemplateValue(value, name);
  }
  for (const value of entryArguments) assertTemplateValue(value, 'entry argument');
  const argumentsLine = [entryPath, ...entryArguments]
    .map((value) => systemdQuote(value, { escapeDollar: true }))
    .join(' ');

  return `[Unit]
Description=Antigravity Telegram CLI Bot
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(projectDir)}
ExecStart=${systemdQuote(nodePath, { escapeDollar: true })} ${argumentsLine}
Environment=NODE_ENV=production
Environment=${systemdQuote(`PATH=${environmentPath}`)}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=45s
KillSignal=SIGTERM
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export function buildWindowsTaskXml({
  nodePath,
  entryPath,
  entryArguments = [],
  projectDir,
  userId,
}) {
  for (const [name, value] of Object.entries({ nodePath, entryPath, projectDir, userId })) {
    assertTemplateValue(value, name);
  }
  for (const value of entryArguments) assertTemplateValue(value, 'entry argument');

  const argumentsLine = [entryPath, ...entryArguments].map(windowsQuoteArg).join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Headless Telegram controller for Antigravity CLI</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
      <Delay>PT10S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="CurrentUser">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="CurrentUser">
    <Exec>
      <Command>${xmlEscape(nodePath)}</Command>
      <Arguments>${xmlEscape(argumentsLine)}</Arguments>
      <WorkingDirectory>${xmlEscape(projectDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function platformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export const _private = { assertTemplateValue };
