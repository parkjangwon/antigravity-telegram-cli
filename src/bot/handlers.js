import { stopPollingWithoutOffsetCommit } from '../polling-backpressure.js';
import { BusyError } from '../tasks.js';
import {
  parseActionCallback,
  parseChoiceCallback,
} from '../interactive-ui.js';
import {
  classifyUpdateAge,
  commandArgument,
  guardTelegramClient,
  replyLong,
  sessionKey,
  startTyping,
  storageScope,
} from '../telegram.js';
import { clearChatUploads } from '../files.js';
import { resolveWorkspace } from '../workspace.js';
import {
  formatError,
  normalizeChoice,
} from './util.js';

/** Register Telegraf middleware and command/action handlers. */
export function registerHandlers(s) {
  const {
    acknowledgeChoice,
    actionKeyboard,
    activeJournalJobs,
    admissions,
    agy,
    allowedRoots,
    assertExecutionContext,
    auth,
    authOwners,
    backgroundActivities,
    bot,
    cancelActiveWork,
    checklistLine,
    cleanupInteractiveMenus,
    clearChatWindow,
    config,
    defaultWorkspace,
    defaultableChoices,
    disableYolo,
    enableYolo,
    executeRetry,
    finishChoiceMessage,
    formatReleaseNotes,
    formatSkillLabel,
    formatUpdatePanel,
    historyDigest,
    installTelegramMessageTracking,
    interactiveMenus,
    isIdle,
    isYoloSession,
    jobs,
    mainMenuRows,
    modeChoices,
    openAgentMenu,
    openChoiceMenu,
    openModeMenu,
    openModelMenu,
    openSandboxMenu,
    openSkillsMenu,
    openYoloMenu,
    prepareDurablePayload,
    rememberTelegramMessages,
    rememberTelegramResult,
    results,
    runAdmittedTask,
    runAgyRequest,
    runChoiceControl,
    runControl,
    runUpdateCommand,
    sandboxChoices,
    scheduleAgyRequest,
    sendDoctorPanel,
    sendFullHelp,
    sendJobsPanel,
    sendLastResponse,
    sendMainMenu,
    sendOnboardingPanel,
    sendPanel,
    sendRecoveryNotifications,
    sendSessionInfo,
    sendStatusPanel,
    skillChoices,
    skillPageSize,
    snapshotExecutionContext,
    startAuthFlow,
    state,
    tasks,
    uploadActiveLeaseMaxAgeMs,
    withCloseRow,
    workspaceFor,
    yoloChoices,
    yoloPolicyError,
    yoloStatus,
  } = s;

  // Authorization is deliberately the first middleware. Unknown chats receive no response.
  bot.use(async (ctx, next) => {
    guardTelegramClient(ctx.telegram);
    if (!ctx.chat || !config.allowedChatIds.has(String(ctx.chat.id))) return;
    if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(String(ctx.from?.id))) return;
    return next();
  });

  bot.use(async (ctx, next) => {
    installTelegramMessageTracking(ctx);
    return next();
  });

  // Exact rejected-ID intervals contain only updates whose handlers already
  // made a durable fail-closed decision. Suppress their Telegram redelivery
  // before any command, OAuth-input, file, or prompt handler can reinterpret it.
  bot.use(async (ctx, next) => {
    const existing = jobs.getByUpdateId(ctx.update?.update_id);
    if (existing?.tombstone && existing.decision === 'rejected') return;
    return next();
  });

  const staleNoticeChats = new Set();
  const staleSafeCommands = new Set(['help', 'info', 'menu', 'status', 'clear', 'doctor']);
  bot.use(async (ctx, next) => {
    const { stale, ageSeconds } = classifyUpdateAge(ctx, config.maxUpdateAgeSeconds, {
      safeCommands: staleSafeCommands,
    });
    if (!stale) return next();
    const chatId = String(ctx.chat.id);
    console.warn('Rejected stale Telegram update', {
      updateId: ctx.update?.update_id,
      chatId,
      ageSeconds,
    });
    if (!staleNoticeChats.has(chatId)) {
      staleNoticeChats.add(chatId);
      await ctx.reply(
        `안전을 위해 ${config.maxUpdateAgeSeconds}초보다 오래된 대기 요청은 실행하지 않았습니다. 필요한 요청을 다시 보내세요.`,
      );
    }
  });

  bot.start(async (ctx) => {
    const chatId = sessionKey(ctx);
    if (auth.hasAnyActive()) {
      await ctx.reply('agy 인증 작업이 진행 중입니다. 인증을 마친 뒤 /start 를 다시 실행하세요.');
      return;
    }
    const stopTyping = startTyping(ctx);
    try {
      await runAdmittedTask(ctx, 'probe:start', async (signal) => {
        if (auth.hasAnyActive()) throw new BusyError('Authentication is in progress');
        const session = await state.ensure(chatId);
        const cwd = await workspaceFor(session);
        const version = await agy.version({ cwd, signal });
        const catalogStatus = await agy.catalogStatus({ cwd, signal });
        let authStatus = null;
        try {
          authStatus = await agy.authenticationStatus({ cwd, signal });
        } catch {
          authStatus = { authenticated: false };
        }
        await sendOnboardingPanel(ctx, {
          agyVersion: version,
          catalogStatus,
          authStatus,
          workspace: cwd,
          prefix: 'agygram이 준비되었습니다.',
        });
      });
    } catch (error) {
      await sendMainMenu(ctx, { prefix: `봇 세션은 생성했지만 agy 점검에 실패했습니다.\n\n${formatError(error)}` });
    } finally {
      stopTyping();
    }
  });

  bot.command('menu', (ctx) => sendMainMenu(ctx));

  bot.command('clear', async (ctx) => {
    await clearChatWindow(ctx);
  });

  bot.command('help', async (ctx) => {
    if (normalizeChoice(commandArgument(ctx)) === 'full') {
      await sendFullHelp(ctx);
      return;
    }
    await sendMainMenu(ctx);
  });

  bot.action(/^tg:/, async (ctx) => {
    const action = parseActionCallback(ctx.callbackQuery?.data);
    if (!action) {
      await acknowledgeChoice(ctx, '알 수 없는 버튼입니다.', { alert: true });
      return;
    }
    await acknowledgeChoice(ctx, '처리 중...');
    if (action.startsWith('retry-')) {
      const jobId = action.slice(6);
      await executeRetry(ctx, jobId, '');
      return;
    }
    if (action.startsWith('confirm-')) {
      const jobId = action.slice(8);
      await executeRetry(ctx, jobId, 'confirm');
      return;
    }
    switch (action) {
      case 'menu':
        await sendMainMenu(ctx, { edit: true });
        return;
      case 'close':
        await ctx.deleteMessage().catch(() =>
          ctx.editMessageText('메뉴를 닫았습니다.').catch(() => {}));
        return;
      case 'info':
        await sendSessionInfo(ctx, { edit: true });
        return;
      case 'status':
        await sendStatusPanel(ctx, { edit: true });
        return;
      case 'doctor':
        await sendDoctorPanel(ctx, { edit: true });
        return;
      case 'model':
        await openModelMenu(ctx, { edit: true });
        return;
      case 'agent':
        await openAgentMenu(ctx, { edit: true });
        return;
      case 'skills':
        await openSkillsMenu(ctx, { edit: true });
        return;
      case 'mode':
        await openModeMenu(ctx, { edit: true });
        return;
      case 'sandbox':
        await openSandboxMenu(ctx, { edit: true });
        return;
      case 'yolo':
        await openYoloMenu(ctx, { edit: true });
        return;
      case 'jobs':
        await sendJobsPanel(ctx, { edit: true });
        return;
      case 'clear':
        await clearChatWindow(ctx);
        return;
      case 'last':
        await sendLastResponse(ctx);
        return;
      case 'update':
        await runUpdateCommand(ctx);
        return;
      case 'update_apply':
        await runUpdateCommand(ctx, { apply: true });
        return;
      case 'auth':
        await startAuthFlow(ctx);
        return;
      case 'cancel':
        await cancelActiveWork(ctx);
        return;
      default:
        await acknowledgeChoice(ctx, '지원하지 않는 버튼입니다.', { alert: true });
    }
  });

  bot.action(/^ui:/, async (ctx) => {
    const parsed = parseChoiceCallback(ctx.callbackQuery?.data);
    if (!parsed) {
      await acknowledgeChoice(ctx, '알 수 없는 버튼입니다.', { alert: true });
      return;
    }
    cleanupInteractiveMenus();
    const menu = interactiveMenus.get(parsed.token);
    if (!menu) {
      await acknowledgeChoice(ctx, '만료된 메뉴입니다. 명령을 다시 실행하세요.', { alert: true });
      return;
    }
    if (menu.sessionKey !== sessionKey(ctx)) {
      await acknowledgeChoice(ctx, '다른 채팅/토픽의 메뉴입니다.', { alert: true });
      return;
    }
    if (menu.actorUserId && menu.actorUserId !== String(ctx.from?.id ?? '')) {
      await acknowledgeChoice(ctx, '이 메뉴를 연 사용자만 선택할 수 있습니다.', { alert: true });
      return;
    }
    const choice = menu.choices[parsed.index];
    if (!choice) {
      await acknowledgeChoice(ctx, '선택지를 찾을 수 없습니다.', { alert: true });
      return;
    }
    if (choice.action === 'cancel') {
      interactiveMenus.delete(menu.token);
      await acknowledgeChoice(ctx, '닫았습니다.');
      await finishChoiceMessage(ctx, '선택을 취소했습니다.');
      return;
    }
    await runChoiceControl(ctx, async () => {
      const key = sessionKey(ctx);
      if (choice.action === 'yolo-on') {
        const policyError = await enableYolo(key);
        if (policyError) {
          await acknowledgeChoice(ctx, policyError, { alert: true });
          return;
        }
        await acknowledgeChoice(ctx, 'YOLO mode를 켰습니다.');
        await finishChoiceMessage(
          ctx,
          '⚡ YOLO mode: 켜짐\n\n다음 일반 요청부터 accept-edits + unsandboxed + --dangerously-skip-permissions로 실행합니다.\n개인 서버, 좁은 workspace, git 상태가 깨끗한 프로젝트에서만 사용하세요.',
        );
        interactiveMenus.delete(menu.token);
        return;
      }
      if (choice.action === 'yolo-off') {
        await disableYolo(key);
        await acknowledgeChoice(ctx, 'YOLO mode를 껐습니다.');
        await finishChoiceMessage(ctx, 'YOLO mode: 꺼짐\nsandbox code 모드로 전환했습니다.');
        interactiveMenus.delete(menu.token);
        return;
      }
      if (choice.action === 'skills-page') {
        await acknowledgeChoice(ctx, '페이지를 이동합니다.');
        interactiveMenus.delete(menu.token);
        await openSkillsMenu(ctx, { query: choice.query || '', page: choice.page || 0, edit: true });
        return;
      }
      if (choice.action === 'skill-set') {
        await state.update(key, (session) => ({ ...session, skill: choice.value }));
        await acknowledgeChoice(ctx, '스킬을 선택했습니다.');
        await finishChoiceMessage(
          ctx,
          `Agent skill: ${choice.value}\n다음 일반 요청부터 이 skill을 사용하도록 agy에 지시합니다.`,
        );
        interactiveMenus.delete(menu.token);
        return;
      }
      if (choice.action === 'skill-clear') {
        await state.update(key, (session) => ({ ...session, skill: null }));
        await acknowledgeChoice(ctx, '스킬 선택을 해제했습니다.');
        await finishChoiceMessage(ctx, 'Agent skill 선택을 해제했습니다.');
        interactiveMenus.delete(menu.token);
        return;
      }
      if (choice.action === 'noop') {
        await acknowledgeChoice(ctx, '현재 페이지입니다.');
        return;
      }
      switch (menu.type) {
        case 'model':
          await state.update(key, (session) => ({ ...session, model: choice.value }));
          await acknowledgeChoice(ctx, '모델을 변경했습니다.');
          await finishChoiceMessage(ctx, `모델: ${choice.value || 'agy 기본값'}`);
          interactiveMenus.delete(menu.token);
          return;
        case 'agent':
          await state.update(key, (session) => ({ ...session, agent: choice.value }));
          await acknowledgeChoice(ctx, '에이전트를 변경했습니다.');
          await finishChoiceMessage(ctx, `에이전트: ${choice.value || 'agy 기본값'}`);
          interactiveMenus.delete(menu.token);
          return;
        case 'mode':
          await state.update(key, (session) => ({ ...session, mode: choice.value }));
          await acknowledgeChoice(ctx, '실행 모드를 변경했습니다.');
          await finishChoiceMessage(ctx, `실행 모드: ${choice.value}`);
          interactiveMenus.delete(menu.token);
          return;
        case 'sandbox':
          if (choice.value === false && !config.allowUnsandboxedRuns) {
            await acknowledgeChoice(ctx, '운영 정책상 샌드박스를 끌 수 없습니다.', { alert: true });
            return;
          }
          await state.update(key, (session) => ({ ...session, sandbox: choice.value }));
          await acknowledgeChoice(ctx, '샌드박스 설정을 변경했습니다.');
          await finishChoiceMessage(
            ctx,
            choice.value
              ? '샌드박스: 켜짐 (--sandbox와 내부 자동 승인을 함께 사용)'
              : '샌드박스: 꺼짐 (대화형 권한 요청이 필요한 도구는 headless에서 실패할 수 있음)',
          );
          interactiveMenus.delete(menu.token);
          return;
        default:
          await acknowledgeChoice(ctx, '지원하지 않는 메뉴입니다.', { alert: true });
      }
    });
  });

  bot.command('status', async (ctx) => {
    await sendStatusPanel(ctx);
  });

  bot.command('doctor', async (ctx) => {
    await sendDoctorPanel(ctx);
  });

  bot.command('last', async (ctx) => {
    await sendLastResponse(ctx);
  });

  bot.command('jobs', async (ctx) => {
    await sendJobsPanel(ctx);
  });

  bot.command('retry', async (ctx) => {
    const [requested, confirmation] = commandArgument(ctx).split(/\s+/).filter(Boolean);
    if (!requested) {
      await ctx.reply('사용법: /retry <작업ID> — /jobs 에 표시된 실패·취소·중단 작업만 재시도합니다.');
      return;
    }
    await executeRetry(ctx, requested, confirmation);
  });

  bot.command('plan', async (ctx) => {
    const prompt = commandArgument(ctx);
    if (!prompt) {
      await ctx.reply('사용법: /plan 구현하거나 조사할 요청');
      return;
    }
    await scheduleAgyRequest(ctx, {
        type: 'request',
        prompt,
        kind: 'plan',
        sessionOverrides: { mode: 'plan' },
      });
  });

  bot.command('apply', async (ctx) => {
    const key = sessionKey(ctx);
    const session = state.get(key);
    if (tasks.isActive(key)) {
      await ctx.reply('현재 작업이 끝난 뒤 /apply 를 실행하세요.');
      return;
    }
    if (session.lastRun?.kind !== 'plan' || session.lastRun.status !== 'succeeded') {
      await ctx.reply('먼저 /plan <요청>으로 검토할 계획을 생성하세요.');
      return;
    }
    if (!session.conversationId) {
      await ctx.reply(
        'agy 네이티브 대화 ID를 복구하지 못해 계획을 안전하게 이어 실행할 수 없습니다. /plan 을 다시 실행하거나 AGY_CAPTURE_RUN_METADATA를 확인하세요.',
      );
      return;
    }
    const extra = commandArgument(ctx);
    const prompt = extra
      ? `방금 작성한 계획을 구현하세요. 추가 지시: ${extra}`
      : '방금 작성한 계획을 그대로 구현하세요. 완료 후 변경 내용과 검증 결과를 요약하세요.';
    await scheduleAgyRequest(ctx, {
        type: 'request',
        prompt,
        kind: 'apply',
        sessionOverrides: {
          mode: 'accept-edits',
          sandbox: config.sandboxPlanApply ? true : session.sandbox,
        },
      });
  });

  bot.command('new', async (ctx) => {
    await runControl(ctx, async () => {
      await state.update(sessionKey(ctx), (session) => ({
        ...session,
        conversationId: null,
        projectId: null,
        newProject: true,
        history: [],
      }));
      await ctx.reply('새 대화를 준비했습니다. 다음 메시지는 --new-project 로 시작합니다.');
    });
  });

  bot.command('model', async (ctx) => {
    const requested = commandArgument(ctx);
    if (!(await isIdle(ctx))) return;
    const chatId = sessionKey(ctx);
    const stopTyping = startTyping(ctx);
    try {
      await runAdmittedTask(ctx, 'probe:model', async (signal) => {
        if (auth.hasAnyActive()) throw new BusyError('Authentication is in progress');
        const session = state.get(chatId);
        const cwd = await workspaceFor(session);
        if (normalizeChoice(requested) === 'default') {
          await state.update(chatId, (current) => ({ ...current, model: null }));
          await ctx.reply('모델을 agy 기본값으로 되돌렸습니다.');
          return;
        }
        const models = await agy.models({ cwd, signal });
        if (!requested) {
          await openChoiceMenu(ctx, {
            type: 'model',
            title: '모델 선택',
            current: session.model || 'agy 기본값',
            choices: defaultableChoices({
              current: session.model,
              defaultLabel: 'agy 기본값',
              values: models,
            }),
            hint: '원하는 모델을 누르세요. 모델명이 길면 /model <이름> 직접 입력도 가능합니다.',
          });
          return;
        }
        const selected = models.find((model) => normalizeChoice(model) === normalizeChoice(requested));
        if (!selected) {
          await ctx.reply(`알 수 없는 모델입니다. /model 로 실제 목록을 확인하세요.`);
          return;
        }
        await state.update(chatId, (current) => ({ ...current, model: selected }));
        await ctx.reply(`모델: ${selected}`);
      });
    } catch (error) {
      await replyLong(ctx, formatError(error));
    } finally {
      stopTyping();
    }
  });

  bot.command('agent', async (ctx) => {
    const requested = commandArgument(ctx);
    if (!(await isIdle(ctx))) return;
    const chatId = sessionKey(ctx);
    const stopTyping = startTyping(ctx);
    try {
      await runAdmittedTask(ctx, 'probe:agent', async (signal) => {
        if (auth.hasAnyActive()) throw new BusyError('Authentication is in progress');
        const session = state.get(chatId);
        const cwd = await workspaceFor(session);
        if (normalizeChoice(requested) === 'default') {
          await state.update(chatId, (current) => ({ ...current, agent: null }));
          await ctx.reply('에이전트를 agy 기본값으로 되돌렸습니다.');
          return;
        }
        const agents = await agy.agents({ cwd, signal });
        if (!requested) {
          await openChoiceMenu(ctx, {
            type: 'agent',
            title: '에이전트 선택',
            current: session.agent || 'agy 기본값',
            choices: defaultableChoices({
              current: session.agent,
              defaultLabel: 'agy 기본값',
              values: agents,
            }),
            hint: agents.length > 0
              ? '원하는 에이전트를 누르세요. 에이전트명이 길면 /agent <이름> 직접 입력도 가능합니다.'
              : 'agy가 노출한 추가 에이전트가 없습니다. 기본값만 선택할 수 있습니다.',
          });
          return;
        }
        const selected = agents.find((agent) => normalizeChoice(agent) === normalizeChoice(requested));
        if (!selected) {
          await ctx.reply('알 수 없는 에이전트입니다. /agent 로 실제 목록을 확인하세요.');
          return;
        }
        await state.update(chatId, (current) => ({ ...current, agent: selected }));
        await ctx.reply(`에이전트: ${selected}`);
      });
    } catch (error) {
      await replyLong(ctx, formatError(error));
    } finally {
      stopTyping();
    }
  });

  bot.command('skills', async (ctx) => {
    const requested = commandArgument(ctx);
    if (!(await isIdle(ctx))) return;
    const chatId = sessionKey(ctx);
    const stopTyping = startTyping(ctx);
    try {
      await runAdmittedTask(ctx, 'probe:skills', async (signal) => {
        if (auth.hasAnyActive()) throw new BusyError('Authentication is in progress');
        if (normalizeChoice(requested) === 'clear') {
          await state.update(chatId, (session) => ({ ...session, skill: null }));
          await ctx.reply('Agent skill 선택을 해제했습니다.');
          return;
        }
        await openSkillsMenu(ctx, { query: requested, signal });
      });
    } catch (error) {
      await replyLong(ctx, formatError(error));
    } finally {
      stopTyping();
    }
  });

  bot.command('mode', async (ctx) => {
    await runControl(ctx, async () => {
      const requested = normalizeChoice(commandArgument(ctx));
      const aliases = { code: 'accept-edits', plan: 'plan', 'accept-edits': 'accept-edits' };
      if (!requested) {
        const current = state.get(sessionKey(ctx));
        await openChoiceMenu(ctx, {
          type: 'mode',
          title: '실행 모드 선택',
          current: isYoloSession(current) ? 'YOLO' : current.mode,
          choices: modeChoices(current),
        });
        return;
      }
      if (requested === 'yolo') {
        const policyError = await enableYolo(sessionKey(ctx));
        if (policyError) {
          await ctx.reply(policyError);
          return;
        }
        await ctx.reply(
          '⚡ YOLO mode: 켜짐\n\n다음 일반 요청부터 accept-edits + unsandboxed + --dangerously-skip-permissions로 실행합니다.\n개인 서버, 좁은 workspace, git 상태가 깨끗한 프로젝트에서만 사용하세요.',
        );
        return;
      }
      if (!aliases[requested]) {
        await ctx.reply('지원 모드는 plan, code(accept-edits), yolo입니다.');
        return;
      }
      await state.update(sessionKey(ctx), (session) => ({ ...session, mode: aliases[requested] }));
      await ctx.reply(`실행 모드: ${aliases[requested]}`);
    });
  });

  bot.command('yolo', async (ctx) => {
    await runControl(ctx, async () => {
      const requested = normalizeChoice(commandArgument(ctx));
      const key = sessionKey(ctx);
      const session = state.get(key);
      if (!requested) {
        await openChoiceMenu(ctx, {
          type: 'yolo',
          title: 'YOLO mode',
          current: yoloStatus(session),
          choices: yoloChoices(session),
          hint:
            '고위험 모드입니다. 켜면 다음 일반 요청부터 accept-edits + unsandboxed + --dangerously-skip-permissions로 실행합니다. 개인 서버, 좁은 workspace, git으로 저장된 프로젝트에서만 권장합니다.',
        });
        return;
      }
      if (['on', 'true', '1', 'enable', 'enabled'].includes(requested)) {
        const policyError = await enableYolo(key);
        if (policyError) {
          await ctx.reply(policyError);
          return;
        }
        await ctx.reply(
          '⚡ YOLO mode: 켜짐\n\n다음 일반 요청부터 accept-edits + unsandboxed + --dangerously-skip-permissions로 실행합니다.\n개인 서버, 좁은 workspace, git 상태가 깨끗한 프로젝트에서만 사용하세요.',
        );
        return;
      }
      if (['off', 'false', '0', 'disable', 'disabled'].includes(requested)) {
        await disableYolo(key);
        await ctx.reply('YOLO mode: 꺼짐\nsandbox code 모드로 전환했습니다.');
        return;
      }
      await ctx.reply('사용법: /yolo on 또는 /yolo off');
    });
  });

  bot.command('sandbox', async (ctx) => {
    await runControl(ctx, async () => {
      const requested = normalizeChoice(commandArgument(ctx));
      const current = state.get(sessionKey(ctx)).sandbox;
      let enabled;
      if (!requested) {
        await openChoiceMenu(ctx, {
          type: 'sandbox',
          title: '샌드박스 설정',
          current: config.allowUnsandboxedRuns
            ? (current ? '켜짐' : '꺼짐')
            : '강제 켜짐 (정책)',
          choices: sandboxChoices(config.allowUnsandboxedRuns ? current : true),
          hint: config.allowUnsandboxedRuns
            ? '실행 격리 정책을 선택하세요.'
            : '현재 운영 정책상 꺼짐은 선택할 수 없습니다.',
        });
        return;
      }
      else if (['on', 'true', '1'].includes(requested)) enabled = true;
      else if (['off', 'false', '0'].includes(requested)) enabled = false;
      else {
        await ctx.reply('사용법: /sandbox on 또는 /sandbox off');
        return;
      }
      if (!enabled && !config.allowUnsandboxedRuns) {
        await ctx.reply(
          '운영 정책상 샌드박스를 끌 수 없습니다. 호스트 위험을 이해한 경우에만 ALLOW_UNSANDBOXED_RUNS=true로 재시작하세요.',
        );
        return;
      }
      await state.update(sessionKey(ctx), (session) => ({ ...session, sandbox: enabled }));
      await ctx.reply(
        enabled
          ? '샌드박스: 켜짐 (--sandbox와 내부 자동 승인을 함께 사용)'
          : '샌드박스: 꺼짐 (대화형 권한 요청이 필요한 도구는 headless에서 실패할 수 있음)',
      );
    });
  });

  bot.command('workspace', async (ctx) => {
    await runControl(ctx, async () => {
      const requested = commandArgument(ctx);
      const session = state.get(sessionKey(ctx));
      if (!requested) {
        await replyLong(ctx, `현재 작업공간: ${await workspaceFor(session)}\n허용 루트:\n${allowedRoots.join('\n')}`);
        return;
      }
      try {
        const selected = await resolveWorkspace(requested, { defaultWorkspace, allowedRoots });
        await state.update(sessionKey(ctx), (current) => ({
          ...current,
          workspaceDir: selected,
          conversationId: null,
          projectId: null,
          newProject: true,
          history: [],
        }));
        await ctx.reply(`작업공간을 전환하고 대화 기록을 초기화했습니다.\n${selected}`);
      } catch (error) {
        await ctx.reply(`작업공간을 전환할 수 없습니다: ${error.message}`);
      }
    });
  });

  bot.command('project', async (ctx) => {
    await runControl(ctx, async () => {
      const requested = commandArgument(ctx);
      const current = state.get(sessionKey(ctx));
      if (!requested) {
        await ctx.reply(`현재 agy 프로젝트: ${current.projectId || '자동'}\n사용법: /project ID 또는 /project clear`);
        return;
      }
      if (normalizeChoice(requested) === 'clear') {
        await state.update(sessionKey(ctx), (session) => ({
          ...session,
          conversationId: null,
          projectId: null,
          newProject: true,
          history: [],
        }));
        await ctx.reply('명시적 프로젝트를 해제했습니다. 다음 요청에서 새 프로젝트를 만듭니다.');
        return;
      }
      if (requested.length > 256 || /[\r\n\u0000]/.test(requested)) {
        await ctx.reply('유효하지 않은 프로젝트 ID입니다.');
        return;
      }
      await state.update(sessionKey(ctx), (session) => ({
        ...session,
        conversationId: null,
        projectId: requested,
        newProject: false,
        history: [],
      }));
      await ctx.reply(`agy 프로젝트를 지정하고 대화 기록을 초기화했습니다.\n${requested}`);
    });
  });

  bot.command('info', async (ctx) => {
    await sendSessionInfo(ctx);
  });

  bot.command('reset', async (ctx) => {
    await runControl(ctx, async () => {
      await Promise.all([
        state.remove(sessionKey(ctx)),
        clearChatUploads(config.uploadsDir, storageScope(ctx)),
      ]);
      await ctx.reply('현재 채팅의 설정, 대화 기록, 업로드를 초기화했습니다. agy 인증 정보는 건드리지 않았습니다.');
    });
  });

  bot.command('update', async (ctx) => {
    await runUpdateCommand(ctx, { apply: commandArgument(ctx).trim() === 'apply' });
  });

  bot.command('auth', async (ctx) => {
    await startAuthFlow(ctx);
  });

  bot.command('cancel', async (ctx) => {
    await cancelActiveWork(ctx);
  });

  // The tmux OAuth transport uses agy's real interactive TTY flow. These
  // owner-only helpers supply the two keys Telegram cannot express as normal
  // text: Enter for an on-screen default and /exit once onboarding is done.
  bot.command('auth_enter', async (ctx) => {
    const chatId = sessionKey(ctx);
    if (authOwners.get(chatId) !== String(ctx.from?.id) || !auth.isActive(chatId)) {
      await ctx.reply('진행 중인 소유자 인증이 없습니다.');
      return;
    }
    auth.input(chatId, '');
    await ctx.reply('인증 터미널에 Enter 키를 전달했습니다.');
  });

  bot.command('auth_exit', async (ctx) => {
    const chatId = sessionKey(ctx);
    if (authOwners.get(chatId) !== String(ctx.from?.id) || !auth.isActive(chatId)) {
      await ctx.reply('진행 중인 소유자 인증이 없습니다.');
      return;
    }
    auth.input(chatId, '/exit');
    await ctx.reply('인증 터미널에 /exit을 전달했습니다.');
  });

  bot.on('document', async (ctx) => {
    if (auth.hasAnyActive()) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await ctx.reply('인증 중에는 파일을 처리할 수 없습니다. 먼저 인증을 끝내거나 /cancel 을 사용하세요.');
      return;
    }
    const document = ctx.message.document;
    await scheduleAgyRequest(ctx, {
      type: 'document',
      kind: 'prompt',
      fileId: document.file_id,
      fileName: document.file_name || 'document.bin',
      fileSize: document.file_size,
      caption: ctx.message.caption?.trim() || '',
    });
  });

  bot.on('photo', async (ctx) => {
    if (auth.hasAnyActive()) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await ctx.reply('인증 중에는 사진을 처리할 수 없습니다. 먼저 인증을 끝내거나 /cancel 을 사용하세요.');
      return;
    }
    const photo = ctx.message.photo.at(-1);
    await scheduleAgyRequest(ctx, {
      type: 'photo',
      kind: 'prompt',
      fileId: photo.file_id,
      fileName: 'photo.jpg',
      fileSize: photo.file_size,
      caption: ctx.message.caption?.trim() || '',
    });
  });

  bot.on('text', async (ctx) => {
    const chatId = sessionKey(ctx);
    if (auth.isActive(chatId)) {
      if (authOwners.get(chatId) !== String(ctx.from?.id)) {
        await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
        await ctx.reply('인증을 시작한 소유자의 입력만 받을 수 있습니다.');
        return;
      }
      const updateId = ctx.update?.update_id;
      if (jobs.getByUpdateId(updateId)) return;
      // Persist only the update ID before forwarding the OAuth code. If the
      // process crashes after stdin delivery, Telegram redelivery must never
      // reinterpret the same sensitive text as a normal coding prompt.
      await jobs.markUpdateSeen(updateId, { decision: 'rejected' });
      const text = ctx.message.text;
      await ctx.deleteMessage().catch(() => {});
      auth.input(chatId, text);
      return;
    }
    if (ctx.message.text.startsWith('/')) {
      await ctx.reply('알 수 없는 명령입니다. /help 로 명령 목록을 확인하세요.');
      return;
    }
    await scheduleAgyRequest(ctx, {
      type: 'request',
      kind: 'prompt',
      prompt: ctx.message.text,
    });
  });

  bot.catch(async (error, ctx) => {
    console.error('Telegram update failed', {
      updateId: ctx.update?.update_id,
      name: error.name,
      message: error.message,
    });
    if (error?.code === 'JOB_UPDATE_LEDGER_FULL') {
      stopPollingWithoutOffsetCommit(bot);
      // Rethrow so Telegraf's polling loop terminates. With offset sync
      // suppressed above, Telegram redelivers this batch after supervisor
      // restart instead of confirming an update whose rejection was not saved.
      throw error;
    }
    if (ctx.chat && config.allowedChatIds.has(String(ctx.chat.id))) {
      await ctx.reply('봇 내부 오류가 발생했습니다. 로그를 확인하세요.').catch(() => {});
    }
  });
}

