import pLimit from 'p-limit';
import { ParsedConfig, ValidatedConfig } from '../types';
import { smartProbe } from './probe';
import { resolveCountry } from '../geoip';
import config from '../utils/config';
import logger from '../utils/logger';

export interface ValidateProgress {
  total: number;
  done: number;
  alive: number;
  dead: number;
}

export type ProgressCallback = (p: ValidateProgress) => void;

export interface StreamCallbacks {
  onAlive?: (c: ValidatedConfig) => void;
  onProgress?: ProgressCallback;
}

/**
 * Run TCP probes concurrently and stream each alive config the moment it
 * passes (rather than waiting for the whole batch). This lets the scheduler
 * start publishing within seconds, even on a 1500-config cycle.
 */
export async function validateStreaming(
  configs: ParsedConfig[],
  cb: StreamCallbacks = {},
): Promise<ValidatedConfig[]> {
  if (configs.length === 0) return [];

  const limit = pLimit(config.validationConcurrency);
  const alive: ValidatedConfig[] = [];
  let done = 0;
  let aliveCount = 0;
  let deadCount = 0;

  logger.info('validate: starting', {
    total: configs.length,
    concurrency: config.validationConcurrency,
    timeoutMs: config.tcpTimeoutMs,
  });

  const tasks = configs.map((c) =>
    limit(async () => {
      const probe = await smartProbe(c, config.tcpTimeoutMs);
      done++;
      if (!probe.alive) {
        deadCount++;
      } else {
        const geo = await resolveCountry(c.host);
        const v: ValidatedConfig = {
          ...c,
          latencyMs: probe.latencyMs,
          country: geo.countryCode,
          flag: geo.flag,
        };
        alive.push(v);
        aliveCount++;
        cb.onAlive?.(v);
      }
      cb.onProgress?.({ total: configs.length, done, alive: aliveCount, dead: deadCount });
    }),
  );

  await Promise.all(tasks);
  alive.sort((a, b) => a.latencyMs - b.latencyMs);

  logger.info('validate: done', { total: configs.length, alive: alive.length });
  return alive;
}

// Legacy batch API retained for callers that don't need streaming.
export async function validateBatch(configs: ParsedConfig[]): Promise<ValidatedConfig[]> {
  return validateStreaming(configs);
}
