import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';

import { AgyClient, AgyError, buildPromptWithHistory, cleanupAgyRunLogs } from './agy.js';
import { ActivityTracker } from './activity.js';
import { AdmissionController, AdmissionError } from './admission.js';
import { handoffAdmittedJob } from './admission-handoff.js';
import { cleanupAtomicArtifacts } from './artifacts.js';
import { AuthManager } from './auth.js';
import { loadConfig } from './config.js';
import {
  cleanupExpiredUploads,
  clearChatUploads,
  downloadTelegramFile,
  releaseUploadLease,
} from './files.js';
import { buildAgyEnvironment } from './environment.js';
import { acquireInstanceLock } from './instance-lock.js';
import { JobStore } from './job-store.js';
import { LifecycleController } from './lifecycle.js';
import { stopPollingWithoutOffsetCommit } from './polling-backpressure.js';
import { resolveProcessExecutable } from './process-platform.js';
import { reconcileCrossStoreRecovery } from './recovery.js';
import { ResultStore } from './results.js';
import {
  assertManagedStorageBoundary,
  assertRuntimeFilesystemTrust,
} from './runtime-trust.js';
import {
  releaseInstanceLockIfQuiescent,
  waitForLifecycleQuiescence,
} from './shutdown.js';
import {
  buildServiceStopRequestPath,
  ServiceStopRequestMonitor,
} from './service/stop-request.js';
import {
  parseFileRunnerArguments,
  resolveRuntimeEnvFile,
} from './service/runtime-paths.js';
import { appendHistory, StateStore } from './state.js';
import { BusyError, KeyedMutex, TaskManager } from './tasks.js';
import { runWithUsage, UsageLimitError, UsageStore } from './usage-store.js';
import {
  commandArgument,
  classifyUpdateAge,
  guardTelegramClient,
  hasActiveTelegramCalls,
  replyLong,
  retryTelegramCall,
  sendAgyResponse,
  sendAgyResponseFile,
  sendLong,
  sessionKey,
  shutdownTelegramCalls,
  startTyping,
  storageScope,
  waitForTelegramIdle,
  messageThreadOptions,
} from './telegram.js';
import { prepareWorkspaces, resolveWorkspace } from './workspace.js';
import { AGYGRAM_VERSION } from './version.js';

const runtimeArguments = parseFileRunnerArguments(process.argv.slice(2));
const pinnedServicePath = runtimeArguments.dataDir ? process.env.PATH : undefined;
const pinnedStopRequestPath = process.env.AGYGRAM_SERVICE_STOP_REQUEST_PATH;
const runtimeEnvFile = resolveRuntimeEnvFile({
  projectDir: process.cwd(),
  configuredEnvFile: runtimeArguments.envFile,
});

// On POSIX, verify the optional secret file and its full path before dotenv
// evaluates it. Runtime data directories are checked again after config load.
if (process.platform !== 'win32') {
  await assertRuntimeFilesystemTrust({ envFile: runtimeEnvFile, dataDirectories: [] });
}
const environmentResult = dotenv.config({
  path: runtimeEnvFile,
  override: runtimeArguments.envFile != null,
  quiet: true,
});
if (runtimeArguments.envFile && environmentResult.error) throw environmentResult.error;
if (runtimeArguments.dataDir) process.env.DATA_DIR = runtimeArguments.dataDir;
if (pinnedServicePath != null) process.env.PATH = pinnedServicePath;
if (pinnedStopRequestPath != null) {
  process.env.AGYGRAM_SERVICE_STOP_REQUEST_PATH = pinnedStopRequestPath;
}

const HELP_TEXT = `Antigravity Telegram CLI Bot

일반 메시지를 보내면 현재 작업공간에서 agy headless 모드로 처리합니다.

/new — 대화 기록을 비우고 다음 요청에서 새 agy 프로젝트 시작
/plan <요청> — 수정 없이 계획 생성
/apply [추가 지시] — 직전 계획을 sandbox code 모드로 실행
/model [이름|default] — 모델 목록 조회 또는 전환
/agent [이름|default] — 에이전트 목록 조회 또는 전환
/mode [plan|code|accept-edits] — 실행 모드 전환
/sandbox [on|off] — 샌드박스 조회 또는 명시적 설정
/workspace [경로] — 허용된 작업공간 조회 또는 전환
/project [ID|clear] — 명시적 agy 프로젝트 지정
/info — 현재 세션 상태
/status — 현재 작업의 ID·단계·경과 시간
/last — 마지막 agy 응답 다시 받기
/jobs — 최근 내구 작업 기록
/retry <작업ID> — 실패·취소·중단된 작업 재시도
/auth — agy headless OAuth 인증/재인증
/cancel — 현재 agy 또는 인증 작업 중단
/reset — 현재 채팅의 설정·기록 초기화
/help — 이 도움말

문서나 사진을 보내면 안전한 업로드 디렉터리에 저장한 뒤 agy가 읽도록 전달합니다.`;

function formatError(error) {
  if (error instanceof BusyError) {
    return '이미 이 채팅의 작업이 진행 중입니다. 중단하려면 /cancel 을 사용하세요.';
  }
  if (error?.code === 'TASK_QUEUE_TIMEOUT') {
    return '작업이 대기열 제한 시간을 초과해 실행 전에 중단되었습니다. /retry <작업ID>로 다시 시도할 수 있습니다.';
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

function normalizeChoice(value) {
  return value.trim().toLocaleLowerCase('en-US');
}

function detach(promise, context, tracker) {
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

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}분 ${seconds % 60}초`;
}

async function main() {
  const config = loadConfig();
  const serviceRuntimeDir = path.join(config.dataDir, 'runtime', 'service');
  const uploadActiveLeaseMaxAgeMs =
    config.agyQueueTimeoutMs + config.agyTimeoutMs + 5 * 60 * 1_000;
  const managedDataFiles = [config.stateFile, config.jobFile, config.usageFile];
  const managedDataDirectories = [...new Set([
    config.dataDir,
    ...managedDataFiles.map((file) => path.dirname(file)),
    config.uploadsDir,
    config.resultsDir,
    config.agyRunLogDir,
    path.join(config.dataDir, 'logs'),
    serviceRuntimeDir,
  ])];
  if (process.platform === 'win32' && !config.windowsAclVerified) {
    throw new Error(
      `Windows ACL verification is required. Restrict ${runtimeEnvFile} and DATA_DIR to the service user, then set WINDOWS_ACL_VERIFIED=true.`,
    );
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  // Validate existing ancestors before recursive mkdir can follow an internal
  // symlink/junction and create managed storage outside DATA_DIR.
  await assertManagedStorageBoundary({
    dataDir: config.dataDir,
    files: managedDataFiles,
    directories: managedDataDirectories,
  });
  await Promise.all(managedDataDirectories
    .filter((directory) => directory !== config.dataDir)
    .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  await assertManagedStorageBoundary({
    dataDir: config.dataDir,
    files: managedDataFiles,
    directories: managedDataDirectories,
  });
  await assertRuntimeFilesystemTrust({
    envFile: runtimeEnvFile,
    dataDirectories: managedDataDirectories,
    dataFiles: managedDataFiles,
    windowsAclVerified: config.windowsAclVerified,
  });
  const instanceLock = await acquireInstanceLock(path.join(config.dataDir, 'bot.lock'));
  let maintenanceTimer = null;
  let serviceStopMonitor = null;
  let runtimeTasks = null;
  let runtimeAuth = null;
  let runtimeLifecycle = null;
  let runtimeAdmissions = null;
  const backgroundActivities = new ActivityTracker();
  try {
  const configuredStopRequestPath = process.env.AGYGRAM_SERVICE_STOP_REQUEST_PATH;
  if (configuredStopRequestPath) {
    const expectedStopRequestPath = buildServiceStopRequestPath(config.dataDir);
    const normalizeStopPath = (value) => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
    };
    if (normalizeStopPath(configuredStopRequestPath) !== normalizeStopPath(expectedStopRequestPath)) {
      throw new Error('service stop-request path does not match DATA_DIR');
    }
    serviceStopMonitor = new ServiceStopRequestMonitor({
      requestPath: expectedStopRequestPath,
    });
    await serviceStopMonitor.start();
  }
  const results = await new ResultStore(config.resultsDir, {
    maxResultBytes: config.agyMaxOutputBytes,
    maxTotalBytes: config.maxResultStorageBytes,
    retentionMs: config.resultRetentionHours * 60 * 60 * 1_000,
  }).init({ cleanup: false });
  const cleanupRuntime = () => Promise.all([
    cleanupExpiredUploads(config.uploadsDir, {
      retentionMs: config.uploadRetentionHours * 60 * 60 * 1_000,
      maxTotalBytes: config.maxUploadStorageBytes,
      activeLeaseMaxAgeMs: uploadActiveLeaseMaxAgeMs,
    }).catch((error) => console.warn('Upload cleanup failed', error.message)),
    cleanupAgyRunLogs(config.agyRunLogDir, {
      retentionMs: config.agyRunLogRetentionHours * 60 * 60 * 1_000,
      maxTotalBytes: config.maxAgyRunLogStorageBytes,
    }).catch((error) => console.warn('agy run-log cleanup failed', error.message)),
    results.cleanup().catch((error) => console.warn('Result cleanup failed', error.message)),
    cleanupAtomicArtifacts({
      stateFile: config.stateFile,
      jobFile: config.jobFile,
      usageFile: config.usageFile,
      resultsDir: config.resultsDir,
      retentionMs: 24 * 60 * 60 * 1_000,
      maxCorruptBackups: 3,
    }).catch((error) => console.warn('Atomic artifact cleanup failed', error.message)),
  ]);
  const allowedRoots = await prepareWorkspaces(config.workspaceDir, config.allowedWorkspaceRoots);
  const defaultWorkspace = await resolveWorkspace(config.workspaceDir, {
    defaultWorkspace: config.workspaceDir,
    allowedRoots,
  });

  const state = new StateStore(config.stateFile, {
    mode: config.defaultMode,
    sandbox: config.defaultSandbox,
    workspaceDir: defaultWorkspace,
  }, {
    maxSessions: config.maxStateSessions,
    maxBytes: config.maxStateBytes,
    retentionMs: config.stateRetentionHours * 60 * 60 * 1_000,
  });
  await state.init();
  const jobs = new JobStore(config.jobFile, {
    maxJobs: config.jobHistoryLimit,
    maxBytes: config.jobJournalMaxBytes,
    maxResponseChars: config.jobResponseMaxChars,
    updateTombstoneRetentionMs: config.updateTombstoneRetentionMs,
    maxUpdateTombstones: config.maxUpdateTombstones,
    maxUpdateTombstoneBytes: config.maxUpdateTombstoneBytes,
    secrets: [config.botToken],
  });
  await jobs.init();
  const recovery = await reconcileCrossStoreRecovery({ jobs, state, results });
  if (recovery.candidates > 0) {
    console.warn('Reconciled interrupted jobs after restart', recovery);
  }
  // Result cleanup is deliberately deferred until cross-store recovery has
  // acquired and reconciled every crash-window result. Session TTL pruning is
  // also delayed so it cannot erase the only durable completion marker first.
  await cleanupRuntime();
  await state.pruneExpired();
  const usage = await new UsageStore(config.usageFile, {
    windowMs: config.usageWindowMs,
    maxJobsPerUser: config.maxAgyJobsPerUserPerWindow,
    maxJobsGlobal: config.maxAgyJobsGlobalPerWindow,
    dailyRuntimeMsPerUser: config.maxAgyRuntimeMsPerUserPerDay,
    dailyRuntimeMsGlobal: config.maxAgyRuntimeMsGlobalPerDay,
    reservationMs: config.agyTimeoutMs,
    retentionDays: config.usageRetentionDays,
    maxBytes: config.usageStoreMaxBytes,
  }).init();
  const runMaintenance = () => Promise.all([
    cleanupRuntime(),
    state.pruneExpired().catch((error) => console.warn('State cleanup failed', error.message)),
    usage.prune().catch((error) => console.warn('Usage cleanup failed', error.message)),
  ]);
  maintenanceTimer = setInterval(() => {
    detach(runMaintenance(), 'runtime-maintenance', backgroundActivities);
  }, 60 * 60 * 1_000);
  maintenanceTimer.unref?.();

  const agyEnvironment = buildAgyEnvironment(process.env, config.agyEnvironmentAllowlist);
  const agyExecutable = (
    await resolveProcessExecutable(config.agyBin, {
      env: agyEnvironment,
      cwd: defaultWorkspace,
    })
  ).path;

  const agy = new AgyClient({
    bin: agyExecutable,
    timeoutMs: config.agyTimeoutMs,
    authCheckTimeoutMs: config.authCheckTimeoutMs,
    maxOutputBytes: config.agyMaxOutputBytes,
    allowUnsandboxedAutoApprove: config.allowUnsandboxedAutoApprove,
    runLogDir: config.captureAgyRunMetadata ? config.agyRunLogDir : null,
    keepRunLogs: config.keepAgyRunLogs,
    runLogRetentionMs: config.agyRunLogRetentionHours * 60 * 60 * 1_000,
    runLogMaxTotalBytes: config.maxAgyRunLogStorageBytes,
    runLogMaxFileBytes: config.maxAgyRunLogFileBytes,
    environment: agyEnvironment,
  });
  const auth = new AuthManager({
    bin: agyExecutable,
    timeoutMs: config.authTimeoutMs,
    forceRemote: config.authForceRemote,
    transport: process.env.AGY_AUTH_TRANSPORT || 'pipe',
    environment: agyEnvironment,
  });
  runtimeAuth = auth;
  const authOwners = new Map();
  const tasks = new TaskManager(config.maxConcurrentAgy, {
    maxQueueWaitMs: config.agyQueueTimeoutMs,
    maxActive: Math.max(config.maxConcurrentAgy, config.maxPendingAgyJobs),
  });
  runtimeTasks = tasks;
  const workspaceLocks = new KeyedMutex();
  const bot = new Telegraf(config.botToken, {
    // A chat can wait behind another allowed chat's agy process.
    handlerTimeout: Math.max(config.agyTimeoutMs + 90_000, 24 * 60 * 60 * 1_000),
  });
  guardTelegramClient(bot.telegram);

  const workspaceFor = async (session) =>
    resolveWorkspace(session.workspaceDir || defaultWorkspace, {
      defaultWorkspace,
      allowedRoots,
    });

  const activeJournalJobs = new Map();
  const admissions = new AdmissionController({
    maxTotal: config.maxPendingAgyJobs,
    maxPerUser: Math.min(config.maxPendingAgyJobsPerUser, config.maxPendingAgyJobs),
  });
  runtimeAdmissions = admissions;
  const historyDigest = (history) =>
    createHash('sha256').update(JSON.stringify(history || [])).digest('hex');
  const snapshotExecutionContext = async (chatId, payload, { touch = false } = {}) => {
    const session = touch ? await state.ensure(chatId) : state.get(chatId);
    const workspaceDir = await workspaceFor(session);
    const requested = { ...session, ...(payload.sessionOverrides || {}) };
    return {
      workspaceDir,
      conversationId: session.conversationId,
      projectId: session.projectId,
      newProject: session.newProject,
      model: requested.model,
      agent: requested.agent,
      mode: requested.mode,
      sandbox: config.allowUnsandboxedRuns ? requested.sandbox : true,
      historyDigest: historyDigest(session.history),
      executionGeneration: session.executionGeneration,
      sessionRevision: session.revision,
    };
  };

  const assertExecutionContext = async (chatId, expected) => {
    if (!expected || typeof expected !== 'object') {
      throw new Error('작업 실행 컨텍스트가 없어 안전하게 실행할 수 없습니다. 새 요청을 보내세요.');
    }
    const current = await snapshotExecutionContext(chatId, {
      sessionOverrides: { mode: expected.mode, sandbox: expected.sandbox },
    });
    for (const field of [
      'workspaceDir',
      'conversationId',
      'projectId',
      'newProject',
      'model',
      'agent',
      'historyDigest',
      'executionGeneration',
      'sessionRevision',
    ]) {
      if (current[field] !== expected[field]) {
        const error = new Error(
          `작업 생성 후 ${field} 컨텍스트가 바뀌어 실행을 차단했습니다. 현재 상태에 맞는 새 요청을 보내세요.`,
        );
        error.code = 'JOB_CONTEXT_CHANGED';
        throw error;
      }
    }
    return expected;
  };
  const prepareDurablePayload = async (ctx, payload, signal) => {
    const sessionOverrides = {};
    if (['plan', 'accept-edits'].includes(payload?.sessionOverrides?.mode)) {
      sessionOverrides.mode = payload.sessionOverrides.mode;
    }
    if (typeof payload?.sessionOverrides?.sandbox === 'boolean') {
      sessionOverrides.sandbox = payload.sessionOverrides.sandbox;
    }
    if (payload?.type === 'request') {
      return {
        prompt: String(payload.prompt || ''),
        addDirs: [],
        kind: payload.kind || 'prompt',
        sessionOverrides,
        executionContext: payload.executionContext,
      };
    }
    if (payload?.type === 'document' || payload?.type === 'photo') {
      const fallbackName = payload.type === 'photo' ? 'photo.jpg' : 'document.bin';
      const savedPath = await downloadTelegramFile(
        ctx,
        {
          fileId: payload.fileId,
          fileName: payload.fileName || fallbackName,
          fileSize: payload.fileSize,
        },
        {
          uploadsDir: config.uploadsDir,
          maxBytes: config.maxUploadBytes,
          signal,
          scopeId: storageScope(ctx),
          retentionMs: config.uploadRetentionHours * 60 * 60 * 1_000,
          maxTotalBytes: config.maxUploadStorageBytes,
          activeLeaseMaxAgeMs: uploadActiveLeaseMaxAgeMs,
        },
      );
      const requested = String(payload.caption || '').trim();
      const label = payload.type === 'photo' ? '이미지' : '파일';
      return {
        prompt:
          `텔레그램에서 업로드된 ${label}을 확인해 주세요.\n${label} 경로: ${savedPath}\n` +
          `${payload.type === 'document' ? `원래 파일명: ${payload.fileName || fallbackName}\n` : ''}` +
          `요청: ${requested || (payload.type === 'photo' ? '이미지를 분석해 주세요.' : '파일을 분석하고 핵심 내용을 설명해 주세요.')}`,
        addDirs: [path.dirname(savedPath)],
        kind: payload.kind || 'prompt',
        sessionOverrides,
        executionContext: payload.executionContext,
        cleanup: () => releaseUploadLease(savedPath),
      };
    }
    throw new Error('지원하지 않는 내구 작업 payload입니다.');
  };

  const runAdmittedTask = async (ctx, kind, operation) => {
    const chatId = sessionKey(ctx);
    const token = `control:${ctx.update?.update_id}:${kind}`;
    let release;
    try {
      release = admissions.reserve({
        token,
        sessionKey: chatId,
        userId: String(ctx.from?.id ?? 'unknown'),
        sessionAlreadyActive: tasks.isActive(chatId),
      });
    } catch (error) {
      if (error instanceof AdmissionError) throw new BusyError(error.message);
      throw error;
    }
    try {
      return await tasks.run(chatId, operation, { kind });
    } finally {
      release();
    }
  };

  const isIdle = async (ctx) => {
    const chatId = sessionKey(ctx);
    if (tasks.isActive(chatId) || auth.hasAnyActive()) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await ctx.reply('진행 중인 작업이 있습니다. 먼저 /cancel 로 중단하세요.');
      return false;
    }
    return true;
  };

  const runControl = async (ctx, operation) => {
    if (auth.hasAnyActive()) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await ctx.reply('인증 작업 중에는 세션 설정을 바꿀 수 없습니다.');
      return;
    }
    try {
      await runAdmittedTask(ctx, 'control', async () => operation());
    } catch (error) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await replyLong(ctx, formatError(error));
    }
  };

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
              mode: pinnedContext.mode,
              sandbox: pinnedContext.sandbox,
            }
          : { ...session, ...(prepared.sessionOverrides || {}) };
        const executionSession = {
          ...requestedSession,
          sandbox: config.allowUnsandboxedRuns ? requestedSession.sandbox : true,
        };
        const effectivePrompt = session.conversationId
          ? prompt
          : buildPromptWithHistory(prompt, session.history, config.historyMaxChars);
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
      if (journalJob) {
        const persisted = jobs.get(journalJob.id);
        if (persisted && ['queued', 'running'].includes(persisted.status)) {
          const cancelled = error?.code === 'AGY_CANCELLED' || /cancelled|canceled/i.test(error?.message || '');
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

  // Authorization is deliberately the first middleware. Unknown chats receive no response.
  bot.use(async (ctx, next) => {
    guardTelegramClient(ctx.telegram);
    if (!ctx.chat || !config.allowedChatIds.has(String(ctx.chat.id))) return;
    if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(String(ctx.from?.id))) return;
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
  const staleSafeCommands = new Set(['help', 'info', 'status']);
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
        const readinessLine = catalogStatus.available
          ? `모델 ${catalogStatus.models.length}개 조회됨`
          : '모델 조회 실패';
        await ctx.reply(
          `Antigravity Telegram CLI Bot이 준비되었습니다.\nagy ${version} · ${readinessLine}\n` +
            `인증은 실제 요청 시 확인되며, 필요하면 /auth 를 실행하세요.\n작업공간: ${cwd}\n\n${HELP_TEXT}`,
        );
      });
    } catch (error) {
      await replyLong(ctx, `봇 세션은 생성했지만 agy 점검에 실패했습니다.\n\n${formatError(error)}\n\n${HELP_TEXT}`);
    } finally {
      stopTyping();
    }
  });

  bot.help((ctx) => ctx.reply(HELP_TEXT));

  bot.command('status', async (ctx) => {
    const key = sessionKey(ctx);
    const active = tasks.getStatus(key);
    const last = state.get(key).lastRun;
    const journal = jobs.latestForSession(key);
    if (!active) {
      if (!last && !journal) {
        await ctx.reply('현재 작업도, 기록된 이전 작업도 없습니다.');
        return;
      }
      if (journal && journal.status !== 'succeeded') {
        await ctx.reply(
          `현재 실행 중인 작업은 없습니다.\n최근 내구 작업: ${journal.id.slice(0, 8)} · ${journal.kind} · ${journal.status}\n` +
            `${journal.status === 'interrupted' ? `/retry ${journal.id.slice(0, 8)} 로 명시 재시도할 수 있습니다.` : ''}`,
        );
        return;
      }
      if (!last) {
        await ctx.reply(
          `현재 실행 중인 작업은 없습니다.\n최근 내구 작업: ${journal.id.slice(0, 8)} · ${journal.kind} · ${journal.status}`,
        );
        return;
      }
      const duration = last.durationMs == null ? '알 수 없음' : formatDuration(last.durationMs);
      await ctx.reply(
        `현재 실행 중인 작업은 없습니다.\n` +
          `마지막 작업: ${last.id || '-'} · ${last.kind} · ${last.status} · ${duration}\n` +
          `응답 전달: ${last.deliveryStatus || '기록 없음'}`,
      );
      return;
    }
    const origin = active.startedAt || active.queuedAt;
    const elapsed = origin ? formatDuration(Date.now() - Date.parse(origin)) : '알 수 없음';
    const queue = active.state === 'queued' ? ` · 대기 ${active.queuePosition}번` : '';
    await ctx.reply(
      `작업 ${(active.metadata.durableJobId || active.id).slice(0, 8)}\n상태: ${active.state}${queue}\n단계: ${active.phase}\n경과: ${elapsed}`,
    );
  });

  bot.command('last', async (ctx) => {
    const key = sessionKey(ctx);
    let release;
    let storedLease = null;
    let deliverySignal = null;
    try {
      release = admissions.reserve({
        token: `delivery:${ctx.update?.update_id}`,
        sessionKey: key,
        userId: String(ctx.from?.id ?? 'unknown'),
        sessionAlreadyActive: tasks.isActive(key),
      });
    } catch (error) {
      if (!(error instanceof AdmissionError)) throw error;
      await replyLong(ctx, '현재 작업 또는 응답 전송이 진행 중입니다. 잠시 후 /last 를 다시 실행하세요.');
      return;
    }
    try {
      await tasks.run(key, async (signal, job) => {
        deliverySignal = signal;
        job.update('sending-result');
        const sessionLast = state.get(key).lastRun;
        const latestJournal = sessionLast ? jobs.get(sessionLast.id) : jobs.latestSucceededForSession(key);
        const last = sessionLast || (latestJournal
          ? {
              id: latestJournal.id,
              responseText: latestJournal.result?.responseText || null,
            }
          : null);
        if (!last) {
          await replyLong(ctx, '다시 보낼 수 있는 이전 agy 응답이 없습니다.', undefined, { signal });
          return;
        }
        const persistedPreview = (latestJournal || jobs.get(last.id))?.result;
        try {
          storedLease = await results.acquire(last.id);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.warn('Stored result metadata failed', { code: error.code, name: error.name });
          }
        }
        if (storedLease?.size > config.maxRedeliveryBytes) {
          await replyLong(
            ctx,
            `마지막 응답이 재전송 한도(${Math.floor(config.maxRedeliveryBytes / 1024 / 1024)} MiB)를 초과합니다. 서버의 보존 결과를 직접 확인하세요.`,
            undefined,
            { signal },
          );
          return;
        }
        let fullResult = false;
        if (storedLease && storedLease.size > config.maxInlineResponseChars) {
          await sendAgyResponseFile(ctx, storedLease.file, { signal });
          fullResult = true;
        } else {
          const responseText = storedLease
            ? await results.read(last.id)
            : last.responseText || persistedPreview?.responseText || null;
          if (!responseText) {
            await replyLong(
              ctx,
              '마지막 응답의 보존 기간이 끝났거나 저장된 결과가 없습니다.',
              undefined,
              { signal },
            );
            return;
          }
          await sendAgyResponse(ctx, responseText, config.maxInlineResponseChars, { signal });
          fullResult = Boolean(storedLease);
        }
        if (!fullResult && !last.responseText && persistedPreview?.responseTruncated) {
          await replyLong(
            ctx,
            '주의: 전체 결과 파일이 만료되어 journal에 남은 축약본만 전송했습니다.',
            undefined,
            { signal },
          );
        }
        if (sessionLast) {
          await state.update(key, (current) => ({
            ...current,
            lastRun:
              current.lastRun?.id === last.id
                ? { ...current.lastRun, deliveryStatus: 'delivered' }
                : current.lastRun,
          }));
        }
        const persisted = jobs.get(last.id);
        if (persisted?.status === 'succeeded') {
          await jobs.transition(last.id, 'succeeded', { delivered: true });
        }
      }, { kind: 'delivery' });
    } catch (error) {
      console.error('Last response delivery failed', { name: error.name, code: error.code });
      await replyLong(
        ctx,
        '응답 재전송에 실패했습니다. 잠시 후 /last 를 다시 실행하세요.',
        undefined,
        { signal: deliverySignal, retry: { maxAttempts: 1, attemptTimeoutMs: 5_000 } },
      ).catch(() => {});
    } finally {
      if (storedLease) {
        await storedLease.release().catch((error) => {
          console.warn('Result redelivery lease release failed', { code: error.code, name: error.name });
        });
      }
      release?.();
    }
  });

  bot.command('jobs', async (ctx) => {
    const recent = jobs.listForSession(sessionKey(ctx), { limit: 10 });
    if (recent.length === 0) {
      await ctx.reply('기록된 작업이 없습니다.');
      return;
    }
    await replyLong(
      ctx,
      recent
        .map((job) => {
          const time = job.startedAt || job.queuedAt;
          return `${job.id.slice(0, 8)} · ${job.kind} · ${job.status} · 시도 ${job.attempt} · ${time}`;
        })
        .join('\n'),
    );
  });

  bot.command('retry', async (ctx) => {
    const [requested, confirmation] = commandArgument(ctx).split(/\s+/).filter(Boolean);
    if (!requested) {
      await ctx.reply('사용법: /retry <작업ID> — /jobs 에 표시된 실패·취소·중단 작업만 재시도합니다.');
      return;
    }
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
      await ctx.reply(
        `이 작업은 중단 전에 파일을 일부 변경했을 수 있습니다. 작업공간의 git diff/status를 먼저 확인한 뒤 /retry ${candidates[0].id.slice(0, 8)} confirm 으로 명시 승인하세요.`,
      );
      return;
    }
    await scheduleAgyRequest(ctx, candidates[0].payload, { retryJob: candidates[0] });
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
          await replyLong(ctx, `현재: ${session.model || 'agy 기본값'}\n\n사용 가능한 모델:\n${models.join('\n')}`);
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
          await replyLong(ctx, `현재: ${session.agent || 'agy 기본값'}\n\n사용 가능한 에이전트:\n${agents.join('\n') || '(없음)'}`);
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

  bot.command('mode', async (ctx) => {
    await runControl(ctx, async () => {
      const requested = normalizeChoice(commandArgument(ctx));
      const aliases = { code: 'accept-edits', plan: 'plan', 'accept-edits': 'accept-edits' };
      if (!requested) {
        await ctx.reply(`현재 모드: ${state.get(sessionKey(ctx)).mode}\n사용법: /mode plan 또는 /mode code`);
        return;
      }
      if (!aliases[requested]) {
        await ctx.reply('지원 모드는 plan, code(accept-edits)입니다.');
        return;
      }
      await state.update(sessionKey(ctx), (session) => ({ ...session, mode: aliases[requested] }));
      await ctx.reply(`실행 모드: ${aliases[requested]}`);
    });
  });

  bot.command('sandbox', async (ctx) => {
    await runControl(ctx, async () => {
      const requested = normalizeChoice(commandArgument(ctx));
      const current = state.get(sessionKey(ctx)).sandbox;
      let enabled;
      if (!requested) {
        await ctx.reply(`현재 샌드박스: ${current ? '켜짐' : '꺼짐'}\n변경: /sandbox on 또는 /sandbox off`);
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
    const session = state.get(sessionKey(ctx));
    let cwd;
    try {
      cwd = await workspaceFor(session);
    } catch {
      cwd = `${session.workspaceDir} (사용 불가)`;
    }
    const sessionMode = session.conversationId
      ? `agy conversation ${session.conversationId}`
      : `로컬 기록 폴백 ${session.history.length}턴`;
    await ctx.reply(
      [
        `agygram: v${AGYGRAM_VERSION}`,
        `작업공간: ${cwd}`,
        `대화: ${sessionMode}`,
        `프로젝트: ${session.projectId || (session.newProject ? '다음 요청에서 새로 생성' : '자동')}`,
        `모델: ${session.model || 'agy 기본값'}`,
        `에이전트: ${session.agent || 'agy 기본값'}`,
        `모드: ${session.mode}`,
        `샌드박스: ${config.allowUnsandboxedRuns ? (session.sandbox ? '켜짐' : '꺼짐') : '강제 켜짐 (정책)'}`,
        `작업 중: ${tasks.isActive(sessionKey(ctx)) ? '예' : '아니요'}`,
      ].join('\n'),
    );
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

  bot.command('auth', async (ctx) => {
    if (!config.ownerUserIds.has(String(ctx.from?.id))) {
      await ctx.reply('agy 계정 인증은 OWNER_USER_IDS에 등록된 소유자만 실행할 수 있습니다.');
      return;
    }
    if (config.authPrivateOnly && ctx.chat.type !== 'private') {
      await ctx.reply('보안을 위해 /auth 는 허용된 개인 채팅에서만 실행할 수 있습니다.');
      return;
    }
    const chatId = sessionKey(ctx);
    const threadOptions = messageThreadOptions(ctx);
    if (tasks.hasAnyActive() || auth.hasAnyActive()) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await ctx.reply('다른 작업이 진행 중입니다. 완료를 기다리거나 해당 채팅에서 /cancel 을 사용하세요.');
      return;
    }
    const cwd = defaultWorkspace;
    try {
      authOwners.set(chatId, String(ctx.from.id));
      auth.start(chatId, {
        cwd,
        onOutput: (output, { signal }) =>
          sendLong(bot.telegram, ctx.chat.id, output, threadOptions, undefined, { signal }),
        onExit: async ({ exitCode, cancelled, timedOut, error, deliverySignal }) => {
          try {
            if (cancelled || timedOut) {
              await sendLong(
                bot.telegram,
                ctx.chat.id,
                timedOut ? '인증 세션 시간이 만료되었습니다.' : '인증을 취소했습니다.',
                threadOptions,
                undefined,
                { signal: deliverySignal },
              );
              return;
            }
            await sendLong(
              bot.telegram,
              ctx.chat.id,
              exitCode === 0 && !error
                ? 'OAuth 입력과 실제 headless 요청이 완료되어 agy 인증을 확인했습니다.'
                : `인증 프로세스가 종료되었습니다(exit ${exitCode}). 인증을 확인하지 못했습니다.`,
              threadOptions,
              undefined,
              { signal: deliverySignal },
            );
          } finally {
            authOwners.delete(chatId);
          }
        },
      });
    } catch (error) {
      authOwners.delete(chatId);
      await ctx.reply('인증 프로세스를 시작하지 못했습니다. AGY_BIN과 서버 로그를 확인하세요.');
      return;
    }
    try {
      await replyLong(
        ctx,
        'agy headless OAuth 프로세스를 시작했습니다. 잠시 후 표시되는 URL을 브라우저에서 열고, ' +
          '발급된 인증 코드를 일반 텍스트로 보내세요. 봇은 코드를 stdin으로 전달한 뒤 Telegram 메시지 삭제를 시도합니다. ' +
          '중단하려면 /cancel 을 사용하세요.',
      );
    } catch (error) {
      console.error('Auth start notification failed', { name: error.name, code: error.code });
      auth.cancel(chatId);
    }
  });

  bot.command('cancel', async (ctx) => {
    const chatId = sessionKey(ctx);
    const authActive = auth.isActive(chatId);
    const ownsAuth = authOwners.get(chatId) === String(ctx.from?.id);
    const authCancelled = ownsAuth ? auth.cancel(chatId) : false;
    const admissionCancelled = admissions.cancel(chatId);
    const taskCancelled = tasks.cancel(chatId);
    if (authActive && !ownsAuth && !admissionCancelled && !taskCancelled) {
      await ctx.reply('인증을 시작한 소유자만 해당 인증 세션을 취소할 수 있습니다.');
      return;
    }
    await ctx.reply(
      authCancelled || admissionCancelled || taskCancelled
        ? '중단 신호를 보냈습니다.'
        : '진행 중인 작업이 없습니다.',
    );
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

  const lifecycle = new LifecycleController({ bot, tasks, auth, admissions });
  runtimeLifecycle = lifecycle;
  serviceStopMonitor?.setHandler((reason) => lifecycle.requestStop(reason));
  const removeSignalHandlers = lifecycle.installSignalHandlers(process);
  try {
    await lifecycle.start({
      setCommands: (startupSignal) =>
        retryTelegramCall(
          (attemptSignal) =>
            bot.telegram.callApi(
              'setMyCommands',
              {
                commands: [
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
                  { command: 'cancel', description: '현재 작업 중단' },
                  { command: 'reset', description: '현재 채팅 상태 초기화' },
                  { command: 'help', description: '명령어 도움말' },
                ],
              },
              { signal: attemptSignal },
            ),
          { operation: 'set bot commands', signal: startupSignal },
        ),
      launchOptions: { dropPendingUpdates: false },
      onLaunch: () => {
        console.log(`Antigravity Telegram bot started with agy at ${agyExecutable}`);
      },
    });
  } finally {
    removeSignalHandlers();
  }
  } finally {
    clearInterval(maintenanceTimer);
    serviceStopMonitor?.close();
    const shutdownReason = new Error('Application shutting down');
    backgroundActivities.close();
    runtimeAdmissions?.close(shutdownReason);
    runtimeTasks?.cancelAll(shutdownReason);
    runtimeAuth?.cancelAll();
    shutdownTelegramCalls(shutdownReason);

    const shutdownTimeoutMs = 8_000;
    const [
      tasksIdle,
      authIdle,
      admissionsIdle,
      backgroundIdle,
      transportIdle,
      lifecycleIdle,
    ] = await Promise.all([
      runtimeTasks?.waitForIdle(shutdownTimeoutMs) ?? true,
      runtimeAuth?.waitForIdle(shutdownTimeoutMs) ?? true,
      runtimeAdmissions?.waitForIdle(shutdownTimeoutMs) ?? true,
      backgroundActivities.waitForIdle(shutdownTimeoutMs),
      waitForTelegramIdle(shutdownTimeoutMs),
      waitForLifecycleQuiescence(runtimeLifecycle, shutdownTimeoutMs),
    ]);
    await releaseInstanceLockIfQuiescent({
      instanceLock,
      lifecycle: runtimeLifecycle,
      componentResults: [
        { name: 'tasks', component: runtimeTasks, idle: tasksIdle },
        { name: 'auth', component: runtimeAuth, idle: authIdle },
        { name: 'admissions', component: runtimeAdmissions, idle: admissionsIdle },
        { name: 'background', component: backgroundActivities, idle: backgroundIdle },
        { name: 'lifecycle', component: null, idle: lifecycleIdle },
      ],
      transportIdle,
      transportActive: hasActiveTelegramCalls(),
    });
  }
}

main().catch((error) => {
  console.error('Fatal startup error', error);
  process.exitCode = 1;
});
