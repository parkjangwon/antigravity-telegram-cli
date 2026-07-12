# agygram

[한국어](README.ko.md) · [Latest release](https://github.com/parkjangwon/agygram/releases/latest) · [Install details](docs/MANAGED_INSTALL.md)

Run Google Antigravity CLI (`agy`) from Telegram on macOS, Linux, or Windows. It is built for headless servers: no IDE, no desktop session for daily use, and first authentication happens from Telegram.

## Quick Start

Before you start, create a Telegram bot with [@BotFather](https://t.me/BotFather), keep the bot token ready, and make sure `agy` works for the same OS user.

macOS or Linux:

```sh
(umask 077; f=$(mktemp "${TMPDIR:-/tmp}/agygram-install.XXXXXXXX") || exit; trap 'rm -f "$f"' 0 HUP INT TERM; curl -qfsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 --retry 3 -o "$f" https://github.com/parkjangwon/agygram/releases/latest/download/install.sh && sh -n "$f" && sh "$f" --setup)
```

Windows PowerShell:

```powershell
& { $ErrorActionPreference = 'Stop'; $d = Join-Path ([IO.Path]::GetTempPath()) ("agygram-install-{0}" -f [Guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $d | Out-Null; $f = Join-Path $d 'install.ps1'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri 'https://github.com/parkjangwon/agygram/releases/latest/download/install.ps1' -OutFile $f; powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $f --setup; Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
```

The setup wizard will:

1. Ask for your Telegram bot token.
2. Ask you to send `/start` to the bot, then auto-detect your private chat ID and owner user ID.
3. Find `agy`, write a private `.env`, create data/workspace directories, and install the native user service when the platform checks pass.

Then open Telegram and send `/auth` to the bot. It will show the Antigravity OAuth URL, accept the returned code as a Telegram message, and verify the credential with a real headless request.

## What You Get

- Telegram control for `agy`: chat, plan/apply, button-based model/agent/skill/mode switching, uploads, jobs, retries, and result recovery.
- Headless OAuth designed for remote Linux servers and other no-IDE environments.
- Managed per-user service: launchd on macOS, systemd user service on Linux, Task Scheduler on Windows.
- Verified release installer/updater and data-preserving uninstaller.
- Conservative defaults: sandbox on, owner-only auth/update, allowlists, execution limits, storage limits.

## Day-Two Commands

After the launcher directory printed by the installer is on `PATH`:

```sh
agygram --version
agygram doctor
agygram service status
agygram setup
```

Rerun the same install command any time to update or repair the managed installation. From a clean source checkout, owners can also use `/update` and `/update apply` in Telegram.

## Telegram Commands

| Command | Purpose |
| --- | --- |
| Plain text | Send a request to `agy` in the selected workspace. |
| `/plan <request>` / `/apply [notes]` | Create a plan, then apply it in sandboxed code mode. |
| `/new`, `/workspace`, `/project` | Start fresh or change project context. |
| `/model`, `/agent`, `/skills`, `/mode`, `/sandbox`, `/yolo` | Open Telegram buttons to inspect or change execution settings. `/skills query` searches long skill lists. |
| `/status`, `/jobs`, `/last`, `/retry` | Inspect or recover work. |
| `/auth` / `/cancel` | Authenticate or cancel the current request. |
| `/update` / `/update apply` | Check and apply an official immutable release. |
| `/info`, `/reset`, `/help` | Inspect, reset, or show help. |

Documents and photos are stored in an isolated upload directory for the single request that uses them.

## Important Notes

- Use a dedicated low-privilege OS account and a narrow workspace. This is a trusted-operator tool, not a multi-tenant sandbox.
- One OS user/keyring means one effective Antigravity account shared by every allowed chat on that bot instance.
- Keep `ALLOW_UNSANDBOXED_RUNS=false` unless you deliberately accept unsandboxed agent execution. `/yolo` additionally requires `ALLOW_UNSANDBOXED_AUTO_APPROVE=true`.
- Windows service installation requires a config/data ACL review before `WINDOWS_ACL_VERIFIED=true`; the wizard prepares the config but does not fake that attestation.

Full installer options, rollback behavior, release verification, Windows ACL commands, and troubleshooting live in [Managed install, update, and uninstall](docs/MANAGED_INSTALL.md). Service paths and platform operations are in [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md).

## License

[MIT](LICENSE)
