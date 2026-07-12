const RECOVERY_INCOMPLETE = 'RECOVERY_INCOMPLETE';

function isCommittedCompletion(job, session) {
  const marker = session?.lastRun;
  return marker?.id === job.id
    && marker.status === 'succeeded'
    && marker.kind === job.kind
    && marker.deliveryStatus === 'pending';
}

function executionMode(job) {
  const mode = job.payload?.executionContext?.mode;
  return ['plan', 'accept-edits'].includes(mode) ? mode : null;
}

function acquireResult(results, jobId) {
  return results.acquire(jobId).then(
    (lease) => lease,
    (error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    },
  );
}

/**
 * Reconcile the narrow crash window between durable result, session, and job
 * commits. Only JobStore records carrying its private restart marker are
 * eligible; result contents are never read or parsed as recovery evidence.
 *
 * Commit order for an incomplete recovery is state -> job. If this process
 * crashes between those writes, the next startup observes the durable state
 * marker and can finish the same recovery idempotently.
 */
export async function reconcileCrossStoreRecovery({ jobs, state, results }) {
  const summary = {
    candidates: 0,
    recovered: 0,
    recoveredIncomplete: 0,
    unresolved: 0,
    removedOrphans: 0,
  };

  const candidates = jobs.restartRecoveryCandidates();
  summary.candidates = candidates.length;

  for (const job of candidates) {
    const resultLease = await acquireResult(results, job.id);
    if (!resultLease) {
      await jobs.acknowledgeRestartInterruption(job.id, { reason: 'result-missing' });
      summary.unresolved += 1;
      continue;
    }

    if (job.metadata?.restartRecovery?.previousStatus !== 'running') {
      // A queued job cannot have reached the post-run result commit. Treat any
      // same-name file as unrelated rather than inferring success from it.
      await resultLease.release();
      await results.remove(job.id);
      await jobs.acknowledgeRestartInterruption(job.id, { reason: 'unexpected-result' });
      summary.removedOrphans += 1;
      continue;
    }

    try {
      let session = state.get(job.sessionKey);
      let incomplete = session.lastRun?.errorCode === RECOVERY_INCOMPLETE;
      if (!isCommittedCompletion(job, session)) {
        incomplete = true;
        await state.update(job.sessionKey, (current) => ({
          ...current,
          // agy completed, but its native IDs were not committed. Reusing the
          // pre-run conversation could silently fork or repeat edits, so force a
          // fresh native project while retaining workspace/model preferences.
          conversationId: null,
          projectId: null,
          newProject: true,
          history: [],
          lastRun: {
            id: job.id,
            kind: job.kind,
            status: 'succeeded',
            mode: executionMode(job),
            sandbox: Boolean(job.payload?.executionContext?.sandbox),
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            durationMs: null,
            responseText: null,
            deliveryStatus: 'pending',
            errorCode: RECOVERY_INCOMPLETE,
          },
        }));
        session = state.get(job.sessionKey);
        if (!isCommittedCompletion(job, session)
          || session.lastRun?.errorCode !== RECOVERY_INCOMPLETE) {
          throw new Error(`Cross-store recovery state commit failed for job ${job.id}`);
        }
      }

      await jobs.recoverRestartInterruptedAsSucceeded(job.id, {
        recoveryIncomplete: incomplete,
      });
      summary.recovered += 1;
      if (incomplete) summary.recoveredIncomplete += 1;
    } finally {
      await resultLease.release();
    }
  }

  // Reconciliation is the first point at which restart-interrupted records may
  // safely become history-compaction candidates. Releasing all pins together
  // prevents recovery of one job from pruning a later unexamined candidate.
  await jobs.releaseRestartRecoveryPins();

  return summary;
}

export const _private = {
  RECOVERY_INCOMPLETE,
  isCommittedCompletion,
};
