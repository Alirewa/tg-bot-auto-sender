import { ConfigRow, ValidatedConfig } from '../types';
import { ConfigRepo } from '../database/repositories';
import logger from '../utils/logger';

// In-memory FIFO queue, backed by SQLite rows with status='queued'.
class PublishQueue {
  private items: ValidatedConfig[] = [];

  loadFromDb(): void {
    const rows = ConfigRepo.loadQueued();
    this.items = rows.map(rowToValidated);
    logger.info('queue: restored from DB', { size: this.items.length });
  }

  enqueueMany(configs: ValidatedConfig[]): number {
    let added = 0;
    for (const c of configs) {
      if (this.items.some((q) => q.hash === c.hash)) continue;
      this.items.push(c);
      added++;
    }
    return added;
  }

  dequeue(): ValidatedConfig | undefined {
    return this.items.shift();
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  has(hash: string): boolean {
    return this.items.some((c) => c.hash === hash);
  }
}

function rowToValidated(row: ConfigRow): ValidatedConfig {
  const code = row.country ?? 'XX';
  return {
    hash: row.hash,
    raw: row.raw,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    latencyMs: row.latency_ms ?? 0,
    country: code,
    flag: countryToFlag(code),
  };
}

function countryToFlag(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const upper = code.toUpperCase();
  const A = 0x41;
  const base = 0x1f1e6;
  return String.fromCodePoint(base + upper.charCodeAt(0) - A, base + upper.charCodeAt(1) - A);
}

export const queue = new PublishQueue();
