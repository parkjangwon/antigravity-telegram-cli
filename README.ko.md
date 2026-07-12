# agygram

[English](README.md) · [최신 릴리즈](https://github.com/parkjangwon/agygram/releases/latest) · [설치 상세](docs/MANAGED_INSTALL.md)

Google Antigravity CLI(`agy`)를 Telegram에서 제어하는 헤드리스 봇입니다. macOS, Linux, Windows에서 IDE 없이 운영할 수 있고, 최초 인증도 Telegram 안에서 끝나도록 설계했습니다.

## 빠른 시작

먼저 Telegram의 [@BotFather](https://t.me/BotFather)에서 봇을 만들고 bot token을 준비하세요. `agy`는 봇을 실행할 같은 OS 사용자에서 동작해야 합니다.

macOS 또는 Linux:

```sh
(umask 077; f=$(mktemp "${TMPDIR:-/tmp}/agygram-install.XXXXXXXX") || exit; trap 'rm -f "$f"' 0 HUP INT TERM; curl -qfsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 --retry 3 -o "$f" https://github.com/parkjangwon/agygram/releases/latest/download/install.sh && sh -n "$f" && sh "$f" --setup)
```

Windows PowerShell:

```powershell
& { $ErrorActionPreference = 'Stop'; $d = Join-Path ([IO.Path]::GetTempPath()) ("agygram-install-{0}" -f [Guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $d | Out-Null; $f = Join-Path $d 'install.ps1'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri 'https://github.com/parkjangwon/agygram/releases/latest/download/install.ps1' -OutFile $f; powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $f --setup; Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
```

설정 마법사가 다음을 처리합니다.

1. Telegram bot token 입력
2. 봇에게 `/start` 전송 후 private chat ID와 owner user ID 자동 탐지
3. `agy` 탐색, private `.env` 작성, data/workspace 생성, 플랫폼 검사가 통과하면 사용자 서비스 설치

그 다음 Telegram에서 봇에게 `/auth`를 보내세요. 봇이 Antigravity OAuth URL을 보여주고, 브라우저에서 받은 코드를 Telegram 메시지로 보내면 실제 headless 요청으로 인증을 검증합니다.

## 제공 기능

- Telegram에서 `agy` 제어: 대화, plan/apply, 버튼 기반 model/agent/skill/mode 전환, 업로드, 작업 기록, 재시도, 결과 복구
- 원격 Linux 서버 같은 no-IDE 환경을 위한 headless OAuth
- 사용자 단위 native service: macOS launchd, Linux systemd user service, Windows Task Scheduler
- 검증된 릴리즈 설치/업데이트와 data 보존 언인스톨
- 보수적인 기본값: sandbox on, owner-only auth/update, allowlist, 실행/저장 한도

## 운영 명령

설치기가 출력한 launcher directory를 `PATH`에 추가한 뒤 사용할 수 있습니다.

```sh
agygram --version
agygram doctor
agygram service status
agygram setup
```

같은 설치 명령을 다시 실행하면 업데이트 또는 복구가 됩니다. clean source checkout에서는 owner가 Telegram에서 `/update`, `/update apply`도 사용할 수 있습니다.

## Telegram 명령어

| 명령 | 용도 |
| --- | --- |
| 일반 메시지 | 선택된 workspace에서 `agy` 요청 실행 |
| `/plan <요청>` / `/apply [추가 지시]` | 계획 생성 후 sandbox code 모드로 적용 |
| `/new`, `/workspace`, `/project` | 새 대화 또는 프로젝트 문맥 전환 |
| `/model`, `/agent`, `/skills`, `/mode`, `/sandbox`, `/yolo` | Telegram 버튼으로 실행 설정 조회/변경. `/skills 검색어`로 긴 skill 목록 검색 |
| `/status`, `/jobs`, `/last`, `/retry` | 작업 상태 확인/복구 |
| `/auth` / `/cancel` | 인증 또는 현재 요청 취소 |
| `/update` / `/update apply` | 공식 immutable 릴리즈 확인/적용 |
| `/info`, `/reset`, `/help` | 상태, 초기화, 도움말 |

문서와 사진은 해당 요청에서만 쓰이는 격리 업로드 디렉터리에 저장됩니다.

## 중요 사항

- 전용 저권한 OS 계정과 좁은 workspace를 권장합니다. 이 프로젝트는 신뢰된 운영자용 도구이며 다중 테넌트 격리 서비스가 아닙니다.
- OS 사용자/keyring 하나에는 Antigravity 계정도 하나입니다. 같은 봇 인스턴스의 모든 허용 채팅은 그 계정을 공유합니다.
- unsandboxed 실행을 명시적으로 허용할 때까지 `ALLOW_UNSANDBOXED_RUNS=false`를 유지하세요. `/yolo`는 추가로 `ALLOW_UNSANDBOXED_AUTO_APPROVE=true`가 필요합니다.
- Windows 서비스 설치는 config/data ACL 검토 후 `WINDOWS_ACL_VERIFIED=true`가 필요합니다. 마법사는 설정을 준비하지만 이 보안 증명을 자동으로 꾸며내지 않습니다.

설치 옵션, rollback, 릴리즈 검증, Windows ACL 명령, 문제 해결은 [Managed install, update, and uninstall](docs/MANAGED_INSTALL.md)에 있습니다. 서비스 경로와 플랫폼 운영은 [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md)를 참고하세요.

## 라이선스

[MIT](LICENSE)
