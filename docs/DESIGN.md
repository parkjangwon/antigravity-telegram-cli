# Design and security boundaries

## Goals

The bot is a headless, cross-platform control plane for an already installed Antigravity CLI. It aims to provide safe defaults, bounded local resource use, recoverable Telegram delivery, and predictable operation on macOS, Linux, and Windows.

It does not aim to turn a same-user coding agent into a hostile multi-tenant sandbox. All allowed Telegram users are trusted operators of the selected workspaces and the effective Antigravity account.

The runtime must be a currently supported Node.js LTS release (Node.js 22 or 24 at this release). The CLI integration described here was locally exercised with `agy 1.1.1`; the test suite uses stubs and does not prove compatibility with every `agy` release or every host credential-store configuration.

## Trust and process boundary

Telegram input is never interpolated into a shell command. Every CLI call uses a binary plus an argument array with `shell: false`. Model, agent, project ID, path, and prompt are separate arguments. On timeout, cancellation, or output-limit failure, the bot holds the task/workspace lease through a bounded termination escalation. POSIX snapshots the current descendant PID tree with the absolute `/bin/ps` before signalling both the child's process group and those descendants; Windows waits for `taskkill /T /F` or its bounded helper watchdog.

This cleanup is best-effort process hygiene, not containment. A process that already double-forked and was reparented before the snapshot—or is created and reparented after that point—is no longer safely attributable from the child tree. The portable `ps` snapshot and `kill(2)` are not one atomic pidfd operation; start-time identity revalidation narrows PID-reuse risk but cannot remove that final race on every supported POSIX host. If the trusted snapshot helper fails after Node has reaped the leader, the bot refuses to signal a guessed, potentially reused PGID, so an unverified descendant can outlive the bounded lease. Another independently supervised process can also outlive it. Strong containment requires an OS facility such as a cgroup/container on Linux or a Windows Job Object, combined with a dedicated identity.

This prevents shell interpretation; it does not hide the prompt. The current CLI accepts the prompt through `--print`, so prompt text—and transcript fallback context—exists in the process argument list. Host administrators and, depending on OS policy, other local processes including same-UID processes may inspect it. Secrets should not be sent as prompts.

The `agy` child receives a minimal allowlisted environment rather than the bot's complete environment. Telegram/bot/owner variables and loader/shell startup injection controls are denied even if added to `AGY_ENV_ALLOWLIST`. Operators can explicitly add other variable names needed by trusted tools, which gives those values to the agent process and must be treated as a credential grant.

On Windows the executable resolver accepts a native `.exe` only. `.cmd`, `.bat`, and `.ps1` launchers fail closed because using them would introduce a shell command-line boundary. PATH entries must be absolute, and the assembled `CreateProcessW` command line is checked against a 30,000 UTF-16-unit safety limit.

## Authorization and identity

Authorization is the first Telegraf middleware:

- `ALLOWED_CHAT_IDS` is mandatory.
- `ALLOWED_USER_IDS`, when present, is a global sender filter.
- A negative group/supergroup ID requires `ALLOWED_USER_IDS` by default.
- `OWNER_USER_IDS` must be an allowed-user subset. It is required for group or multi-user configurations; only a sole private chat can infer its owner.
- `/auth` is owner-only and private-chat-only by default.

These checks are access control, not a second authentication factor. Compromise of an allowed Telegram account or bot token grants the corresponding bot authority.

Antigravity credentials belong to `agy` and the OS credential store. The bot does not read or write token files. Every chat and topic served by one OS user shares that user's effective `agy` account/keyring. Reauthentication by an owner changes the account used by all of them.

## Workspace boundary

The default workspace is separate from the source tree at `data/workspace`. `/workspace` resolves a requested directory with `realpath` and accepts it only when it is the configured workspace or a descendant of `ALLOWED_WORKSPACE_ROOTS`. Switching workspace clears conversation/project context.

This is a start-directory selection boundary. It prevents a Telegram command from selecting an arbitrary cwd or escaping a root through a symlink. It does not prevent an unsandboxed process running as the same OS account from reading another path that the account can access. A narrow service identity, host filesystem permissions, sandbox/container/VM policy, and backups are still required.

## Safe execution policy

The configuration defaults are `DEFAULT_MODE=plan`, `DEFAULT_SANDBOX=true`, `SANDBOX_PLAN_APPLY=true`, and `ALLOW_UNSANDBOXED_RUNS=false`.

The execution layer forces `sandbox=true` whenever unsandboxed runs are administratively disabled, including for sessions created by older configuration. Sandbox calls add both `--sandbox` and `--dangerously-skip-permissions`; the latter prevents an invisible interactive permission prompt from hanging a headless run. It does not prove what the upstream sandbox contains.

An administrator must opt in to any unsandboxed run with `ALLOW_UNSANDBOXED_RUNS=true`. Unsandboxed automatic permission bypass is an additional opt-in, `ALLOW_UNSANDBOXED_AUTO_APPROVE=true`, and configuration loading rejects that combination unless unsandboxed runs are already allowed.

`/plan` applies a one-shot `mode=plan` override. `/apply` requires that the immediately recorded last run was a successful plan and that a native conversation ID is present. It continues that conversation with a one-shot `mode=accept-edits` override and, by default, `sandbox=true`. Neither command permanently changes the stored mode/sandbox selection.

Interactive Telegram menus are used for settings that naturally require a
choice: `/model`, `/agent`, `/skills`, `/mode`, `/sandbox`, and `/yolo`. The bot
stores only a short-lived in-memory token in the callback payload instead of
embedding long model, agent, or skill names directly, which keeps callback data
below Telegram's 64-byte limit. A menu is bound to the session key and the user
who opened it, expires after ten minutes, and falls back to text-argument
commands where useful for operators who prefer typing or automation.

Telegram's native slash-command menu is static and cannot show a user-specific,
potentially huge skill catalog. The bot therefore exposes `/skills` in the
native command menu, then renders the actual Antigravity skill catalog as a
paginated inline keyboard with search (`/skills query`). Selecting a skill stores
its name in the session and prepends a stable skill-use instruction to subsequent
headless prompts. This is intentionally implemented as prompt steering because
the current `agy` CLI exposes no documented headless `skills` subcommand.

`/yolo` is not an upstream `--mode` value. It is a Telegram execution profile
that sets the session to `mode=accept-edits` and `sandbox=false`. The actual
permission bypass still requires both administrative opt-ins:
`ALLOW_UNSANDBOXED_RUNS=true` and `ALLOW_UNSANDBOXED_AUTO_APPROVE=true`; only
then does the execution layer pass `--dangerously-skip-permissions` without
`--sandbox`.

## Session and state model

Normal chats use `chat_id` as the session key. Telegram forum topics use `chat_id:message_thread_id`; state, durable jobs, task activity, uploads, and outgoing thread routing use that topic key.

`data/sessions.json` has schema version 2. Version 1 and the original
top-level session map are migrated atomically at startup:

```json
{
  "version": 2,
  "sessions": {
    "-1001234567890:42": {
      "conversationId": "uuid-or-null",
      "projectId": "uuid-or-null",
      "model": null,
      "agent": null,
      "mode": "plan",
      "sandbox": true,
      "workspaceDir": "/absolute/workspace",
      "newProject": false,
      "history": [],
      "executionGeneration": "session-lifetime-uuid",
      "revision": 4,
      "lastRun": {
        "id": "durable-job-uuid",
        "kind": "plan",
        "status": "succeeded",
        "mode": "plan",
        "sandbox": true,
        "startedAt": "...",
        "finishedAt": "...",
        "durationMs": 1234,
        "responseText": "...",
        "deliveryStatus": "delivered",
        "errorCode": null
      },
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
}
```

`executionGeneration` changes whenever a session is reset or removed and
recreated. `revision` changes only when execution-relevant state changes
(workspace, conversation/project, model, agent, mode, sandbox, or transcript),
including a newly completed run whose native conversation ID stays constant,
but not for `/start` touches or result-delivery bookkeeping. Durable jobs pin
both values, preventing a stale job from matching a newly recreated session
even when its numeric revision starts at zero again.

The original top-level `{ chatId: session }` shape is migrated. Unsupported future schema versions fail instead of being silently discarded. Mutations are serialized in process, written to a private temporary file, and renamed before the in-memory value is committed. Malformed JSON is moved aside with a timestamp and replaced with empty state.

The state file contains prompts/responses only when needed for transcript fallback or last-result recovery. It never intentionally stores the bot token, OAuth input, or Antigravity token.

## Native conversation continuity and fallback

`agy 1.1.1` can resume a known conversation with `--conversation`, but its normal print response does not provide the new ID as structured stdout. For every prompt, the wrapper creates a private randomly named file and supplies `--log-file`.

Only exact UUID-bearing CLI log records observed in the locally tested release are accepted, including `Created conversation ...`, `Print mode: conversation=...`, and the corresponding project records. The parser reads a bounded head/tail of the CLI-owned file. It never derives state pointers from model stdout, even if stdout contains a valid-looking UUID or resume command.

The log text is an undocumented upstream contract. When it is missing, disabled, or changed:

- the bot retains a bounded user/assistant transcript per session;
- that transcript is included in the next `--print` argument;
- the machine-global `--continue` option is not used because it could cross chat/topic boundaries;
- `/apply` refuses because a plan cannot be safely continued through the native agent trajectory.

With metadata capture enabled, run logs are mode `0600` on POSIX and deleted after parsing unless `AGY_KEEP_RUN_LOGS=true`. Crash-left or retained files are cleaned at startup, after retained-log runs, and by hourly maintenance using age and total-byte limits. The parser's bounded read and cleanup quotas prevent an unbounded log read/store, but retained logs must still be considered sensitive.

## Durable update journal and idempotency

`data/jobs.json` is a separate schema-versioned journal. A record includes a random job ID, Telegram `update_id`, session key, kind, attempt/retry link, sanitized payload, lifecycle metadata, bounded result, delivery flag, and timestamps.

The journal provides these guarantees:

- Enqueue is committed before a detached coding run starts.
- A previously seen `update_id` returns the existing record instead of scheduling a duplicate mutation.
- Transitions are restricted to legal `queued -> running -> terminal` paths.
- Writes use a private temporary file, file sync, atomic rename, and best-effort directory sync.
- On startup, records left in `queued` or `running` receive a private restart marker and initially become `interrupted`.
- Terminal records are pruned oldest-first to `JOB_HISTORY_LIMIT` and `JOB_JOURNAL_MAX_BYTES`; active records are never pruned merely to meet quota.

Before result TTL/quota cleanup or new Telegram work begins, startup reconciles those privately marked records against the other durable stores. It does not parse response contents as evidence:

- `state.lastRun` for the exact session/job/kind in `succeeded/pending` state plus an acquired result-file lease proves the normal `result -> state -> journal` commit reached state; the journal is restored to `succeeded/pending`.
- A formerly `running` job with a result but no completion marker proves `agy` returned and the post-run context check passed, but not that native IDs were committed. Recovery first writes a `RECOVERY_INCOMPLETE` last-run marker, clears conversation/project/history, forces `newProject`, and only then restores the journal to `succeeded/pending`. The terminal status blocks duplicate mutation retry while `/last` can deliver the result.
- Without a result, the record remains `interrupted`. A same-name artifact for a formerly queued job is removed rather than treated as execution evidence.

Every restart candidate is pinned against journal compaction until all candidates have been examined. Pins are released together afterward, and any required removal creates its update tombstone atomically. The state-before-journal recovery order makes a second crash during reconciliation idempotent.

Before enqueue, an in-memory admission controller reserves capacity synchronously. It allows at most one admitted job for a session, caps all admitted queued/running work with `MAX_PENDING_AGY_JOBS`, and caps work attributable to one Telegram sender with `MAX_PENDING_AGY_JOBS_PER_USER`. A job that cannot obtain the global process semaphore within `AGY_QUEUE_TIMEOUT_MS` fails before `agy` starts.

A fresh enqueue snapshots workspace, conversation/project, new-project flag, model, agent, effective mode/sandbox, and a digest of transcript history. The snapshot is stored in the durable payload and checked again before preparation/execution. A context change fails the job rather than applying an old prompt to new session state. Explicit retry reuses the recorded payload and therefore can also be rejected after context drift; the operator should send a fresh request in that case.

The bot does not automatically replay interrupted coding actions: file changes may already have happened before the crash, so replay is not generally idempotent. `/retry <id>` creates an explicit new attempt linked to an eligible failed/cancelled/interrupted record; a result-proven recovered job is terminal success and cannot be retried. Retrying an upload depends on Telegram still accepting the stored file ID.

This is update idempotency and explicit recovery, not a transaction spanning Telegram, `agy`, the filesystem, and state. A host can still fail between those boundaries.

`/jobs` lists recent records, `/status` combines in-memory task phase with stored status, and `/last` reads the last response persisted in session state. Request payloads and responses are operationally sensitive even after key-name/token redaction, so the whole data directory remains private.

## Concurrency and lifecycle

- Admission and TaskManager allow only one queued/running entry per chat/topic session.
- Global and per-Telegram-user pending admission is bounded before a durable enqueue.
- A global semaphore limits concurrent `agy` processes (`MAX_CONCURRENT_AGY=1` by default).
- Waiting for that semaphore is bounded (`AGY_QUEUE_TIMEOUT_MS=600000` by default).
- A canonical-workspace mutex serializes runs from different chats/topics that select the same workspace.
- Authentication is globally exclusive and cannot overlap coding work.
- `/cancel` aborts the current session and kills its child process tree.
- SIGINT/SIGTERM stop polling, cancel tasks/auth, and wait a bounded time for idle completion.
- `data/bot.lock` is a private PID/token ownership lock. A live owner rejects a second manual/service instance; stale-lock recovery verifies file identity before removal.

The lock is per data directory, not a distributed lock. Network filesystems and multiple hosts are not a supported active/active topology.

## Upload lifecycle

Documents and photos are checked against Telegram metadata when present, then checked again against HTTP content length and streamed bytes. Download combines caller cancellation with a 60-second timeout and writes to a private `.part` file before rename.

The layout is `data/uploads/<chat-or-topic>/<timestamp>-<uuid>/<safe-name>`. A failed transfer removes its entire job directory. Only that job directory is passed to the corresponding `agy` call via `--add-dir`, so older uploads in the topic are not exposed through the same argument.

Maintenance runs at startup and hourly. It removes entries older than `UPLOAD_RETENTION_HOURS` and, when total storage exceeds `MAX_UPLOAD_STORAGE_BYTES`, removes oldest completed entries until within quota. `.part` entries are not chosen for quota eviction. `/reset` removes the current chat/topic upload scope.

## Telegram delivery

Long text is split below Telegram's 4,096-character limit without Markdown parse mode. Results above `MAX_INLINE_RESPONSE_CHARS` are sent as an in-memory UTF-8 document.

The result is persisted before delivery. Result/long-message delivery retries rate limits, 5xx responses, and recognized transient network failures up to four attempts, honoring `retry_after` and bounded exponential backoff. A 5xx or network loss is ambiguous and can create a duplicate on retry. If a multipart delivery fails, the stored response remains available through `/last` rather than assuming exactly-once delivery.

Not every short control-command acknowledgement is durable. The durability/recovery guarantee applies to scheduled `agy` jobs and their stored results.

## Observable progress

The available headless print interface is treated as an opaque child process. There is no documented structured event stream for live tokens, tool calls, approval requests, or percentages.

`/status` reports only phases the bot itself can observe: queued, preparing, waiting for a workspace, running `agy`, saving state, and sending the result. Telegram's typing action is a liveness indication. The implementation deliberately does not synthesize live agent/tool events.

## Native service model

`agygram service` generates and manages a current-user service without a shell:

- macOS: per-user LaunchAgent in the GUI login domain;
- Linux: systemd user unit, with best-effort linger enablement;
- Windows: current-user Task Scheduler task using `InteractiveToken`.

The same user is intentional because `agy` must see that user's home and credential store. It also means the service and agent share that user's authority. Definitions pin absolute Node, project, entry, and data paths and must be reinstalled after relocation, `DATA_DIR` changes, or Node replacement. Every native definition passes the data path as a direct argv item; the macOS/Windows file bootstrap additionally uses it for bounded logs and Windows helper artifacts, so neither can silently fall back to checkout-local `data`.

Windows install/uninstall uses a short-lived JSON stop request inside the private service runtime directory. The bot polls and consumes it from early startup, latches a request that arrives before its lifecycle controller exists, then runs the same task/auth cancellation and bounded idle waits used for signals. PowerShell treats Task Scheduler's transition out of `Running` as acknowledgement. After a 30-second graceful window it validates the private lock owner against the currently registered task action (including pre-upgrade paths), uses pinned `taskkill.exe /T /F` for the verified tree, invokes `Stop-ScheduledTask`, and performs a bounded 15-second exit check. A nonzero tree-kill result or surviving verified root fails closed. Invalid or expired request files are removed without stopping a replacement instance.

Non-dry-run service installation verifies the POSIX `.env` path before parsing it, copies only explicit application settings into a reduced environment, rejects Node/loader startup injection variables, validates the complete bot configuration, and requires the selected `agy` path to be absolute. It audits the project runtime tree, Node, `agy`, service-manager/PATH paths, and supervisor definition directory before running `doctor`. This avoids an ambient interactive bot token, shell alias, or writable imported module silently becoming the service configuration. The service definition embeds no bot/OAuth secret.

The service backends have different boot limits: the macOS LaunchAgent and Windows interactive task require user login, while Linux can run across logout/boot only when the user manager/linger and credential service are correctly configured. See `CROSS_PLATFORM_OPERATIONS.md`.

## What is not a security boundary

- Workspace allowlisting alone is not filesystem sandboxing.
- An upstream sandbox flag is not claimed to be an independently audited isolation layer.
- Telegram allowlists are not protection against an already compromised allowed account.
- A gateway and runner under the same UID are not isolated: they share process visibility, signals, readable files, and keyring authority.
- State/journal atomic writes are not a transaction with agent filesystem changes or Telegram delivery.
- Forum topics isolate logical sessions, not OS credentials or a shared workspace.

A real privilege boundary requires distinct OS identities or separately isolated containers/VMs, explicitly narrowed filesystem/network access, and separately provisioned credentials. Because an Antigravity credential store is scoped to the OS user/session, separate identities also mean separate OAuth provisioning.
