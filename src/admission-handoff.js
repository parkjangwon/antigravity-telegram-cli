/**
 * Move durable work from an admission reservation into the task manager.
 * There is intentionally no await between the final abort check and startJob:
 * once this function hands off, session cancellation can see the TaskManager job.
 */
export async function handoffAdmittedJob({
  reservation,
  preparePayload,
  enqueueJob,
  cancelQueuedJob,
  startJob,
}) {
  if (typeof reservation?.release !== 'function' || !reservation.signal) {
    throw new TypeError('reservation must provide release() and signal');
  }
  for (const [name, operation] of Object.entries({
    preparePayload,
    enqueueJob,
    cancelQueuedJob,
    startJob,
  })) {
    if (typeof operation !== 'function') throw new TypeError(`${name} must be a function`);
  }

  const { signal } = reservation;
  let job = null;
  let handedOff = false;
  const throwIfCancelled = () => {
    if (signal.aborted) throw signal.reason ?? new Error('Admission cancelled');
  };

  try {
    throwIfCancelled();
    const payload = await preparePayload(signal);
    throwIfCancelled();
    job = await enqueueJob(payload, signal);
    throwIfCancelled();

    // startJob is called directly, not in a later microtask. Its TaskManager
    // registration therefore becomes visible before cancellation can interleave.
    const execution = startJob(job, signal);
    handedOff = true;
    return {
      job,
      cancelled: false,
      execution: Promise.resolve(execution).finally(reservation.release),
    };
  } catch (error) {
    if (!signal.aborted) throw error;
    if (job) await cancelQueuedJob(job, signal.reason ?? error);
    return { job, cancelled: true, execution: null };
  } finally {
    if (!handedOff) reservation.release();
  }
}
