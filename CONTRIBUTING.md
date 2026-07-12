# Contributing

Thanks for helping make Antigravity Telegram CLI reliable on macOS, Windows,
and Linux.

## Development setup

Use a currently supported Node.js LTS. CI exercises Node.js 22 and Node.js 24 on
all three supported operating-system families.

1. Fork and clone the repository.
2. Run `npm ci` from the repository root.
3. Copy `.env.example` to `.env` only when manual integration testing requires
   it, then use test-only credentials and keep the file private.
4. Run `npm run check` and `npm test` before submitting a change.

Unit tests must not require a live Telegram bot, a real Antigravity account,
network access, or secrets. Put OS-specific behavior behind small injectable
boundaries and cover both success and failure paths with temporary files or
stub processes.

## Pull requests

- Keep each pull request focused and explain its user-visible behavior.
- Add or update tests for behavior changes and regressions.
- Preserve support for paths containing spaces, non-ASCII text, Windows drive
  letters, and platform-native path separators.
- Avoid shell-only assumptions. Prefer Node.js APIs and argument arrays over
  interpolated command strings.
- Do not weaken chat/user authorization, environment filtering, workspace
  containment, file limits, timeouts, or process cleanup without documenting
  the security tradeoff.
- Update documentation when configuration, commands, compatibility, or threat
  boundaries change.

All CI matrix jobs should pass. A maintainer may request an actual headless
`agy` smoke test separately because CI deliberately runs without credentials or
external service access.

## Security-sensitive changes

Do not submit a public pull request that reveals an unpatched vulnerability or
contains real credentials, private prompts, run logs, or user files. Follow
[SECURITY.md](SECURITY.md) and coordinate sensitive fixes through a private
GitHub Security Advisory.

By contributing, you agree that your contribution is licensed under the MIT
License included in this repository.
