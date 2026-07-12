function componentActive(component) {
  if (!component) return false;
  if (typeof component.hasAnyActive === 'function') return component.hasAnyActive();
  return false;
}

export async function waitForLifecycleQuiescence(lifecycle, timeoutMs = 8_000) {
  if (!lifecycle) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!lifecycle.quiescent && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return lifecycle.quiescent === true;
}

/**
 * Release the single-instance lock only when every old-process execution
 * surface is proven quiescent. Retaining a lock is intentional: while this PID
 * lives, a supervisor cannot overlap a replacement; after exit, normal stale
 * lock recovery verifies the dead PID before removing it.
 */
export async function releaseInstanceLockIfQuiescent({
  instanceLock,
  lifecycle = null,
  componentResults = [],
  transportIdle = true,
  transportActive = false,
  logger = console,
}) {
  const live = [];
  if (lifecycle && lifecycle.quiescent !== true) live.push('lifecycle');
  for (const { name, component, idle } of componentResults) {
    if (!idle || componentActive(component)) live.push(name);
  }
  if (!transportIdle || transportActive) live.push('telegram');

  if (live.length > 0) {
    logger.warn?.('Instance lock retained because shutdown is not quiescent', {
      components: [...new Set(live)],
    });
    return { released: false, retained: true, live: [...new Set(live)] };
  }

  try {
    const released = await instanceLock.release();
    return { released: Boolean(released), retained: false, live: [] };
  } catch (error) {
    logger.error?.('Failed to release instance lock', {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
    return { released: false, retained: true, live: ['instance-lock'] };
  }
}
