import { handoffAdmittedJob } from '../admission-handoff.js';
import { AdmissionError } from '../admission.js';
import { appendHistory } from '../state.js';
import { BusyError } from '../tasks.js';
import { runWithUsage } from '../usage-store.js';
import { buildPromptWithSkill } from '../skills.js';
import { buildPromptWithHistory } from '../agy.js';
import {
  replyLong,
  sendAgyResponse,
  sendAgyResponseFile,
  sessionKey,
  startTyping,
} from '../telegram.js';
import { detach, formatError, normalizeChoice, notifyOwnerWithCooldown } from './util.js';

/** Durable agy request scheduling, execution, retry, and recovery notices. */
export function attachJobs(s) {
  const {
    config,
    state,
    tasks,
    auth,
    jobs,
    results,
    agy,
    backgroundActivities,
    usage,
    workspaceLocks,
    admissions,
    workspaceFor,
    assertExecutionContext,
    prepareDurablePayload,
    snapshotExecutionContext,
    activeJournalJobs,
  } = s;

  const runAgyRequest = async (ctx, prepareRequest, journalJob = null) => {
    const chatId = sessionKey(ctx);
    const releaseJournalLease = journalJob ? jobs.acquireLease(journalJob.id) : null;
    let stopTyping = () => {};
    let taskSignal = null;
    let requestCleanup = null;
    let resultLease = null;
    try {
      if (auth.hasAnyActive()) throw new BusyError('Authentication is in progress');
      await tasks.run(chatId, async (signal, job) => {
        taskSignal = signal;
        stopTyping = startTyping(ctx, { signal });
        const persistedJobId = journalJob?.id || null;
        if (persistedJobId) {
          activeJournalJobs.set(chatId, persistedJobId);
          await jobs.transition(persistedJobId, 'running', {
            metadata: { phase: 'preparing', taskId: job.id },
          });
        }
        job.update('preparing');
        const prepared = await prepareRequest(signal);
        requestCleanup = prepared.cleanup || null;
        const prompt = prepared.prompt.trim();
        if (!prompt) throw new Error('빈 요청은 처리할 수 없습니다.');
        const session = state.get(chatId);
        const cwd = await workspaceFor(session);
        const pinnedContext = prepared.executionContext
          ? await assertExecutionContext(chatId, prepared.executionContext)
          : null;
        const requestedSession = pinnedContext
          ? {
              ...session,
              conversationId: pinnedContext.conversationId,
              projectId: pinnedContext.projectId,
              newProject: pinnedContext.newProject,
              model: pinnedContext.model,
              agent: pinnedContext.agent,
              skill: pinnedContext.skill,
              mode: pinnedContext.mode,
              sandbox: pinnedContext.sandbox,
            }
          : { ...session, ...(prepared.sessionOverrides || {}) };
        const executionSession = {
          ...requestedSession,
          sandbox: config.allowUnsandboxedRuns ? requestedSession.sandbox : true,
        };
        const skillPrompt = buildPromptWithSkill(prompt, executionSession.skill);
        const effectivePrompt = session.conversationId
          ? skillPrompt
          : buildPromptWithHistory(skillPrompt, session.history, config.historyMaxChars);
        job.update('waiting-workspace', { workspace: cwd, kind: prepared.kind || 'prompt' });
        const result = await workspaceLocks.run(
          cwd,
          signal,
          async () => {
            const usageRunId = journalJob?.id || job.id;
            const actorUserId = String(ctx.from?.id ?? '');
            return job.runExecution(() => {
              job.update('checking-usage');
              return runWithUsage(usage, {
                id: usageRunId,
                userId: actorUserId,
                operation: () => {
                  job.update('running-agy');
                  return agy.prompt({
                    prompt: effectivePrompt,
                    session: executionSession,
                    cwd,
                    addDirs: prepared.addDirs || [],
                    signal,
                  });
                },
              });
            });
          },
        );

        job.update('saving-state');
        if (pinnedContext) await assertExecutionContext(chatId, pinnedContext);
        const visibleJobId = journalJob?.id || job.id;
        if (journalJob) resultLease = await results.saveAndAcquire(journalJob.id, result.text);
        await state.update(chatId, (current) => ({
          ...current,
          conversationId: result.conversationId || current.conversationId,
          projectId: result.projectId || current.projectId,
          newProject: false,
          // Native conversation continuity avoids persisting user prompts locally.
          // Keep transcript history only when the undocumented agy log contract
          // could not provide a conversation ID and a fallback is necessary.
          history: result.conversationId || current.conversationId
            ? []
            : appendHistory(
                current.history,
                [
                  { role: 'user', content: prompt, at: new Date().toISOString() },
                  { role: 'assistant', content: result.text, at: new Date().toISOString() },
                ],
                { maxTurns: config.historyMaxTurns, maxChars: config.historyMaxChars },
              ),
          lastRun: {
            id: visibleJobId,
            kind: prepared.kind || 'prompt',
            status: 'succeeded',
            mode: executionSession.mode,
            sandbox: executionSession.sandbox,
            startedAt: new Date(Date.now() - result.durationMs).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: result.durationMs,
            responseText: null,
            deliveryStatus: 'pending',
            errorCode: null,
          },
        }));
        if (journalJob) {
          await jobs.transition(journalJob.id, 'succeeded', {
            metadata: {
              phase: 'sending-result',
              durationMs: result.durationMs,
              conversationId: result.conversationId,
              projectId: result.projectId,
            },
            responseText: result.text,
            delivered: false,
          });
        }
        job.update('sending-result');
        if (journalJob && result.text.length > config.maxInlineResponseChars) {
          await sendAgyResponseFile(ctx, resultLease.file, { signal });
        } else {
          await sendAgyResponse(ctx, result.text, config.maxInlineResponseChars, { signal });
        }
        await state.update(chatId, (current) => ({
          ...current,
          lastRun:
            current.lastRun?.id === visibleJobId
              ? { ...current.lastRun, deliveryStatus: 'delivered' }
              : current.lastRun,
        }));
        if (journalJob) {
          await jobs.transition(journalJob.id, 'succeeded', { delivered: true });
        }
      }, { kind: 'agy', durableJobId: journalJob?.id || null }, {
        // Preparation and the workspace mutex consume pending admission but
        // not a global execution slot. Once the workspace is exclusively held,
        // runExecution waits for a slot and clears the queue deadline exactly
        // when agy is allowed to begin.
        deferExecutionStart: true,
      });
    } catch (error) {
      console.error('Request failed', { name: error.name, code: error.code, message: error.message });
      const cancelled = error?.code === 'AGY_CANCELLED' || /cancelled|canceled/i.test(error?.message || '');
      if (!cancelled && error?.code && error.code !== 'AGY_AUTH_REQUIRED') {
        notifyOwnerWithCooldown(
          s.bot,
          config.ownerUserIds,
          `agy-failure-${error.code}`,
          `⚠️ agy 장애 알림: ${error.code}\n${error.message || ''}\n시각: ${new Date().toISOString()}`,
        ).catch(() => {});
      }
      if (journalJob) {
        const persisted = jobs.get(journalJob.id);
        if (persisted && ['queued', 'running'].includes(persisted.status)) {
          await jobs.transition(journalJob.id, cancelled ? 'cancelled' : 'failed', { error }).catch(
            (journalError) => console.error('Job journal failure transition failed', journalError),
          );
        }
      }
      await replyLong(ctx, formatError(error), undefined, {
        signal: taskSignal,
        retry: { maxAttempts: 1, attemptTimeoutMs: 5_000 },
      }).catch((deliveryError) => {
        console.error('Request error delivery failed', {
          name: deliveryError?.name,
          message: deliveryError?.message,
        });
      });
    } finally {
      if (resultLease) {
        await resultLease.release().catch((error) => {
          console.warn('Result delivery lease release failed', { code: error.code, name: error.name });
        });
      }
      if (journalJob && activeJournalJobs.get(chatId) === journalJob.id) {
        activeJournalJobs.delete(chatId);
      }
      await requestCleanup?.().catch((error) => {
        console.warn('Request resource cleanup failed', { code: error.code, name: error.name });
      });
      if (releaseJournalLease) {
        await releaseJournalLease().catch((error) => {
          console.warn('Job journal lease release failed', {
            code: error?.code,
            name: error?.name,
          });
        });
      }
      stopTyping();
    }
  };

  const scheduleAgyRequest = async (ctx, payload, { retryJob = null } = {}) => {
    const updateId = ctx.update?.update_id;
    const chatId = sessionKey(ctx);
    const existing = jobs.getByUpdateId(updateId);
    if (existing) return existing;
    const userId = String(ctx.from?.id ?? 'unknown');
    const auditMetadata = {
      audit: {
        actorUserId: userId,
        actorChatId: String(ctx.chat?.id ?? ''),
        telegramMessageId: String(ctx.message?.message_id ?? ''),
        telegramUpdateId: String(updateId ?? ''),
      },
    };
    const admissionKey = `${chatId}:${updateId}`;
    let reservation;
    try {
      reservation = admissions.reserve({
        token: admissionKey,
        sessionKey: chatId,
        userId,
        sessionAlreadyActive: tasks.isActive(chatId),
      });
    } catch (error) {
      if (!(error instanceof AdmissionError)) throw error;
      if (['SESSION_JOB_LIMIT', 'USER_JOB_LIMIT', 'GLOBAL_JOB_LIMIT'].includes(error.code)) {
        await jobs.markUpdateSeen(updateId, { decision: 'rejected' });
      }
      const message = error.code === 'SESSION_JOB_LIMIT'
        ? '이 세션의 작업이 이미 진행 중입니다. /status 또는 /cancel 을 사용하세요.'
        : error.code === 'USER_JOB_LIMIT'
          ? '사용자별 대기 작업 한도에 도달했습니다. 기존 작업이 끝난 뒤 다시 시도하세요.'
          : '서버 작업 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요.';
      await ctx.reply(message);
      return null;
    }
    const handoff = await handoffAdmittedJob({
      reservation,
      preparePayload: async () => retryJob
        ? payload
        : {
            ...payload,
            executionContext: await snapshotExecutionContext(chatId, payload, { touch: true }),
          },
      enqueueJob: (durablePayload) => retryJob
        ? jobs.enqueueRetry(retryJob.id, updateId, durablePayload, auditMetadata)
        : jobs.enqueue({
            updateId,
            sessionKey: chatId,
            kind: payload.kind || 'prompt',
            payload: durablePayload,
            metadata: auditMetadata,
          }),
      cancelQueuedJob: (journalJob, reason) => journalJob.tombstone
        ? Promise.resolve()
        : jobs.transition(journalJob.id, 'cancelled', {
            error: reason,
            metadata: { phase: 'cancelled-before-task-registration' },
          }),
      startJob: (journalJob) => journalJob.tombstone
        ? null
        : runAgyRequest(
            ctx,
            async (signal) => {
              await assertExecutionContext(chatId, journalJob.payload.executionContext);
              return prepareDurablePayload(ctx, journalJob.payload, signal);
            },
            journalJob,
          ),
    });
    if (handoff.job?.tombstone) {
      // enqueue() may lose a race to a previously persisted/tombstoned update.
      // Let the already-created execution wrapper release admission, but never
      // register the synthetic duplicate as executable work.
      await handoff.execution;
      return handoff.job;
    }
    if (handoff.execution) {
      detach(handoff.execution, `agy:${handoff.job.id}`, backgroundActivities);
    }
    return handoff.job;
  };

  const executeRetry = async (ctx, requested, confirmation) => {
    const candidates = jobs
      .listForSession(sessionKey(ctx), { limit: 100 })
      .filter((job) => ['failed', 'cancelled', 'interrupted'].includes(job.status))
      .filter((job) => job.id === requested || job.id.startsWith(requested));
    if (candidates.length !== 1) {
      await ctx.reply(candidates.length === 0 ? '재시도 가능한 작업을 찾지 못했습니다.' : '작업ID가 모호합니다. 더 길게 입력하세요.');
      return;
    }
    const mutating =
      candidates[0].kind === 'apply' ||
      candidates[0].payload?.executionContext?.mode === 'accept-edits';
    if (mutating && normalizeChoice(confirmation || '') !== 'confirm') {
      const idPrefix = candidates[0].id.slice(0, 8);
      const text = `이 작업은 중단 전에 파일을 일부 변경했을 수 있습니다. 작업공간의 git diff/status를 먼저 확인한 뒤 /retry ${idPrefix} confirm 으로 명시 승인하세요.`;
      await ctx.reply(text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✓ 명시 승인 및 재시도', callback_data: `tg:confirm-${idPrefix}` },
              { text: '닫기', callback_data: 'tg:close' }
            ]
          ]
        }
      });
      return;
    }
    await scheduleAgyRequest(ctx, candidates[0].payload, { retryJob: candidates[0] });
  };

  const sendRecoveryNotifications = async (tgBot, candidatesList, jobStore) => {
    if (!candidatesList || candidatesList.length === 0) return;
    for (const job of candidatesList) {
      const chatId = job.sessionKey;
      const idPrefix = job.id.slice(0, 8);
      const isMutating =
        job.kind === 'apply' ||
        job.payload?.executionContext?.mode === 'accept-edits';
      
      const parts = chatId.split(':');
      const rawChatId = parts[0];
      const threadId = parts[1] ? Number(parts[1]) : undefined;
      const extraOptions = threadId ? { message_thread_id: threadId } : {};

      // Check the final status in the store
      const persisted = jobStore.get(job.id);
      if (persisted && persisted.status === 'succeeded') {
        await tgBot.telegram.sendMessage(
          rawChatId,
          `🔔 시스템 재시작 전 실행 중이던 작업(${idPrefix})이 성공적으로 복구 및 완료되었습니다.\n/last 명령어로 결과를 확인하세요.`,
          extraOptions
        ).catch((err) => console.error(`Failed to send recovery success notification to ${chatId}`, err));
      } else {
        const text = `⚠️ 시스템 재시작으로 인해 실행 중이던 작업(${idPrefix})이 중단되었습니다.`;
        const callbackData = isMutating ? `tg:confirm-${idPrefix}` : `tg:retry-${idPrefix}`;
        const btnText = isMutating ? '✓ 명시 승인 및 재시도' : '🔄 작업 다시 실행';
        
        await tgBot.telegram.sendMessage(
          rawChatId,
          text,
          {
            ...extraOptions,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: btnText, callback_data: callbackData },
                  { text: '닫기', callback_data: 'tg:close' }
                ]
              ]
            }
          }
        ).catch((err) => console.error(`Failed to send recovery failure notification to ${chatId}`, err));
      }
    }
  };

  Object.assign(s, {
    runAgyRequest,
    scheduleAgyRequest,
    executeRetry,
    sendRecoveryNotifications,
  });
}

