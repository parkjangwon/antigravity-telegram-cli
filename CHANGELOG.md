# Changelog

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
