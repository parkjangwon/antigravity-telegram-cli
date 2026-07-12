# Antigravity Telegram CLI Bot

> English documentation: [README.md](README.md)

Google Antigravity CLI(`agy`)를 Telegram에서 제어하는 headless 봇입니다. IDE 없이 실행하며, 하나의 Node.js 애플리케이션으로 macOS·Linux·Windows를 지원하고 각 운영체제의 사용자 단위 서비스 관리자와 연동합니다.

이 프로젝트는 신뢰할 수 없는 사용자를 서로 격리하는 멀티테넌트 실행 서비스가 아닙니다. 봇에 접근할 수 있는 Telegram 사용자는 허용된 작업공간에서 코딩 에이전트를 움직일 수 있습니다. 안전한 기본값을 유지하고, 전용 OS 계정을 사용하며, 신뢰하는 사람만 허용하세요.

## 구현된 핵심 기능

- 셸을 사용하지 않는 `agy` 실행, timeout·출력·Windows 명령행 길이 제한
- 기본 `plan` 모드, sandbox 강제, 명시적으로 허용하기 전에는 unsandboxed 실행 거부
- 채팅/사용자 allowlist와 소유자 전용 OAuth; 그룹 설정이 불완전하면 시작 실패
- Telegram forum topic별 상태·작업·업로드·응답 라우팅 격리
- private per-run CLI log에서 native conversation/project UUID를 복구해 `--conversation` 재개
- 문서화되지 않은 로그 계약이 없을 때 제한된 로컬 transcript 폴백
- Telegram `update_id` 기반 durable journal, 중복 억제, 교차 저장소 crash 복구, 완료를 입증할 수 없을 때만 명시적 `/retry`
- 사용자별/전역 rolling 작업 횟수와 UTC 일일 실행시간 예산을 내구 저장하고 crash를 보수적으로 정산
- 전역/사용자별 admission limit, queue timeout, 같은 workspace 직렬화, 세션 취소, data 디렉터리 단일 인스턴스 lock
- 업로드별 job 디렉터리, 파일/전체 quota, TTL 정리, 해당 job 디렉터리만 `--add-dir`로 전달
- 결과 전송의 제한된 Telegram 재시도와 불확실한 부분 전송을 복구하는 `/last`
- macOS launchd, Linux systemd user, Windows Task Scheduler를 다루는 native service CLI

## 요구 사항과 호환성

- 현재 지원 중인 Node.js LTS인 **Node.js 22 또는 24**
- Telegram Bot Token과 숫자형 chat/user ID
- 서비스를 실행할 OS 계정에서 접근 가능한 Antigravity CLI
- 그 계정에서 동작하는 OS credential store

현재 구현과 native conversation 재개 경로는 로컬의 `agy 1.1.1`로 검증했습니다. conversation/project UUID를 얻는 per-run log 문자열은 공식 structured API로 문서화된 계약이 아닙니다. 이후 CLI에서 형식이 바뀌면 봇은 모델 출력의 UUID를 신뢰하지 않고 제한된 로컬 transcript로 폴백합니다. native conversation ID를 복구하지 못하면 `/apply`는 계획을 잘못 이어 붙이지 않고 거부합니다.

설치 전에 확인하세요.

```text
node --version
agy --version
agy models
```

`agy models` 성공은 실행 파일과 PATH 점검일 뿐 OAuth 완료 증거가 아닙니다. 인증은 실제 headless 요청이나 `/auth`로 확인합니다.

### Windows의 네이티브 실행 파일 요구사항

Windows에서는 네이티브 `agy.exe`가 필요합니다. 이 프로젝트는 `.cmd`, `.bat`, `.ps1` launcher와 npm의 `agy.cmd` shim을 의도적으로 거부합니다. 그런 파일을 실행하려면 셸이 필요하기 때문입니다. 필요하면 네이티브 실행 파일의 절대 경로를 지정하세요.

```dotenv
AGY_BIN=C:\Users\<Username>\AppData\Local\agy\bin\agy.exe
```

`agy.cmd`만 발견되면 시작과 `doctor`는 실패-폐쇄됩니다. shim을 `AGY_BIN`에 넣지 말고 네이티브 `agy.exe`를 설치하거나 찾으세요.

## 소스 checkout에서 설치

운영용 `.env`를 다른 머신에서 복사하지 마세요. 로컬에서 만들고 secret을 쓰기 전에 권한부터 제한하세요.

### macOS / Linux

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

### Windows PowerShell

```powershell
git clone https://github.com/parkjangwon/antigravity-telegram-cli.git
Set-Location antigravity-telegram-cli
node --version
agy.exe --version
npm ci
Copy-Item .env.example .env
$account = "$env:USERDOMAIN\$env:USERNAME"
# DATA_DIR를 먼저 편집하세요. custom 값을 사용하면 아래 $dataDir를
# 그 값의 실제 절대 경로로 바꾼 뒤 ACL을 적용해야 합니다.
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

POSIX의 `install -m 600`은 secret을 넣기 전부터 private 파일을 만듭니다. Windows에서는 위 `icacls`로 `.env`와 전체 data tree를 현재 계정 전용으로 제한하세요. `DATA_DIR`를 바꿨다면 `$dataDir`도 기본 예시가 아니라 동일한 실제 절대 경로여야 합니다. 두 ACL을 검토한 뒤에만 `.env`의 `WINDOWS_ACL_VERIFIED=true`를 설정하세요. 이 확인이 없으면 Windows 시작과 `doctor`가 실패-폐쇄됩니다.

최소 설정은 다음과 같습니다.

```dotenv
BOT_TOKEN=123456:replace-me
ALLOWED_CHAT_IDS=858588087
OWNER_USER_IDS=858588087
WORKSPACE_DIR=/absolute/path/to/a/project
AGY_BIN=/absolute/path/to/agy
```

Windows에서는 Windows 절대 경로를 사용하고 `AGY_BIN=C:\absolute\path\to\agy.exe`로 설정하세요. Native service preflight는 `agy`가 절대 실행 경로로 resolve될 것을 요구하므로 명시적 값이 interactive shell의 PATH 차이를 없앱니다. 그룹/supergroup의 chat ID는 음수이며, 이 경우 `ALLOWED_USER_IDS`가 필수입니다.

```dotenv
ALLOWED_CHAT_IDS=858588087,-1001234567890
ALLOWED_USER_IDS=858588087,123456789
OWNER_USER_IDS=858588087
```

허용된 개인 채팅이 정확히 하나이고 `ALLOWED_USER_IDS`가 없으면 그 개인 사용자를 owner로 추론합니다. 여러 사용자 또는 그룹 설정에서는 `OWNER_USER_IDS`가 필수이며 allowed user의 부분집합이어야 합니다. `/auth`는 owner만 실행할 수 있습니다.

전체 설정과 limit은 [.env.example](.env.example)에 있습니다.

## 최초 실행과 OAuth

1. `npm run doctor`를 실행한 뒤 `npm start`로 실행하거나 native service를 설치합니다.
2. 허용된 Telegram 채팅에서 `/start`를 보냅니다.
3. 허용된 owner의 **개인 채팅**에서 `/auth`를 보냅니다.
4. 표시된 URL을 아무 브라우저에서 열고 OAuth를 마친 뒤 발급 코드를 일반 메시지로 보냅니다.
5. 봇은 코드를 `agy` stdin으로 전달하고 Telegram 메시지 삭제를 시도한 다음, plan-mode headless 요청으로 인증을 검증합니다.

기본값은 `AUTH_PRIVATE_ONLY=true`, `AUTH_FORCE_REMOTE=true`입니다. 봇은 Antigravity token 파일을 직접 읽거나 쓰지 않습니다. credential 저장과 지속성은 `agy`와 OS credential store의 책임입니다.

OS 사용자/keyring 하나에는 이 봇이 사용하는 실질적인 `agy` 계정도 하나입니다. 모든 허용 채팅과 topic이 그 계정을 공유합니다. Telegram owner를 여러 명 지정해도 Antigravity identity가 분리되지 않으며, owner가 재인증하면 같은 OS 사용자로 실행되는 모든 세션의 계정이 바뀝니다.

## Telegram 명령어

| 명령 | 동작 |
|---|---|
| `/plan <요청>` | 저장된 mode를 바꾸지 않고 plan-mode 요청을 실행합니다. |
| `/apply [추가 지시]` | 마지막 성공 `/plan`의 native conversation을 `accept-edits`와 기본 sandbox로 이어 실행합니다. |
| `/status` | 로컬 queue/run 단계와 경과 시간 또는 최근 작업을 표시합니다. |
| `/last` | 마지막으로 저장된 성공 `agy` 응답을 다시 보냅니다. |
| `/jobs` | 이 세션의 최근 durable job 10개를 표시합니다. |
| `/retry <작업 ID>` | 실패·취소·중단된 비수정 job을 재시도합니다. 수정 가능 job은 변경 내용을 확인한 뒤 `/retry <ID> confirm`이 필요합니다. |
| `/new` | 문맥을 비우고 다음 요청에 `--new-project`를 사용합니다. |
| `/model [이름\|default]` | 실제 `agy models` 조회, 선택, 기본값 복귀 |
| `/agent [이름\|default]` | 실제 `agy agents` 조회, 선택, 기본값 복귀 |
| `/mode [plan\|code]` | 영구 mode 조회/변경. `code`는 `accept-edits`입니다. |
| `/sandbox [on\|off]` | 세션 설정 조회 또는 명시적 변경. 정책에서 unsandboxed를 허용하지 않으면 `off`를 거부합니다. |
| `/workspace [경로]` | 허용 root 안의 real path 조회/선택. 전환 시 대화 문맥을 초기화합니다. |
| `/project [ID\|clear]` | 명시적 `agy` project 지정/해제 후 문맥 초기화 |
| `/info` | 작업공간, 대화 연속성, 모델, agent, mode, sandbox 정책, 실행 여부 표시 |
| `/auth` | headless OAuth/재인증. 기본적으로 owner 전용·개인 채팅 전용입니다. |
| `/cancel` | 현재 세션의 요청 또는 인증 프로세스 취소 |
| `/reset` | 이 세션과 업로드 초기화. OS credential은 유지합니다. |
| `/help` | 도움말 |

일반 텍스트는 prompt job을 만들고, 문서/사진은 새 upload job 디렉터리로 받은 뒤 그 디렉터리만 해당 호출에 전달합니다.

Telegram forum에서는 `chat_id:message_thread_id`가 세션 key입니다. 대화 상태, job, upload, 응답이 topic별로 나뉩니다. 단, 같은 workspace를 선택할 수 있고 OS credential도 공유합니다. 동일한 canonical workspace에 대한 실행은 직렬화됩니다.

## 안전한 기본값과 명시적 해제

기본 정책은 다음과 같습니다.

```dotenv
DEFAULT_MODE=plan
DEFAULT_SANDBOX=true
SANDBOX_PLAN_APPLY=true
ALLOW_UNSANDBOXED_RUNS=false
ALLOW_UNSANDBOXED_AUTO_APPROVE=false
```

`ALLOW_UNSANDBOXED_RUNS=false`이면 과거 state나 명령에서 sandbox off를 요청해도 실행 계층이 sandbox를 강제합니다. sandbox에서는 다음 플래그를 함께 사용합니다.

```text
--sandbox --dangerously-skip-permissions
```

자동 승인은 `agy` sandbox가 실제로 제한하는 범위 안에서만 의미가 있습니다. 이 프로젝트는 그 sandbox를 독립적으로 감사된 보안 경계라고 주장하지 않습니다. 작업공간을 좁게 유지하고, 백업과 전용 저권한 OS 계정을 사용하세요.

unsandboxed agent 실행을 허용하려면 관리자가 명시적으로 다음을 설정해야 합니다.

```dotenv
ALLOW_UNSANDBOXED_RUNS=true
```

unsandboxed 자동 권한 우회는 별도의 더 위험한 opt-in이며 위 설정 없이는 켤 수 없습니다.

```dotenv
ALLOW_UNSANDBOXED_AUTO_APPROVE=true
```

## 대화 연속성

각 prompt마다 봇은 private `data/runtime/agy/<timestamp>-<uuid>.log`를 만들고 `agy --log-file`로 전달합니다. 로컬 `agy 1.1.1`에서 확인한 정확한 CLI log line만 conversation/project UUID로 받아들이며, 모델 stdout의 UUID 모양 텍스트는 신뢰하지 않습니다. POSIX에서는 파일 mode `0600`을 사용하고 기본적으로 parse 직후 삭제합니다.

이 log 형식은 문서화된 계약이 아닙니다. 형식이 없거나 바뀌면 세션별 user/assistant transcript를 제한된 크기로 다음 `--print` 인자에 포함합니다. 채팅을 섞을 수 있는 머신 전역 `--continue`는 사용하지 않습니다. native ID parser를 끄려면 `AGY_CAPTURE_RUN_METADATA=false`로 설정하세요. `/info`에서 native conversation인지 transcript fallback인지 확인할 수 있습니다.

유지된 log와 crash 잔여 log는 시작 시와 매시간 TTL·전체 quota로 정리됩니다. run log에는 민감한 운영 정보가 있을 수 있으므로 `AGY_KEEP_RUN_LOGS=false`를 권장합니다.

## Durable job, 전송, 업로드

`data/jobs.json`은 Telegram `update_id`를 key로 쓰는 제한된 atomic journal입니다. 같은 update가 다시 오더라도 두 번째 코딩 작업을 만들지 않습니다. 재시작할 때 `queued`/`running` job은 먼저 `interrupted`로 표시하며 자동 재실행하지 않습니다. Telegram update를 받기 전에 journal·결과·세션 저장소를 대조합니다. 동일 job의 완료 state marker와 결과가 모두 있으면 전송 대기 중인 `succeeded`로 복구합니다. 결과만 commit된 crash 지점도 `succeeded`로 복구하지만, commit되지 않은 native conversation/project ID는 재사용하지 않고 다음 요청을 새 project로 시작합니다. 완료를 입증할 수 없는 job만 `interrupted`로 남겨 확인 후 `/retry`하게 합니다. 복구 후보 전체는 대조가 끝날 때까지 고정되므로 history 정리가 중간 후보를 지우지 않습니다.

Journal에 넣기 전 admission은 `MAX_PENDING_AGY_JOBS`, `MAX_PENDING_AGY_JOBS_PER_USER`로 제한하며 chat/topic 하나에는 admitted job 하나만 허용합니다. 전역 실행 semaphore를 기다리는 job은 `AGY_QUEUE_TIMEOUT_MS`를 넘으면 실패하고, `MAX_UPDATE_AGE_SECONDS`보다 오래된 Telegram backlog는 실행하지 않습니다. 새 job은 workspace, conversation/project, model, agent, mode, sandbox, transcript digest, 세션 수명 generation, 실행 revision을 고정합니다. 무해한 `/start` touch나 전송 상태 기록은 job을 무효화하지 않지만 reset 후 재생성은 항상 generation을 바꿉니다. 외부 파일 변경까지 암호학적으로 고정하는 것은 아니므로 수정 가능 job 재시도에는 추가 `confirm`이 필요합니다.

`agy` child를 시작하기 직전에 `data/usage.json`이 `USAGE_WINDOW_MINUTES` 구간의 사용자별/전역 작업 횟수와 UTC 날짜별 누적 실행시간 예산을 atomic하게 검사합니다. 동시 실행이 예산을 초과하지 않도록 먼저 `AGY_TIMEOUT_MS` 전체를 예약하고, 성공·실패·취소 뒤 실제 측정 시간으로 바꿉니다. 활성 예약을 남긴 채 process가 crash하면 다음 시작 시 전체 예약 시간을 보수적으로 부과합니다. usage store 읽기·쓰기·크기 오류는 실패-폐쇄되어 새 `agy` process를 시작하지 않습니다. `.env`의 `MAX_AGY_*_PER_WINDOW`, `MAX_AGY_RUNTIME_*_PER_DAY`, `USAGE_RETENTION_DAYS`, `USAGE_STORE_MAX_BYTES`로 조정할 수 있습니다.

journal에는 정리된 request payload와 제한된 결과가 저장되므로 프로젝트 prompt, caption, Telegram file ID, 응답 text가 남을 수 있습니다. 별도 `metadata.audit` 객체에는 actor user/chat과 Telegram message/update 식별자만 기록하며 prompt 모양 audit field는 버립니다. `data` 전체를 보호하고 `JOB_*` limit을 운영 환경에 맞추세요. data 디렉터리는 한 프로세스만 사용할 수 있으며 private PID/token lock이 중복 service/manual 실행을 거부합니다.

결과 전송은 Telegram 429, server error, 일시적 network failure를 제한된 횟수로 재시도합니다. 전체 결과는 TTL/quota가 있는 별도 파일 저장소에 두며, 큰 재전송은 파일을 streaming하고 `/last` 자체에도 admission과 byte cap을 적용합니다. Telegram이 메시지를 받았지만 client가 error를 봤다면 일부가 중복될 수 있으므로 exactly-once 보장은 아닙니다.

업로드는 `data/uploads/<session>/<job>/file`로 격리하고 파일별 크기를 제한하며 그 job의 `agy` 호출에만 전달합니다. 시작 시와 매시간 만료 job을 지우고 전체 quota를 넘으면 오래된 완료 항목부터 지웁니다. `/reset`은 현재 chat/topic scope의 업로드를 제거합니다.

## Native service 운영

먼저 dry-run으로 실제 정의와 argv를 확인하세요. dry-run은 호스트를 변경하지 않습니다.

```text
node bin/agygram.js doctor
node bin/agygram.js service install --dry-run
node bin/agygram.js service install
node bin/agygram.js service status
node bin/agygram.js service uninstall
```

`service install`은 실행 파일·소스·supervisor 경로를 먼저 감사한 뒤 `doctor`를 실행하며, 어느 쪽이든 실패하면 service를 변경하지 않습니다. 정의에는 Node/project/`DATA_DIR` 절대 경로가 고정되므로 checkout을 옮기거나 `DATA_DIR` 또는 version manager의 Node 설치를 바꿨다면 다시 install하세요.

- macOS: 현재 사용자의 LaunchAgent입니다. GUI login domain에서 시작하며 로그인 전에는 시작하지 않습니다.
- Linux: `systemd --user` service입니다. linger 활성화를 시도하지만 정책상 관리자 도움이 필요할 수 있습니다. Secret Service/D-Bus의 지속성은 운영자가 구성해야 합니다.
- Windows: `InteractiveToken`을 쓰는 현재 사용자 Task Scheduler task입니다. 설치·제거 시 실행 중인 봇에 먼저 lifecycle 종료 요청을 보내 active 작업을 취소하고 task 종료를 기다립니다. 응답하지 않을 때는 등록된 task process를 검증한 뒤 고정된 `taskkill.exe /T /F`로 알려진 자식 `agy` tree까지 종료하고 Task Scheduler 종료로 전환합니다. 사용자 logon 때 시작하고 화면 잠금 중에는 실행할 수 있지만 재부팅 후 첫 로그인 전에는 실행하지 않습니다.

경로, log, 제약, 복구 명령은 [Cross-platform operations](docs/CROSS_PLATFORM_OPERATIONS.md)를 참고하세요.

## 반드시 이해해야 할 보안 경계

Telegram text는 현재 `agy`의 `--print` 프로세스 인자 값으로 전달됩니다. `shell: false`는 셸 인젝션을 막지만 인자를 비밀로 만들지는 않습니다. 호스트 정책에 따라 root/administrator와 다른 로컬 프로세스, 특히 같은 OS 사용자 프로세스가 인자를 볼 수 있습니다. transcript fallback에서는 더 많은 문맥이 인자에 들어갑니다. prompt에 secret을 넣지 말고 전용 계정/호스트와 가능한 process visibility 제한을 사용하세요.

gateway와 runner를 같은 UID의 두 프로세스로 나누는 것은 구조와 재시작 격리에는 도움이 되지만 보안 경계는 아닙니다. 두 프로세스는 process visibility, 파일, signal 권한, environment 접근 권한, keyring을 공유합니다. 실제 경계가 필요하면 서로 다른 OS identity, container/VM, filesystem 권한, 별도 credential을 사용해야 합니다.

취소 시 bounded process-tree 종료 escalation이 끝날 때까지 기다리지만 이는 격리 보장이 아니라 정리 절차입니다. POSIX snapshot 전에 double-fork 후 reparent되었거나 snapshot 뒤 생성·reparent된 자손은 탐지에서 벗어날 수 있습니다. 이런 프로세스는 run-log watcher 종료 뒤에도 쓸 수 있으므로 hard disk ceiling에는 host filesystem quota가 필요합니다. 강한 자손 격리가 필요하면 cgroup/container 또는 Windows Job Object를 사용해야 합니다.

현재 `agy --print` 인터페이스에는 문서화된 structured live tool-event stream이 없습니다. `/status`는 preparing, workspace 대기, `agy` 실행, state 저장, 결과 전송 같은 **봇 내부 단계**만 표시하고 Telegram typing은 생존 신호일 뿐입니다. 관찰할 수 없는 token stream, tool call, approval event, 진행률을 꾸며내지 않습니다.

## 검증

```text
npm run doctor
npm test
```

단위 테스트는 process 인자/종료, UTF-8 출력, Windows 실행 파일 정책, state/job 지속성, update idempotency, forum 라우팅, workspace 경계, upload 정리, Telegram retry 분류, lifecycle race, service template, instance lock을 검사합니다. 각 실제 호스트에서 OAuth와 prompt smoke test를 별도로 해야 합니다.

설계와 threat boundary는 [docs/DESIGN.md](docs/DESIGN.md)를 참고하세요.
