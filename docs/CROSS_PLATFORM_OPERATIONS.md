# Cross-platform installation and service operation

The supported runtime families are macOS (`darwin`), Linux (`linux`), and Windows (`win32`) on a currently supported Node.js LTS release (Node.js 22 or 24 at this release). The bot application is shared; service installation uses each operating system's native current-user supervisor.

The source checkout exposes the operations CLI directly:

```text
node bin/agygram.js doctor
node bin/agygram.js service install --dry-run
node bin/agygram.js service install
node bin/agygram.js service status
node bin/agygram.js service uninstall
```

`service install` runs `doctor` first and does not change the service when the check fails. A native-OS `--dry-run` reads the same `.env` and prints the exact definition and operation argv without writing files or invoking a service manager. A cross-OS `--platform` preview is structural because it cannot read the target machine's `.env` or PATH, and the CLI labels it accordingly. Service-manager commands and the bot process use direct argv with `shell: false`.

## Shared preflight

1. Install a supported Node.js LTS (22 or 24) for the account that will own the service.
2. Install Antigravity CLI for that same account. This integration was locally verified with `agy 1.1.1`.
3. Run `npm ci` in the source checkout.
4. Copy `.env.example` to `.env`, restrict access, and configure the Telegram IDs, owner, workspace, and an absolute `AGY_BIN`.
5. Run `npm run doctor` and `npm test`.
6. Run `node bin/agygram.js service install --dry-run` and inspect the definition.
7. Install the service, then complete `/auth` from the allowed private owner chat.

### Initial OAuth on a headless POSIX host

`agy` 1.1.1 currently applies an internal 30-second limit to OAuth started via
its non-interactive `--print` transport; increasing `AGY_AUTH_TIMEOUT_MS` does
not change that limit. On a macOS or Linux server with `tmux` installed, set
`AGY_AUTH_TRANSPORT=tmux` in the bot's private `.env` and restart the service.
The bot then creates a short-lived, private TTY solely for `/auth`, relays its
OAuth URL and code input through the allowed owner chat, and destroys that TTY
when the flow ends. Ordinary agent tasks remain direct, non-shell `agy`
processes. Leave the variable unset when `tmux` is unavailable.

`doctor` checks configuration, Node/platform details, data/workspace access, POSIX `.env` privacy, safe executable resolution, `agy --version`, model catalog access, and the presence of a Linux D-Bus session variable. A model catalog result does not prove OAuth validity; `/auth` verifies it with a real plan-mode headless request. Native service installation reads control settings from the checkout's `.env` in a reduced preflight environment and requires `agy` to resolve to an absolute executable; do not rely on an interactive-only alias or relative command.

On POSIX hosts, install resolves and audits every path component for the checkout,
Node, `agy`, service entry, and every PATH directory. Missing entries, unrelated
owners, other-writable components, and unapproved group-writable components fail
closed. A group-writable tool directory is accepted only when its numeric gid is
explicitly listed in `TRUSTED_SERVICE_GROUP_GIDS` after membership review.
Windows path validation cannot prove NTFS DACL ownership, so startup requires the
operator's `WINDOWS_ACL_VERIFIED=true` attestation after restricting both `.env`
and the complete DATA_DIR with `icacls.exe`.

The native definition contains absolute paths to Node and the checkout. Reinstall after moving the project or replacing/removing the selected Node executable, which is common with version managers.

## Secret-file permissions

On macOS/Linux, protect `.env` immediately after copying it:

```sh
install -m 600 .env.example .env
```

`doctor` rejects a POSIX `.env` that is a symbolic link or grants group/other permission. It also expects the data directory to be private (`0700`).

On Windows, use an ACL rather than `chmod`:

```powershell
Copy-Item .env.example .env
$account = "$env:USERDOMAIN\$env:USERNAME"
# Edit DATA_DIR first. For a custom DATA_DIR, replace this default with its
# exact resolved absolute path before applying the ACL.
notepad.exe .env
$dataDir = Join-Path $env:LOCALAPPDATA 'agygram\data'
New-Item -ItemType Directory -Force $dataDir | Out-Null
icacls.exe .env /inheritance:r
icacls.exe .env /grant:r "${account}:(F)"
icacls.exe $dataDir /inheritance:r
icacls.exe $dataDir /grant:r "${account}:(OI)(CI)(F)"
icacls.exe .env
icacls.exe $dataDir
```

Review both ACLs, then set `WINDOWS_ACL_VERIFIED=true` in `.env`. If `DATA_DIR` is customized, `$dataDir` must name that same resolved absolute path; hardening only the default directory is not sufficient. Domain policy, backup software, and administrators can still have effective access outside the discretionary ACL model.

## OS-user and credential model

The installer intentionally creates a **current-user** service. It does not install a privileged system daemon, copy `.env` into a service definition, or save a login password. The service working directory remains the checkout, where `dotenv` reads `.env`.

This identity choice is required for `agy` to see the same home directory and OS credential store. It also defines the security boundary:

- one OS user/keyring provides one effective Antigravity account to all allowed chats/topics;
- OAuth must be performed for the same account/environment that runs the service;
- another process under the same UID is not isolated from the bot merely because it is called a gateway or runner;
- real separation requires another OS identity or isolated VM/container and separate credentials.

Run the service as a dedicated, low-privilege account with access only to intended workspace roots.

## macOS: launchd LaunchAgent

Service definition:

```text
~/Library/LaunchAgents/dev.antigravity.telegram-cli.plist
```

Behavior:

- installed with `launchctl bootstrap gui/<uid>` and started with `kickstart`;
- `RunAtLoad=true`;
- restarted after non-zero exit with a 10-second throttle;
- runs with a `0077` umask;
- launches the bounded file-log bootstrap, then the bot;
- writes `<absolute DATA_DIR>/logs/service.log` and retains one `service.log.1` generation, each up to approximately 10 MiB.

A LaunchAgent belongs to a GUI login domain. It can operate without an IDE and while the session is active, but it does not start before that user logs in. Installing over SSH without an active GUI domain can fail. A pre-login LaunchDaemon would use a different administrative/Keychain model and is not created by this project.

Status and logs:

```sh
node bin/agygram.js service status
tail -F '<absolute DATA_DIR>/logs/service.log'
```

If Keychain access prompts require UI or remain locked, fix the service account's Keychain policy; the bot does not store a Keychain password or unlock it.

## Linux: systemd user service

Service definition:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/antigravity-telegram-cli.service
```

Behavior:

- enables the unit, restarts it on every install, then verifies it remains active;
- `Restart=on-failure` with a five-second delay;
- 45-second stop timeout and SIGTERM shutdown;
- `UMask=0077` and `NoNewPrivileges=true`;
- passes the resolved absolute `DATA_DIR` as a direct service argv item;
- logs to the user journal;
- installation attempts `loginctl enable-linger` unless `--no-linger` is supplied.

Linger lets the user manager start at boot and remain after logout. Some distributions require administrator/policy approval; failure is reported as a warning and installation continues for the current user session. Uninstall does not disable linger because other user services may rely on it.

When `XDG_CONFIG_HOME` is set in the installer environment, the unit is written below that directory. Reinstall after changing `XDG_CONFIG_HOME` or `DATA_DIR`.

Status and logs:

```sh
node bin/agygram.js service status
journalctl --user -u antigravity-telegram-cli -f
```

### Headless Linux credential persistence

`agy` credential persistence may depend on a Secret Service implementation and D-Bus session. A successful OAuth in an interactive shell does not guarantee that a boot-time user service sees the same unlocked credential service.

Check the service environment and logs if authentication disappears after restart. `DBUS_SESSION_BUS_ADDRESS` and any needed `XDG_RUNTIME_DIR` must reach the user service/credential process. Package names and unlock policy vary by distribution; this project does not install or unlock a keyring automatically.

Linux without systemd/logind—some containers, WSL configurations, and non-systemd distributions—cannot use this backend. Run `npm start` under that environment's own supervisor, preserving the same user, home, `.env`, and credential-store environment. The provided installer does not claim to configure those alternatives.

## Windows: Task Scheduler

Stored definition copy (`DATA_DIR` is resolved to an absolute path at install time):

```text
<absolute DATA_DIR>\runtime\service\antigravity-telegram-cli.xml
```

The same private runtime directory also holds a PATH/`NODE_ENV` snapshot
and a fixed PowerShell task-control helper. Neither file contains `.env` or bot
credentials.

Task name:

```text
Antigravity Telegram CLI
```

Behavior:

- binds to the current user with `InteractiveToken` and least privilege;
- triggers 10 seconds after that user's logon and is also started immediately at installation;
- ignores ordinary duplicate triggers, while reinstall writes a short-lived private stop request, lets the bot's lifecycle controller cancel active agy/auth work, and waits for the old task to exit before registering and checking the replacement; after 30 seconds it validates the private instance lock and currently registered task action, uses pinned `taskkill.exe /T /F` for the process tree, then applies Task Scheduler termination and a bounded 15-second exit check;
- retries a failed process up to ten times, one minute apart;
- launches the bounded file-log bootstrap;
- writes `<absolute DATA_DIR>\logs\service.log` and keeps one `service.log.1` generation, each up to approximately 10 MiB;
- stores no Windows account password.

The task can continue while the session is locked, but it cannot run before the first user logon after reboot. A passwordless pre-login task would not preserve the same interactive credential/network behavior, and the installer does not silently change identity or save a password.

Status and log inspection from PowerShell:

```powershell
node bin/agygram.js service status
Get-Content 'C:\absolute\DATA_DIR\logs\service.log' -Wait
```

### Native `agy.exe` is mandatory

The Windows process layer accepts only a native `.exe`. It rejects `.cmd`, `.bat`, and `.ps1`, including a package-manager shim found when resolving `agy`, because those formats require a command shell. The failure is intentional and occurs in `doctor` before service installation.

Find and configure the native binary explicitly:

```powershell
Get-Command agy.exe
```

```dotenv
AGY_BIN=C:\Users\<Username>\AppData\Local\agy\bin\agy.exe
```

If `Get-Command agy.exe` fails and only `Get-Command agy.cmd` succeeds, the host does not yet meet this project's Windows runtime requirement.

The generated Task Scheduler XML uses Windows argv quoting for the JavaScript entry and absolute `DATA_DIR` arguments, so spaces are supported. Task Scheduler path fields are conservatively limited to 260 characters; installation fails before writing the task when the Node, project, data, entry, helper, or definition path exceeds that bound. Reinstall after changing `DATA_DIR`; native status/uninstall read the checkout's `.env` to locate the same private service runtime directory.

## OAuth operation

`/auth` is owner-only and private-chat-only by default. The bot starts `agy` with stdin/stdout pipes and environment hints that select the remote/SSH-style URL-and-code flow. A browser is still needed somewhere to visit the URL; it does not have to run on the bot host.

The OAuth code is sent to `agy` stdin, retained briefly in memory for output redaction, and the source Telegram message is deleted on a best-effort basis. Telegram has already carried the code, so message deletion is not an erasure guarantee. The resulting credential belongs to the current OS user and its keyring.

## Upgrade, relocation, and rollback

For an in-place source update:

```text
npm ci
npm test
npm run doctor
node bin/agygram.js service install --dry-run
node bin/agygram.js service install
```

The install action replaces/reloads the current-user definition. Keep a backup of the checkout and `data` before upgrade. The service installer does not migrate, delete, or back up session/job data.

Native manager commands have bounded execution time and installation performs a short post-start readiness check. Installation is not a cross-manager transaction: a host failure or policy error between native operations can leave a new definition that is not running. The CLI reports failure rather than claiming success; fix the reported cause and rerun install, or run uninstall before restoring a backed-up checkout.

After relocating the checkout, run service installation from the new directory. Then remove any old definition if it was installed under a different user/home. A stale definition continues to point at the old absolute Node and project paths.

`service uninstall` removes/disables the native definition and task, but deliberately leaves these items untouched:

- `.env`;
- `data` state, journals, uploads, and logs;
- workspaces and agent-created changes;
- Antigravity credentials in the OS keyring;
- Linux linger state.

Delete or revoke them separately only after deciding what must be retained.

## Failure and recovery checklist

1. Run `npm run doctor` as the exact service user.
2. Inspect the native service status and the platform log above.
3. Verify the pinned Node path still exists and reports a supported Node.js LTS.
4. Verify `AGY_BIN` resolves to the intended binary; on Windows it must be `agy.exe`.
5. Verify `.env`, `data`, workspace, and credential-store permissions for that user.
6. Send `/status` and `/jobs`. An active job with durable completion evidence is recovered as `succeeded` with delivery pending; otherwise it remains `interrupted`.
7. Use `/last` for a recovered success or when Telegram result delivery was lost or partial. If native continuity was not committed, the bot forces the next request into a new project.
8. Inspect filesystem changes before choosing `/retry`; an unproven interrupted coding job may already have partially changed files.

If jobs are rejected before enqueue, inspect `MAX_PENDING_AGY_JOBS` and `MAX_PENDING_AGY_JOBS_PER_USER`. If a journaled job fails without starting `agy`, inspect `AGY_QUEUE_TIMEOUT_MS` and `/status`; the default global concurrency is one process. Raising concurrency does not remove the canonical-workspace mutex.

If logs report `JOB_UPDATE_LEDGER_FULL`, polling deliberately stops without confirming the prefetched Telegram batch. Increase the dedupe count/byte limits consistently with the validation formula in `.env.example`, or wait for the configured retention window to expire, then restart the service. This fail-closed behavior prefers redelivery over executing an update whose durable decision could not be recorded.

Only one bot process may use a data directory. `data/bot.lock` rejects an accidental manual-plus-service duplicate and reclaims a verifiably stale owner. Do not deploy the same data directory as active/active storage across machines.

## Observability limits

The current headless print integration does not expose a documented structured stream of live tool events. `/status` is limited to bot-observed phases and the process can appear as `running-agy` for most of a long request. Typing indicators are liveness hints. Logs and status must not be interpreted as token-level, tool-level, or percentage progress telemetry.
