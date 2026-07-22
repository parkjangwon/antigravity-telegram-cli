import path from 'node:path';

import { atomicWriteFile } from './atomic-write.js';
import { AGYGRAM_VERSION } from './version.js';

/**
 * Periodically writes a machine-readable health snapshot so external monitors
 * (systemd watchdog, cron, uptime checkers) can verify the bot is alive
 * without a Telegram round-trip.
 */
export class HealthWriter {
  #filePath;
  #providers = [];

  constructor(dataDir) {
    this.#filePath = path.join(dataDir, 'health.json');
  }

  /** Register a callback that returns extra key/value pairs for the snapshot. */
  register(provider) {
    if (typeof provider !== 'function') throw new TypeError('provider must be a function');
    this.#providers.push(provider);
  }

  async write() {
    const mem = process.memoryUsage();
    const snapshot = {
      status: 'ok',
      version: AGYGRAM_VERSION,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
    };
    for (const provider of this.#providers) {
      try {
        const extra = provider();
        if (extra && typeof extra === 'object') Object.assign(snapshot, extra);
      } catch {
        // A failing provider must not break the health snapshot.
      }
    }
    await atomicWriteFile(this.#filePath, JSON.stringify(snapshot, null, 2));
  }
}
