import { AgyError } from '../agy.js';
import { BusyError } from '../tasks.js';
import { UsageLimitError } from '../usage-store.js';

export const PRIVATE_CLEAR_SWEEP_LIMIT = 5_000;
export const WARN_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
export const NOTIFY_COOLDOWN_MS = 60 * 60 * 1_000;

const warningCooldowns = new Map();
const notifyCooldowns = new Map();

export function warnWithCooldown(key, message, cooldownMs = WARN_COOLDOWN_MS) {
  const now = Date.now();
  const nextAllowed = warningCooldowns.get(key) || 0;
  if (now < nextAllowed) return false;
  warningCooldowns.set(key, now + cooldownMs);
  console.warn(message);
  return true;
}

/**
 * Send a Telegram notification to the first available owner chat, with a
 * per-key cooldown to prevent flooding. Returns true if the message was sent.
 */
export async function notifyOwnerWithCooldown(bot, ownerChatIds, key, text, cooldownMs = NOTIFY_COOLDOWN_MS) {
  const now = Date.now();
  const nextAllowed = notifyCooldowns.get(key) || 0;
  if (now < nextAllowed) return false;
  notifyCooldowns.set(key, now + cooldownMs);
  const chatId = [...ownerChatIds][0];
  if (!chatId || !bot?.telegram) return false;
  try {
    await bot.telegram.sendMessage(chatId, text);
    return true;
  } catch (error) {
    console.warn('Owner notification failed', { key, message: error?.message });
    return false;
  }
}

export function formatError(error) {
  if (error instanceof BusyError) {
    return '이미 이 채팅의 작업이 진행 중입니다. 중단하려면 /cancel 을 사용하세요.';
  }
  if (error?.code === 'TASK_QUEUE_TIMEOUT') {
    return '서버가 바빠 작업이 대기열 제한 시간을 넘어 실행 전에 중단되었습니다. 1~2분 뒤 다시 시도하거나 /status 로 현재 상태를 확인하세요.';
  }
  if (error?.code === 'JOB_CONTEXT_CHANGED') return error.message;
  if (error instanceof UsageLimitError) {
    const retry = error.retryAt ? ` 재시도 가능 시각(UTC): ${error.retryAt}` : '';
    if (error.code === 'USAGE_USER_JOB_LIMIT') {
      return `사용자별 rolling agy 작업 한도에 도달했습니다.${retry}`;
    }
    if (error.code === 'USAGE_GLOBAL_JOB_LIMIT') {
      return `봇 전체 rolling agy 작업 한도에 도달했습니다.${retry}`;
    }
    if (error.code === 'USAGE_USER_RUNTIME_LIMIT') {
      return `사용자별 일일 agy 실행시간 예산에 도달했습니다.${retry}`;
    }
    if (error.code === 'USAGE_GLOBAL_RUNTIME_LIMIT') {
      return `봇 전체 일일 agy 실행시간 예산에 도달했습니다.${retry}`;
    }
  }
  if (['STATE_SESSION_LIMIT', 'STATE_SIZE_LIMIT'].includes(error?.code)) {
    return '세션 상태 저장 한도에 도달했습니다. 오래된 토픽에서 /reset 을 실행하거나 운영 설정을 점검하세요.';
  }
  if (error instanceof AgyError) {
    switch (error.code) {
      case 'AGY_NOT_FOUND':
        return 'agy 실행 파일을 찾지 못했습니다. 서버의 PATH 또는 AGY_BIN을 확인하세요.';
      case 'AGY_VERSION_UNSUPPORTED':
        return '지원되지 않는 agy 버전입니다. AGY_MIN_VERSION 이상으로 업그레이드하세요.';
      case 'AGY_AUTH_REQUIRED':
        return 'agy 인증이 필요하거나 만료되었습니다. /auth 를 실행하세요.';
      case 'AGY_CANCELLED':
        return '작업을 취소했습니다.';
      case 'AGY_TIMEOUT':
        return 'agy 작업 시간이 초과되었습니다. 더 작은 작업으로 나누거나 AGY_TIMEOUT_MS를 늘려보세요.';
      case 'AGY_OUTPUT_LIMIT':
        return 'agy 출력이 설정된 크기 제한을 초과해 중단했습니다.';
      case 'AGY_RUN_LOG_LIMIT':
      case 'AGY_RUN_LOG_WATCH_FAILED':
        return 'agy 실행 로그가 안전 한도를 벗어나 작업을 중단했습니다. 서버 로그와 저장 공간을 확인하세요.';
      case 'AGY_ARGV_LIMIT':
        return '요청과 대화 기록이 운영체제의 안전한 명령행 길이를 초과했습니다. /new 후 요청을 나누어 보내세요.';
      case 'AGY_EMPTY_OUTPUT':
        return 'agy가 빈 응답을 반환했습니다. agy 1.1.1 이상인지 확인하고 다시 시도하세요.';
      default:
        return `agy 실행에 실패했습니다 (${error.code || 'AGY_FAILED'}). 민감한 출력은 Telegram에 표시하지 않습니다. 서버 로그와 npm run doctor를 확인하세요.`;
    }
  }
  return `요청 처리 중 내부 오류가 발생했습니다 (${error?.code || 'INTERNAL_ERROR'}). 서버 로그와 npm run doctor를 확인하세요.`;
}

export function normalizeChoice(value) {
  return value.trim().toLocaleLowerCase('en-US');
}

export function detach(promise, context, tracker) {
  const tracked = tracker ? tracker.trackExisting(promise) : promise;
  tracked.catch((error) => {
    console.error('Detached task failed', {
      context,
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
  });
  return tracked;
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}분 ${seconds % 60}초`;
}

export const QUICK_HELP_TEXT = `agygram

그냥 메시지를 보내면 현재 작업공간에서 agy가 처리합니다.
자주 쓰는 설정은 아래 버튼으로 바꾸세요.

추천 흐름
1. 처음이면 🔐 인증
2. 🧠 모델 / 👤 에이전트 / 🧩 스킬 선택
3. 이상하면 🩺 점검
4. ⚙️ 모드 선택 후 메시지 전송

전체 명령어 텍스트가 필요하면 /help full`;

export const HELP_TEXT = `agygram

일반 메시지를 보내면 현재 작업공간에서 agy headless 모드로 처리합니다.

/menu — Telegram 버튼 조작 패널 열기
/new — 대화 기록을 비우고 다음 요청에서 새 agy 프로젝트 시작
/plan <요청> — 수정 없이 계획 생성
/apply [추가 지시] — 직전 계획을 sandbox code 모드로 실행
/model [이름|default] — 모델 목록을 버튼으로 조회·전환
/agent [이름|default] — 에이전트 목록을 버튼으로 조회·전환
/skills [검색어] — 설치된 agent skill을 페이지 버튼으로 선택
/mode [plan|code|accept-edits|yolo] — 실행 모드를 버튼으로 전환
/sandbox [on|off] — 샌드박스를 버튼으로 조회·설정
/yolo [on|off] — accept-edits + unsandboxed 자동 승인 전환
/workspace [경로] — 허용된 작업공간 조회 또는 전환
/project [ID|clear] — 명시적 agy 프로젝트 지정
/info — 현재 세션 상태
/doctor — 설치·인증·작업공간 상태 점검
/status — 현재 작업의 ID·단계·경과 시간
/clear — 최근 봇/사용자 메시지를 가능한 범위에서 삭제
/last — 마지막 agy 응답 다시 받기
/jobs — 최근 내구 작업 기록
/retry <작업ID> — 실패·취소·중단된 작업 재시도
/auth — agy headless OAuth 인증/재인증
/update [apply] — 공식 immutable 릴리즈 확인 또는 소유자 업데이트
/cancel — 현재 agy 또는 인증 작업 중단
/reset — 현재 채팅의 설정·기록 초기화
/help — 이 도움말

문서나 사진을 보내면 안전한 업로드 디렉터리에 저장한 뒤 agy가 읽도록 전달합니다.`;
