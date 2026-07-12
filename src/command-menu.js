import { retryTelegramCall } from './telegram.js';

export const BOT_COMMANDS = Object.freeze([
  { command: 'start', description: '봇 시작 및 인증 상태 확인' },
  { command: 'plan', description: '수정 없이 구현 계획 생성' },
  { command: 'apply', description: '직전 계획을 sandbox에서 구현' },
  { command: 'new', description: '새 대화와 agy 프로젝트 시작' },
  { command: 'model', description: '모델 목록 조회 또는 전환' },
  { command: 'agent', description: '에이전트 목록 조회 또는 전환' },
  { command: 'mode', description: 'plan/code 모드 전환' },
  { command: 'sandbox', description: '샌드박스 조회 또는 설정' },
  { command: 'workspace', description: '작업공간 조회 또는 전환' },
  { command: 'project', description: 'agy 프로젝트 지정' },
  { command: 'info', description: '현재 세션 상태' },
  { command: 'status', description: '현재 작업 단계와 경과 시간' },
  { command: 'last', description: '마지막 agy 응답 다시 받기' },
  { command: 'jobs', description: '최근 내구 작업 기록' },
  { command: 'retry', description: '실패·취소·중단 작업 재시도' },
  { command: 'auth', description: 'agy 인증 또는 재인증' },
  { command: 'update', description: '공식 릴리즈 확인 또는 업데이트' },
  { command: 'cancel', description: '현재 작업 중단' },
  { command: 'reset', description: '현재 채팅 상태 초기화' },
  { command: 'help', description: '명령어 도움말' },
]);

// Telegram resolves a chat- and language-specific command scope before the
// default scope. Keep the current Korean menu explicit so a command list left
// by an older bot implementation cannot win that resolution.
const LANGUAGE_CODES = [undefined, 'ko'];

function payloadFor(scope, languageCode) {
  return {
    ...(scope ? { scope } : {}),
    ...(languageCode ? { language_code: languageCode } : {}),
  };
}

function chatScope(chatId) {
  const numericChatId = Number(chatId);
  if (!Number.isSafeInteger(numericChatId)) {
    throw new Error(`Invalid Telegram chat ID for command menu: ${chatId}`);
  }
  return { type: 'chat', chat_id: numericChatId };
}

async function replaceScopeCommands(bot, { scope, label, languageCode, signal }) {
  const payload = payloadFor(scope, languageCode);
  const languageLabel = languageCode || 'default language';
  const operation = `${label} command menu (${languageLabel})`;

  // setMyCommands replaces the commands at this exact scope. Deleting first
  // also removes stale lists when the new command set is temporarily empty or
  // a prior deployment used a different language/scope combination.
  await retryTelegramCall(
    (attemptSignal) => bot.telegram.callApi(
      'deleteMyCommands',
      payload,
      { signal: attemptSignal },
    ),
    { operation: `clear ${operation}`, signal },
  );
  await retryTelegramCall(
    (attemptSignal) => bot.telegram.callApi(
      'setMyCommands',
      { ...payload, commands: BOT_COMMANDS },
      { signal: attemptSignal },
    ),
    { operation: `set ${operation}`, signal },
  );
}

/**
 * Register the current menu globally and, for each permitted chat, at the
 * most-specific Telegram scope. Per-chat failures are logged but never stop
 * the bot from starting; a deleted/invalid group must not make private-chat
 * operation unavailable.
 */
export async function synchronizeBotCommandMenu(bot, {
  allowedChatIds,
  signal,
  logger = console,
} = {}) {
  for (const languageCode of LANGUAGE_CODES) {
    await replaceScopeCommands(bot, {
      label: 'default',
      languageCode,
      signal,
    });
  }

  for (const chatId of allowedChatIds || []) {
    for (const languageCode of LANGUAGE_CODES) {
      try {
        await replaceScopeCommands(bot, {
          scope: chatScope(chatId),
          label: `chat ${chatId}`,
          languageCode,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        logger.warn('Unable to synchronize a chat-specific command menu', {
          chatId: String(chatId),
          languageCode: languageCode || 'default',
          message: error?.message,
        });
      }
    }
  }
}
