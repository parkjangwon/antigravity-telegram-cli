# Changelog

## 0.3.7 — 2026-07-13

- Keep the new `/auth` preflight tests aligned with Windows executable policy;
  the project intentionally rejects `.cmd` shims as agy binaries.

## 0.3.6 — 2026-07-13

- Make `/auth` run a short real headless authentication probe first and return
  immediately when `agy` is already signed in, instead of opening the OAuth TUI
  and waiting for a URL that is not needed.
- Keep the OAuth start message accurate for both already-authenticated and
  login-required sessions.

## 0.3.5 — 2026-07-13

- Make Telegram OAuth output action-focused: show only the auth URL, code
  prompt, errors, and final result instead of streaming Antigravity TUI frames.
- Strip PTY keyboard-protocol fragments, spinner frames, and the internal
  `AGY_AUTH_OK` verification token from Telegram auth messages.
- Add a Telegram-native `/menu` button panel for status, session info, model,
  agent, skill, mode, sandbox, YOLO, auth, update, jobs, and last-result access.
- Make `/help` concise and button-first while preserving the full command list
  through `/help full`.

## 0.3.4 — 2026-07-13

- Keep managed update scheduling path handling portable across POSIX and
  Windows test hosts.

## 0.3.3 — 2026-07-13

- Allow Telegram `/update` to recognize managed immutable release installs,
  not only clean git checkouts.
- Schedule managed release updates through the native service environment so
  `/update apply` can move a service from one immutable release to the next.

## 0.3.2 — 2026-07-13

- Add Telegram button-driven YOLO mode for explicitly enabled unsandboxed
  auto-approve runs.
- Add paginated Telegram skill selection with search, persisted per session and
  applied to subsequent agy prompts.
- Document the skill discovery paths, dynamic Telegram menu limitation, and
  the two-step environment opt-in required for YOLO behavior.

## 0.3.1 — 2026-07-13

- Add Telegram inline-button menus for `/model`, `/agent`, `/mode`, and
  `/sandbox` while preserving direct text arguments for automation.
- Bind interactive menus to the opening user and chat/topic, expire them after
  ten minutes, and keep callback payloads tokenized so long model or agent
  names do not exceed Telegram limits.

## 0.3.0 — 2026-07-12

- Rename the public project identity to `agygram`, including repository URLs,
  package metadata, release asset names, documentation, and native service
  labels.
- Keep managed install, update, and uninstall compatible with legacy
  `antigravity-telegram-cli` manifests and release markers.

## 0.2.0 — 2026-07-12

- Add `agygram setup`, an interactive onboarding wizard that validates the
  Telegram bot token, auto-detects a private Telegram chat/user after `/start`,
  writes the external `.env`, and prepares data/workspace paths.
- Add managed installer `--setup` so first install can go from verified release
  download to service installation without hand-editing `.env` on macOS/Linux.
- Refresh English and Korean READMEs around the shorter setup journey.

## 0.1.3 — 2026-07-12

- Remove personal Telegram identifiers from all public examples and history.
- Synchronize Telegram command menus at default and allowed-chat Korean scopes
  so stale commands from earlier bot deployments are removed.

## 0.1.2 — 2026-07-12

- Add owner-only Telegram `/update` and `/update apply` for verified immutable
  GitHub releases in official clean source checkouts.

## 0.1.1 — 2026-07-12

- Make the POSIX `tmux` OAuth transport complete the entire first-run agy
  onboarding from Telegram: Google OAuth selection, default theme, terms,
  workspace trust, clean exit, and a final real headless authentication check.
- Keep optional agy interaction-data analytics disabled during automatic
  onboarding.
- Fix TTY menu timing and make the manual Enter recovery command functional.

## 0.1.0 — 2026-07-12

Initial public release.

- Headless Telegram control for Google Antigravity CLI on macOS, Linux, and Windows.
- Safe plan/sandbox defaults, allowlists, owner-only OAuth, durable jobs, limits, recovery, uploads, and result delivery.
- Native per-user launchd, systemd, and Task Scheduler integration.
- Versioned one-line installer/updater and data-preserving uninstaller.
