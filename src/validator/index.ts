import pLimit from 'p-limit';
import { ParsedConfig, ValidatedConfig } from '../types';
import { tcpProbe } from './tcp';
import { resolveCountry } from '../geoip';
import config from '../utils/config';
import logger from '../utils/logger';

export async function validateBatch(configs: ParsedConfig[]): Promise<ValidatedConfig[]> {
  if (configs.length === 0) return [];

  const limit = pLimit(config.validationConcurrency);
  logger.info('validate: starting', {
    total: configs.length,
    concurrency: config.validationConcurrency,
  });

  const tasks = configs.map((c) =>
    limit(async (): Promise<ValidatedConfig | null> => {
      const probe = await tcpProbe(c.host, c.port, config.tcpTimeoutMs);
      if (!probe.alive) return null;
      const geo = await resolveCountry(c.host);
      return {
        ...c,
        latencyMs: probe.latencyMs,
        country: geo.countryCode,
        flag: geo.flag,
      };
    }),
  );

  const results = await Promise.all(tasks);
  const alive = results.filter((r): r is ValidatedConfig => r !== null);
  // Health score: prefer lower latency.
  alive.sort((a, b) => a.latencyMs - b.latencyMs);

  logger.info('validate: done', {
    alive: alive.length,
    dead: configs.length - alive.length,
  });

  return alive;
}
