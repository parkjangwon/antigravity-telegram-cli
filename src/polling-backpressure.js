/**
 * Stop Telegraf long polling without confirming the already-fetched batch.
 *
 * Telegraf advances its in-memory offset before it awaits batch handlers. Its
 * Polling.finally normally confirms that offset once the loop fails. Setting
 * skipOffsetSync before stopping is therefore required when a durable update
 * decision could not be recorded: after process restart Telegram redelivers
 * the unconfirmed batch instead of silently losing it.
 */
export function stopPollingWithoutOffsetCommit(bot) {
  const polling = bot?.polling;
  if (!polling || typeof polling.stop !== 'function') return false;
  polling.skipOffsetSync = true;
  polling.stop();
  return true;
}
