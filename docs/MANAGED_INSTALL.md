# Managed install, update, and uninstall

The release installer is the recommended way to run `agygram` as a current-user service. It keeps immutable application releases separate from configuration, runtime data, and the workspace. The same command performs a first install, an update, or reconciliation of managed state such as launchers, configuration, and the native service. It verifies an existing immutable release but does not rewrite damaged live code in place.

The current public bootstrap is pinned to **0.3.7**. `install.sh` and `install.ps1` embedded in that release select the stable `v0.3.7` release, resolve its exact Git commit, and verify the downloaded installer and package before running them. A future release updates the version embedded in its own bootstrap; `releases/latest/download/...` then serves that new, independently pinned bootstrap.

## Prerequisites

- macOS, Linux, or Windows, using a non-root current-user account. POSIX installation and uninstallation deliberately refuse uid 0 because `agy` OAuth credentials belong to the service user.
- Node.js **22 or 24**, including the npm CLI distributed with Node. Other Node major versions are rejected.
- An installed Antigravity CLI available to that same account. The tested compatibility baseline is `agy 1.1.1`; this is not a promise that every later undocumented CLI log format is compatible.
- On Windows, a native `agy.exe`. An npm `agy.cmd`, `.bat`, or `.ps1` shim is rejected.
- A Telegram bot token. The `--setup` wizard can auto-detect your private numeric chat/user IDs after you send `/start` to the bot.
- Direct HTTPS access to GitHub release/API endpoints and to the configured npm registry/package CDN, plus a working OS credential store for the service account.
- For the convenience command below, `curl` plus normal POSIX utilities on macOS/Linux, or Windows PowerShell 5.1 / PowerShell 7 on Windows.
- For a managed service: launchd in a macOS GUI login session, a systemd user manager on Linux, or Task Scheduler on Windows. A first code-only install with `--no-service` does not attempt to install the service.

The bot is a trusted-operator tool. Use a dedicated, low-privilege OS account and a narrow workspace. Do not run the installer with `sudo`.

## Install, update, or reconcile managed state

These commands download the bootstrap to a private temporary file and execute that file. They intentionally do not use `curl | sh` or its PowerShell equivalent.

### macOS and Linux

```sh
(umask 077; f=$(mktemp "${TMPDIR:-/tmp}/agygram-install.XXXXXXXX") || exit; trap 'exit 1' HUP INT TERM; trap 'rm -f "$f"' 0; curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 --retry 3 -o "$f" https://github.com/parkjangwon/agygram/releases/latest/download/install.sh && [ -s "$f" ] && [ "$(wc -c < "$f")" -le 1048576 ] && sh -n "$f" && sh "$f" --setup)
```

### Windows PowerShell

```powershell
& { $ErrorActionPreference = 'Stop'; $tls = [Net.ServicePointManager]::SecurityProtocol; $d = Join-Path ([IO.Path]::GetTempPath()) ("agygram-install-{0}" -f [Guid]::NewGuid().ToString('N')); try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; New-Item -ItemType Directory -Path $d | Out-Null; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $grant = "*${sid}:(OI)(CI)(F)"; $systemDir = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::System); $icacls = Join-Path $systemDir 'icacls.exe'; if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) { throw 'Could not locate system icacls.exe' }; & $icacls $d /inheritance:r /grant:r $grant | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Could not protect the temporary directory' }; $f = Join-Path $d 'install.ps1'; $ok = $false; for ($i = 1; $i -le 3 -and -not $ok; $i++) { try { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -MaximumRedirection 5 -Uri 'https://github.com/parkjangwon/agygram/releases/latest/download/install.ps1' -OutFile $f; $ok = $true } catch { if ($i -eq 3) { throw }; Start-Sleep -Seconds $i } }; $n = (Get-Item -LiteralPath $f).Length; if ($n -lt 1 -or $n -gt 1MB) { throw 'Unexpected bootstrap size' }; $exe = (Get-Process -Id $PID).Path; & $exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $f --setup; if ($LASTEXITCODE -ne 0) { throw "Installer exited with code $LASTEXITCODE" } } finally { [Net.ServicePointManager]::SecurityProtocol = $tls; Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } }
```

The command uses `-ExecutionPolicy Bypass` only in the short-lived child process that executes the downloaded file; it does not weaken machine- or user-wide policy. Enterprise policy can still reject it.

Rerun the same command to update or reconcile managed launchers/configuration/service state. The bootstrap does not install an arbitrary moving branch: it obtains its embedded SemVer release, requires a non-draft/non-prerelease GitHub release with the matching tag, resolves that tag to an exact 40-character commit, and passes both identities to the installer.

## First run

The first run locates `agy` (or uses `--agy-bin`), installs production dependencies with lifecycle scripts disabled, writes an external `.env` from the packaged example if one does not exist, and fills in absolute `AGY_BIN`, `DATA_DIR`, and `WORKSPACE_DIR` values. It never reads or writes Antigravity OAuth token files.

With `--setup`, the installer starts an interactive wizard after the verified release is unpacked. The wizard asks for the Telegram bot token, validates it with Telegram, asks you to send `/start` to the bot, and auto-detects the private chat ID and owner user ID when possible. It then rewrites the external `.env` and the installer immediately rechecks the configuration before deciding whether to install the native service.

If you run without `--setup`, or if Telegram auto-detection cannot be used, edit the path printed as `Config`, at minimum:

```dotenv
BOT_TOKEN=123456:replace-me
ALLOWED_CHAT_IDS=<your-private-chat-id>
OWNER_USER_IDS=<your-private-user-id>
```

Keep the generated absolute `AGY_BIN`, `DATA_DIR`, and `WORKSPACE_DIR`, or replace the latter two with other absolute paths outside the managed code root. For groups and supergroups, also configure `ALLOWED_USER_IDS`; see the main README for the allowlist rules.

Then rerun the same installer command. It runs `doctor` before changing the native service and installs the service only after configuration passes. Complete OAuth afterward from an allowed private owner chat with `/auth`.

### Windows ACL attestation

Windows does not provide meaningful POSIX mode bits. Before setting the attestation, restrict and inspect the DACL on the configuration directory, the exact managed `.env` file, and the complete data directory. Securing the directory matters because an atomic `.env` replacement inherits from it. For the default paths:

```powershell
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = "*$sid"
$configDir = Join-Path $env:LOCALAPPDATA 'agygram\config'
$envFile = Join-Path $env:LOCALAPPDATA 'agygram\config\.env'
$dataDir = Join-Path $env:LOCALAPPDATA 'agygram\data'
$systemDir = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::System)
$icacls = Join-Path $systemDir 'icacls.exe'
if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) { throw 'Could not locate system icacls.exe' }
& $icacls $configDir /inheritance:r
& $icacls $configDir /grant:r "${principal}:(OI)(CI)(F)"
& $icacls $envFile /inheritance:r
& $icacls $envFile /grant:r "${principal}:(F)"
& $icacls $dataDir /inheritance:r
& $icacls $dataDir /grant:r "${principal}:(OI)(CI)(F)"
& $icacls $configDir
& $icacls $envFile
& $icacls $dataDir
```

If the configuration or `DATA_DIR` path is customized, secure those exact resolved locations instead. Review the output, then set `WINDOWS_ACL_VERIFIED=true` in `.env` and rerun the installer. This variable is an operator attestation, not an automatic Windows ACL proof. Whenever the manager rewrites the Windows configuration, it resets the attestation to false; an update or path/`AGY_BIN` change can therefore leave the service safely uninstalled until the operator reviews and re-attests. Without the attestation, Windows startup/`doctor` fail closed.

## Default paths

Configuration, data, and workspace paths remain outside the managed application root, so an update can replace code without replacing operator state.

| Platform | Managed code root | Configuration | Runtime data | Default workspace | Launcher directory |
|---|---|---|---|---|---|
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/agygram/manager` | `${XDG_CONFIG_HOME:-$HOME/.config}/agygram/.env` | `${XDG_DATA_HOME:-$HOME/.local/share}/agygram/data` | `${XDG_DATA_HOME:-$HOME/.local/share}/agygram/workspace` | `<managed root>/bin` |
| macOS | `$HOME/Library/Application Support/agygram/manager` | `$HOME/Library/Application Support/agygram/config/.env` | `$HOME/Library/Application Support/agygram/data` | `$HOME/Library/Application Support/agygram/workspace` | `<managed root>/bin` |
| Windows | `%LOCALAPPDATA%\agygram\manager` | `%LOCALAPPDATA%\agygram\config\.env` | `%LOCALAPPDATA%\agygram\data` | `%LOCALAPPDATA%\agygram\workspace` | `<managed root>\bin` |

Linux honors absolute `XDG_DATA_HOME` and `XDG_CONFIG_HOME` values. The manager stores releases as `releases/v<semver>-<commit>`, plus a validated `manifest.json` and `current` pointer.

The installer creates `agygram` (POSIX) or `agygram.cmd` (Windows) in the launcher directory and prints `Add to PATH: ...`. It does **not** modify a shell profile or the Windows user PATH. Add the printed directory yourself, then open a new shell. For the current shell only:

```sh
export PATH="<printed launcher directory>:$PATH"
```

```powershell
$env:Path = "<printed launcher directory>;$env:Path"
```

The launcher validates the manifest, current pointer, and release marker before dispatch. For `doctor` and `service status` it also pins the managed external configuration/data paths and rejects attempts to override them through launcher arguments. Managed `service install` and `service uninstall` are blocked because they would bypass the manager receipt; use the release installer/updater and uninstaller instead.

Verify the active release after adding the launcher to PATH:

```text
agygram --version
agygram setup
agygram doctor
agygram service status
```

For this release, `agygram --version` must print `0.3.7`. Telegram `/info` also includes the running `agygram` version. The installer prints its resolved `Current` and `Target` version/commit identities.

## Installer options

Arguments after the downloaded bootstrap are forwarded to the verified installer. Paths must be absolute.

```text
--install-root <path>  Use a different managed code root.
--config-file <path>   Use a different external .env file.
--agy-bin <path>       Pin an absolute agy executable (agy.exe on Windows).
--setup                Run the interactive first-run setup wizard.
--no-service           Install/update code and ensure the native service is removed.
--allow-downgrade      Explicitly allow a lower SemVer target.
```

For example, after downloading `install.sh` to a private file:

```sh
sh ./install.sh --install-root /absolute/agygram-manager --config-file /absolute/agygram.env --agy-bin /absolute/bin/agy --no-service
```

PowerShell uses the same flags:

```powershell
& .\install.ps1 --install-root 'D:\Apps\agygram-manager' --config-file 'D:\Secrets\agygram.env' --agy-bin 'D:\Tools\agy.exe' --no-service
```

An existing managed `.env` may set absolute `DATA_DIR` and `WORKSPACE_DIR`; those values are preserved. Managed code, configuration, data, and workspace paths must remain distinct and non-overlapping. Both install and uninstall bootstraps honor a non-empty absolute `AGYGRAM_INSTALL_ROOT`; an explicit `--install-root` takes precedence. Use the same custom root for every later update and uninstall.

The normal release bootstrap supplies `--version`, `--commit`, `--archive`, and `--archive-sha256` itself. They are integrity plumbing, not routine operator settings.

## Update, downgrade, rollback, and crash recovery

- Repeating the installer at the same version/commit verifies the immutable release read-only, then reconciles launchers, configuration, and the requested service state. It does not overwrite a damaged release tree or `node_modules` in place.
- A higher SemVer installs into a new immutable release directory. After success, the current and immediately previous release are retained; older installer-owned releases are pruned.
- A lower SemVer is refused unless the verified installer is deliberately invoked with `--allow-downgrade`. A different commit cannot silently replace the same version.
- Service repinning and release switching use an atomic transaction journal. On an ordinary failure, the installer removes the candidate service and restores the previous manifest/current pointer and service on a best-effort basis. It reports any rollback problem instead of claiming success.
- If the process or host dies during a recorded transition, the next installer run takes the installer lock and conservatively completes rollback: candidate service cleanup, previous state restoration, and prior service reinstall. The transaction is removed only after recovery succeeds.
- Recovery never overwrites a configuration that changed independently after the interrupted write. It fails closed and preserves the transaction for diagnosis instead.
- Concurrent install/update/uninstall operations are rejected by a private cooperative lock. Ownership markers prevent cleanup from deleting an unrecognized directory.

After any reported rollback warning or repeated recovery failure, do not delete the manager tree by hand. A pending private `transaction.json` can contain a base64 rollback copy of the previous `.env`, including secrets. Preserve it locally with `manifest.json`, `current`, and the command output, but never attach it unredacted when opening an issue.

## Uninstall

The shown command still downloads and executes a bootstrap from the latest GitHub release, so independently verify that asset first when your threat model requires it. The published bootstrap is intended only to validate the current pointer and dispatch to `scripts/uninstall.mjs` shipped inside the installed release; it does not download a second uninstaller implementation.

### macOS and Linux

```sh
(umask 077; f=$(mktemp "${TMPDIR:-/tmp}/agygram-uninstall.XXXXXXXX") || exit; trap 'exit 1' HUP INT TERM; trap 'rm -f "$f"' 0; curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 --retry 3 -o "$f" https://github.com/parkjangwon/agygram/releases/latest/download/uninstall.sh && [ -s "$f" ] && [ "$(wc -c < "$f")" -le 1048576 ] && sh -n "$f" && sh "$f")
```

### Windows PowerShell

```powershell
& { $ErrorActionPreference = 'Stop'; $tls = [Net.ServicePointManager]::SecurityProtocol; $d = Join-Path ([IO.Path]::GetTempPath()) ("agygram-uninstall-{0}" -f [Guid]::NewGuid().ToString('N')); try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; New-Item -ItemType Directory -Path $d | Out-Null; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $grant = "*${sid}:(OI)(CI)(F)"; $systemDir = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::System); $icacls = Join-Path $systemDir 'icacls.exe'; if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) { throw 'Could not locate system icacls.exe' }; & $icacls $d /inheritance:r /grant:r $grant | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Could not protect the temporary directory' }; $f = Join-Path $d 'uninstall.ps1'; $ok = $false; for ($i = 1; $i -le 3 -and -not $ok; $i++) { try { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -MaximumRedirection 5 -Uri 'https://github.com/parkjangwon/agygram/releases/latest/download/uninstall.ps1' -OutFile $f; $ok = $true } catch { if ($i -eq 3) { throw }; Start-Sleep -Seconds $i } }; $n = (Get-Item -LiteralPath $f).Length; if ($n -lt 1 -or $n -gt 1MB) { throw 'Unexpected bootstrap size' }; $exe = (Get-Process -Id $PID).Path; & $exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $f; if ($LASTEXITCODE -ne 0) { throw "Uninstaller exited with code $LASTEXITCODE" } } finally { [Net.ServicePointManager]::SecurityProtocol = $tls; Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } }
```

Uninstall validates ownership/integrity receipts, takes the cooperative lock, and revalidates before mutation. It then removes the recorded native service; if that fails, it preserves managed files and reports the failure. Finally it rechecks the relevant receipts while removing the owned launcher, releases, pointers, manifest, and manager root.

The following are always preserved:

- the external `.env` configuration;
- runtime data and logs;
- the workspace and project files;
- Antigravity OAuth material and all system keyring/credential-store entries;
- Linux user linger state.

There is intentionally **no purge option**. Back up and remove preserved paths or credentials separately only when that is explicitly desired. The installer never edits PATH, so remove any PATH/profile entry you added yourself.

## Release verification

The bootstrap accepts only HTTPS redirects to a small GitHub host allowlist, rejects draft/prerelease mismatches, resolves the pinned tag to an exact commit, applies size/time limits, and verifies SHA-256 before executing `install.mjs` or extracting the npm package. It prefers GitHub's release-asset digest metadata and otherwise reads the exact entry from the release `SHA256SUMS`. The managed installer verifies the supplied package digest again, rejects links/path traversal/case collisions in the archive, checks package name/version, and installs dependencies with npm lifecycle scripts disabled.

For independent verification, download the assets from the [GitHub release](https://github.com/parkjangwon/agygram/releases) and compare the relevant row in `SHA256SUMS` with `sha256sum` (Linux), `shasum -a 256` (macOS), or `Get-FileHash -Algorithm SHA256` (PowerShell). Release automation also publishes GitHub artifact attestations for every asset, including `SHA256SUMS`:

```sh
gh attestation verify ./install.sh --repo parkjangwon/agygram
gh attestation verify ./agygram-0.3.7.tgz --repo parkjangwon/agygram
```

Attestation verification requires a current authenticated GitHub CLI. A checksum detects mismatch against the downloaded checksum list; a verified GitHub attestation additionally binds an asset to this repository's release workflow.

## Troubleshooting

- **`Node.js 22 or 24 is required`**: make the intended supported Node installation first on PATH. The same installation must include npm. Reinstall the service after replacing a version-manager Node path.
- **`agy executable was not found`**: pass its absolute native path with `--agy-bin`. On Windows, locate `agy.exe`, not `agy.cmd`.
- **Service remains uninstalled**: run `agygram setup` or edit the printed configuration path. Supply valid `BOT_TOKEN`, `ALLOWED_CHAT_IDS`, and `OWNER_USER_IDS`; on Windows also finish the config-directory/file and data-directory DACL review and attestation. A managed config rewrite resets that attestation, so recheck it after an update or path change. Rerun the same installer and read the `doctor` failure if it still cannot install.
- **A custom install cannot be found during uninstall**: pass `--install-root <same absolute path>` or set `AGYGRAM_INSTALL_ROOT`.
- **Linux service stops after logout or cannot reach credentials**: inspect `systemctl --user status agygram.service`; linger may require administrator policy, and the service account still needs a working D-Bus/Secret Service session. Uninstall intentionally does not disable linger.
- **macOS service cannot access credentials**: a LaunchAgent requires a user GUI login and an accessible Keychain for that account.
- **Windows task does not start**: it uses the current user's interactive token and starts at logon, not before the first login after reboot. Check Task Scheduler and the data-directory service log.
- **Installer reports an active lock**: do not remove it while another operation is running. After a crash, rerun; stale same-host locks and a recorded transaction are recovered conservatively.
- **Installed release integrity failure**: the same-version installer will not rewrite live code. Use the managed uninstaller (which preserves external data) and reinstall. If validation also prevents uninstall, preserve the reported paths and open an issue with secrets redacted rather than using recursive deletion.
- **Ownership or pointer error**: the installer/uninstaller has failed closed. Do not use recursive deletion as a workaround; preserve the reported paths and open an issue with secrets redacted.

Native service paths, logs, and supervisor-specific recovery commands are documented in [Cross-platform operations](CROSS_PLATFORM_OPERATIONS.md).
