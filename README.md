# Antigravity Telegram CLI Bot

> 한국어 문서: [README.ko.md](README.ko.md)

A headless Telegram controller for Google Antigravity CLI (`agy`). It runs without an IDE and is designed for macOS, Linux, and Windows using the same Node.js application, with native per-user service integration on each operating system.

This is a trusted-operator tool, not a hostile multi-tenant execution service. Telegram users that can reach the bot are able to ask a coding agent to act in an allowed workspace. Start with the safe defaults, use a dedicated OS account, and grant access only to people you trust.

## What is implemented

- Shell-free `agy` execution with bounded time, output, and Windows command-line size.
- Safe defaults: `plan` mode, sandbox enabled, and unsandboxed runs rejected unless explicitly enabled.
- Chat/user allowlists plus owner-only OAuth; group deployments fail closed without a user allowlist and explicit owner.
- Independent sessions for Telegram forum topics, including state, jobs, uploads, and reply routing.
- Native `agy --conversation` continuation recovered from a private per-run CLI log when the tested log contract is present.
- A bounded transcript fallback if that undocumented metadata contract is unavailable.
- Durable Telegram update journal, duplicate `update_id` suppression, cross-store crash reconciliation, and explicit retry only when completion cannot be proven.
- Durable per-user/global rolling job limits and UTC-day runtime budgets with conservative crash accounting.
- Bounded global/per-user admission, queue timeout, per-workspace serialization, per-session cancellation, and a single-process data-directory lock.
- Per-upload job directories, file/total quotas, expiry cleanup, and only the current upload directory passed through `--add-dir`.
- Bounded Telegram delivery retries for results (429, 5xx, and transient network failures), with `/last` as recovery for an ambiguous or partial delivery.
- Native current-user service management: launchd on macOS, systemd user services on Linux, and Task Scheduler on Windows.

## Requirements and compatibility

- A currently supported Node.js LTS release: **Node.js 22 or 24**.
- A Telegram bot token and numeric chat/user IDs.
- An installed Antigravity CLI available to the service account.
- A working credential store for that same OS account.

The implementation and native conversation-resume path were locally verified with `agy 1.1.1`. The per-run log strings used to recover conversation/project UUIDs are not a documented structured API, so a later CLI can change them. The bot fails back to bounded local transcript context instead of trusting model output. `/apply` intentionally refuses to continue a plan when no native conversation ID was recovered.

Check the local tools before installation:

```text
node --version
agy --version
agy models
```

`agy models` is a binary/path check, not proof that OAuth is valid. Authentication is confirmed only by an actual headless request or `/auth`.

### Windows executable requirement

Windows must provide a native `agy.exe`. This project deliberately rejects `.cmd`, `.bat`, and `.ps1` launchers, including an npm `.cmd` shim found under the bare name `agy`, because safely invoking them would require a command shell. Configure the absolute native executable when needed:

```dotenv
AGY_BIN=C:\Users\<Username>\AppData\Local\agy\bin\agy.exe
```

If only `agy.cmd` exists, startup and `doctor` fail closed. Install or locate the native `agy.exe`; do not point `AGY_BIN` at the shim.

## Install from a source checkout

Do not copy a production `.env` from another machine. Create it locally and protect it before adding secrets.

### macOS and Linux (POSIX shell)

```sh
git clone https://github.com/parkjangwon/antigravity-telegram-cli.git
cd antigravity-telegram-cli
node --version
agy --version
npm ci
install -m 600 .env.example .env
${EDITOR:-vi} .env
npm run doctor
npm test
npm start
```

### Windows (PowerShell)

```powershell
git clone https://github.com/parkjangwon/antigravity-telegram-cli.git
Set-Location antigravity-telegram-cli
node --version
agy.exe --version
npm ci
Copy-Item .env.example .env
$account = "$env:USERDOMAIN\$env:USERNAME"
# Edit DATA_DIR first. If you set a custom value, replace $dataDir below with
# that exact resolved absolute path before granting the ACL.
notepad.exe .env
$dataDir = Join-Path $env:LOCALAPPDATA 'agygram\data'
New-Item -ItemType Directory -Force $dataDir | Out-Null
icacls.exe .env /inheritance:r
icacls.exe .env /grant:r "${account}:(F)"
icacls.exe $dataDir /inheritance:r
icacls.exe $dataDir /grant:r "${account}:(OI)(CI)(F)"
icacls.exe .env
icacls.exe $dataDir
npm run doctor
npm test
npm start
```

`install -m 600` creates the POSIX secret file with private permissions from the start. Windows does not use POSIX modes; the `icacls` commands restrict both `.env` and the complete data tree. If `DATA_DIR` is customized, `$dataDir` must be the same resolved absolute directory—not the default shown above. Review both ACLs, then set `WINDOWS_ACL_VERIFIED=true` in `.env`; Windows startup and `doctor` fail closed without that operator attestation.

At minimum, set:

```dotenv
BOT_TOKEN=123456:replace-me
ALLOWED_CHAT_IDS=858588087
OWNER_USER_IDS=858588087
WORKSPACE_DIR=/absolute/path/to/a/project
AGY_BIN=/absolute/path/to/agy
```

On Windows, use Windows absolute paths and set `AGY_BIN=C:\absolute\path\to\agy.exe`. Native service preflight requires `agy` to resolve to an absolute executable; an explicit value makes service behavior independent of an interactive shell's PATH. For a group or supergroup, its chat ID is negative and `ALLOWED_USER_IDS` is required:

```dotenv
ALLOWED_CHAT_IDS=858588087,-1001234567890
ALLOWED_USER_IDS=858588087,123456789
OWNER_USER_IDS=858588087
```

With exactly one allowed private chat and no `ALLOWED_USER_IDS`, that private user is inferred as the owner. In every multi-user or group setup, `OWNER_USER_IDS` is mandatory and must be a subset of the allowed users. Only an owner can run `/auth`.

See [.env.example](.env.example) for every limit and policy setting.

## First run and OAuth

1. Run `npm run doctor`, then start the bot with `npm start` or install the native service.
2. Send `/start` from an allowed Telegram chat.
3. In an allowed **private** owner chat, send `/auth`.
4. Open the URL on any browser, finish OAuth, and send the returned code as a plain Telegram message.
5. The bot passes the code to `agy` over stdin, tries to delete the Telegram message, and verifies the login with a plan-mode headless request.

`AUTH_PRIVATE_ONLY=true` and `AUTH_FORCE_REMOTE=true` are the defaults. The bot never reads or writes an Antigravity token file. Credential persistence belongs to `agy` and the OS credential store.

One OS user/keyring means one effective `agy` account for this bot. Every allowed chat and forum topic shares it. Adding more Telegram owners does not create separate Antigravity identities; an owner who reauthenticates changes the account used by everyone running under that OS user.

## Telegram commands

| Command | Behavior |
|---|---|
| `/plan <request>` | Run a one-shot plan-mode request without changing the stored mode. |
| `/apply [extra instructions]` | Continue the last successful `/plan` in native conversation, in `accept-edits` mode and sandbox by default. |
| `/status` | Show local queue/run phase and elapsed time, or the last recorded job. |
| `/last` | Redeliver the last stored successful `agy` response. |
| `/jobs` | List the ten most recent durable jobs for this session. |
| `/retry <job ID>` | Retry a failed, cancelled, or interrupted non-mutating job. Mutating jobs require `/retry <ID> confirm` after inspecting partial changes. |
| `/new` | Clear conversation context and use `--new-project` on the next request. |
| `/model [name\|default]` | List actual `agy models`, select one, or return to the CLI default. |
| `/agent [name\|default]` | List actual `agy agents`, select one, or return to the CLI default. |
| `/mode [plan\|code]` | Read or change the persistent mode (`code` maps to `accept-edits`). |
| `/sandbox [on\|off]` | Show or explicitly set the session setting; `off` is rejected unless unsandboxed runs are enabled by policy. |
| `/workspace [path]` | Show or select a real path inside an allowed workspace root. Switching resets conversation context. |
| `/project [ID\|clear]` | Select or clear an explicit `agy` project and reset conversation context. |
| `/info` | Show effective workspace, continuity mode, model, agent, mode, sandbox policy, and activity. |
| `/auth` | Start/restart headless OAuth; owner-only and private-chat-only by default. |
| `/cancel` | Cancel the current session's request or authentication process. |
| `/reset` | Reset this session and remove its uploads; OS credentials remain untouched. |
| `/help` | Show command help. |

Plain text schedules a prompt. A document or photo is downloaded into a new per-job directory and its directory is added to that invocation only.

In a Telegram forum, the session key is `chat_id:message_thread_id`. Conversation state, jobs, uploads, and responses remain in that topic. Topics can still point at the same workspace and share the same OS credential; writes to the same canonical workspace are serialized.

## Safety defaults and opt-outs

The shipped policy is:

```dotenv
DEFAULT_MODE=plan
DEFAULT_SANDBOX=true
SANDBOX_PLAN_APPLY=true
ALLOW_UNSANDBOXED_RUNS=false
ALLOW_UNSANDBOXED_AUTO_APPROVE=false
```

When `ALLOW_UNSANDBOXED_RUNS=false`, the execution layer forces sandbox on even if old state or a command requests it off. In sandbox mode, the wrapper uses:

```text
--sandbox --dangerously-skip-permissions
```

The permission bypass is scoped to what the `agy` sandbox actually contains; this project does not claim that the sandbox is an independently audited security boundary. Keep the workspace narrow, use backups, and run the bot as a dedicated low-privilege account.

To permit any unsandboxed agent run, an administrator must deliberately set:

```dotenv
ALLOW_UNSANDBOXED_RUNS=true
```

Unsandboxed automatic permission bypass is a separate, higher-risk opt-in and cannot be enabled unless unsandboxed runs are also enabled:

```dotenv
ALLOW_UNSANDBOXED_AUTO_APPROVE=true
```

## Conversation continuity

For each prompt, the bot creates a private `data/runtime/agy/<timestamp>-<uuid>.log` and passes it as `agy --log-file`. It accepts conversation/project UUIDs only from exact CLI-owned log lines seen with the locally tested `agy 1.1.1`; UUID-like model output is never trusted. The log is mode `0600` where POSIX permissions apply and is deleted after parsing by default.

This log format is undocumented. If it is absent or changes, the bot includes a bounded per-session user/assistant transcript in the next `--print` argument. It never uses a machine-global `--continue`, which could mix chats. Set `AGY_CAPTURE_RUN_METADATA=false` to disable the native-ID parser deliberately. `/info` shows whether the session is using a native conversation or transcript fallback.

Retained/crash-left logs are cleaned at startup and hourly by age and total quota. `AGY_KEEP_RUN_LOGS=false` is recommended because run logs can contain private operational data.

## Durable jobs, delivery, and uploads

`data/jobs.json` is an atomic bounded journal keyed by Telegram `update_id`. A duplicate update does not enqueue a second coding action. On startup, jobs left as `queued` or `running` are first marked `interrupted` and are never replayed automatically. Before accepting Telegram updates, the bot reconciles the journal with the result and session stores. An exact completed-state marker plus its result is restored as `succeeded` with delivery pending. A result committed just before a crash is also restored as `succeeded`, but native conversation/project continuity is cleared and the next request starts a new project because those IDs were not durably committed. If completion cannot be proven, the job remains `interrupted` for explicit inspection and `/retry`. All restart candidates are pinned until this reconciliation finishes, so history compaction cannot discard one midway.

Admission is bounded before journaling by `MAX_PENDING_AGY_JOBS` and `MAX_PENDING_AGY_JOBS_PER_USER`, with at most one admitted job per chat/topic. An admitted job waiting for the global execution semaphore fails after `AGY_QUEUE_TIMEOUT_MS`. Stale Telegram backlog older than `MAX_UPDATE_AGE_SECONDS` is not executed. Each newly enqueued job pins its workspace, conversation/project, model, agent, mode, sandbox, transcript digest, session-lifetime generation, and execution revision; execution is blocked if that context changed. Harmless touches and delivery bookkeeping do not invalidate a job, while reset/recreation always changes the generation. External filesystem edits are not a cryptographic snapshot, so a mutating retry requires an extra `confirm`.

Immediately before an `agy` child starts, `data/usage.json` atomically enforces per-user and global job counts over `USAGE_WINDOW_MINUTES`, plus per-user and global accumulated runtime budgets for the UTC day. The complete `AGY_TIMEOUT_MS` is reserved first, preventing concurrent runs from oversubscribing a budget, and is replaced by measured runtime after success, failure, or cancellation. If the process crashes with an active reservation, startup conservatively charges the full reservation. Usage-store read/write or size errors fail closed: no new `agy` process starts. Configure the `MAX_AGY_*_PER_WINDOW`, `MAX_AGY_RUNTIME_*_PER_DAY`, `USAGE_RETENTION_DAYS`, and `USAGE_STORE_MAX_BYTES` settings in `.env`.

The journal stores sanitized request payloads and a bounded result, so it can still contain project prompts, captions, Telegram file IDs, and response text. Its separate `metadata.audit` object records only the actor user/chat and Telegram message/update identifiers; prompt-like audit fields are discarded. Protect the entire `data` directory and size `JOB_*` limits for the host. Only one process may use a data directory; a private PID/token lock rejects a second service or manual instance.

Result delivery uses bounded retries for Telegram 429, server, and transient network failures. Full results live in a separate TTL/quota-bounded file store; large redeliveries stream the retained file and `/last` has its own admission and byte cap. A lost response can be ambiguous: Telegram may have accepted a message even though the client saw an error, so a retry can duplicate a part. This is retry/recovery, not exactly-once Telegram delivery.

Uploads are isolated as `data/uploads/<session>/<job>/file`, limited per file, and passed to only that `agy` invocation. Cleanup runs at startup and hourly, removes expired job directories, and removes oldest completed entries until the total quota is met. `/reset` removes uploads for the current chat/topic scope.

## Native service operation

Run a dry-run first; it prints the exact native definition and argv without changing the host:

```text
node bin/agygram.js doctor
node bin/agygram.js service install --dry-run
node bin/agygram.js service install
node bin/agygram.js service status
node bin/agygram.js service uninstall
```

`service install` first audits its executable/source/supervisor paths, then runs `doctor`, and makes no service change if either fails. It pins absolute Node, project, and `DATA_DIR` paths, so reinstall after moving the checkout, changing `DATA_DIR`, or replacing a version-manager Node installation.

- macOS: a current-user LaunchAgent. It starts in the user's GUI login domain, not before login.
- Linux: a `systemd --user` service. Installation attempts to enable linger; policy may require administrator help. A persistent Secret Service/D-Bus session is still the operator's responsibility.
- Windows: a current-user Task Scheduler task using `InteractiveToken`. Install/uninstall first asks the running bot to cancel active work and shut down through its lifecycle controller. A bounded fallback verifies the registered task process and uses pinned `taskkill.exe /T /F` before Task Scheduler termination, preventing a known child `agy` tree from being left behind. It starts at user logon and can run while locked, but not before the first login after reboot.

See [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md) for paths, logs, limitations, and recovery commands.

## Important security boundary

Telegram text is supplied to current `agy` as the value of the `--print` process argument. `shell: false` prevents shell interpolation, but it does **not** make the argument secret. Depending on host policy, root/administrators and other local processes—especially those running as the same OS user—may inspect process arguments. Transcript fallback increases how much context is present in that argument. Do not put secrets in prompts; use a dedicated account/host and restrict local process visibility where possible.

Splitting a gateway and runner into two processes under the same UID is useful for code organization and restart isolation, but it is not a security boundary: they still share process visibility, files, signals, environment-access rights, and the same keyring. Use distinct OS identities, containers/VMs, filesystem permissions, and separately provisioned credentials when a real boundary is required.

Cancellation waits for a bounded process-tree termination escalation, but this is cleanup rather than an isolation guarantee. A descendant that double-forked and was reparented before the POSIX snapshot, or was created and reparented afterward, may escape discovery. Such a process can also write after the per-run log watcher closes, so host filesystem quotas remain necessary for a hard disk ceiling. Use cgroups/containers or a Windows Job Object when hard descendant containment is required.

The current `agy --print` interface does not provide a documented structured live tool-event stream. `/status` reports the bot's own phases (for example preparing, waiting for a workspace, running `agy`, saving, and sending), and Telegram typing is only a liveness hint. The bot does not invent token streams, tool calls, approval events, or percentages it cannot observe.

## Validation

```text
npm run doctor
npm test
```

Unit tests cover process argument/termination behavior, UTF-8 output, Windows executable policy, state and job persistence, update idempotency, forum routing, workspace boundaries, upload cleanup, Telegram retry classification, lifecycle races, service templates, and instance locking. They do not replace a live OAuth and prompt smoke test on each target host.

Architecture and threat-boundary details are in [docs/DESIGN.md](docs/DESIGN.md).
