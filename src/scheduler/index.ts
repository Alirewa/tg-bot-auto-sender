import cron, { ScheduledTask } from 'node-cron';
import config from '../utils/config';
import logger from '../utils/logger';
import { scrapeAll } from '../scraper';
import { validateStreaming, ProgressCallback } from '../validator';
import { ConfigRepo, SettingsRepo, StatsRepo } from '../database/repositories';
import { queue } from './queue';
import { publishConfig } from '../bot/publisher';
import { Telegraf } from 'telegraf';
import { ParsedConfig } from '../types';

let publishTask: ScheduledTask | null = null;
let scrapeTask: ScheduledTask | null = null;
let scraping = false;
let publishing = false;

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScrapeProgressEvent {
  phase: 'fetching' | 'parsing' | 'validating' | 'done';
  scraped?: number;
  fresh?: number;
  validated?: number;
  alive?: number;
  total?: number;
  done?: number;
}

export interface ScrapeOptions {
  onProgress?: (e: ScrapeProgressEvent) => void;
}

export interface ScrapeResult {
  scraped: number;
  fresh: number;
  alive: number;
  added: number;
}

// Fisher-Yates shuffle for picking a random sample without bias.
function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export async function runScrapeCycle(opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  if (scraping) {
    logger.info('scrape: skipped, already running');
    return { scraped: 0, fresh: 0, alive: 0, added: 0 };
  }
  scraping = true;
  const empty: ScrapeResult = { scraped: 0, fresh: 0, alive: 0, added: 0 };

  try {
    opts.onProgress?.({ phase: 'fetching' });
    const parsed = await scrapeAll();
    opts.onProgress?.({ phase: 'parsing', scraped: parsed.length });

    // Filter against permanent dedup set.
    const fresh = parsed.filter((c) => !ConfigRepo.exists(c.hash));
    logger.info('scrape: fresh after dedup', { fresh: fresh.length, total: parsed.length });

    // Randomly sample to cap cycle time. Without this a single 50k source
    // could lock the cycle for hours at 5s/probe.
    let sample: ParsedConfig[] = fresh;
    if (fresh.length > config.maxConfigsPerCycle) {
      shuffleInPlace(fresh);
      sample = fresh.slice(0, config.maxConfigsPerCycle);
      logger.info('scrape: sampled', {
        from: fresh.length,
        sampled: sample.length,
        cap: config.maxConfigsPerCycle,
      });
    }

    if (sample.length === 0) {
      opts.onProgress?.({ phase: 'done', scraped: parsed.length, fresh: 0, alive: 0 });
      return { scraped: parsed.length, fresh: 0, alive: 0, added: 0 };
    }

    const progressCb: ProgressCallback = (p) => {
      opts.onProgress?.({
        phase: 'validating',
        scraped: parsed.length,
        fresh: sample.length,
        total: p.total,
        done: p.done,
        alive: p.alive,
      });
    };

    let added = 0;
    const seenInThisCycle = new Set<string>();

    // Streaming: each alive config goes straight into the DB queue and the
    // in-memory publish queue the instant its probe returns.
    const alive = await validateStreaming(sample, {
      onProgress: progressCb,
      onAlive: (v) => {
        if (seenInThisCycle.has(v.hash)) return;
        seenInThisCycle.add(v.hash);
        try {
          ConfigRepo.insertValidated(v);
          StatsRepo.increment('total_validated', 1);
          if (queue.enqueueMany([v]) > 0) added++;
        } catch (err) {
          logger.debug('scrape: enqueue failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // Record failed ones so they're permanently deduped.
    const aliveHashes = new Set(alive.map((a) => a.hash));
    for (const f of sample) {
      if (!aliveHashes.has(f.hash)) {
        ConfigRepo.insertFailed(f, 'tcp probe failed');
        StatsRepo.increment('total_failed', 1);
      }
    }

    const removed = ConfigRepo.deleteOldDead(ONE_WEEK_MS);
    if (removed > 0) logger.info('cleanup: removed old dead configs', { removed });

    opts.onProgress?.({
      phase: 'done',
      scraped: parsed.length,
      fresh: sample.length,
      alive: alive.length,
    });

    return { scraped: parsed.length, fresh: sample.length, alive: alive.length, added };
  } catch (err) {
    logger.error('scrape cycle failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  } finally {
    scraping = false;
  }
}

async function publishTick(bot: Telegraf): Promise<void> {
  if (publishing) return;
  if (!SettingsRepo.getBool('auto_send', true)) return;

  publishing = true;
  try {
    if (queue.size() === 0) {
      logger.info('publish: queue empty, triggering scrape');
      await runScrapeCycle();
      if (queue.size() === 0) {
        logger.info('publish: still empty after scrape, will retry next tick');
        return;
      }
    }

    const next = queue.dequeue();
    if (!next) return;

    try {
      await publishConfig(bot, next);
      ConfigRepo.markPosted(next.hash);
      StatsRepo.incrementPostedToday();
      logger.info('publish: sent', {
        hash: next.hash.slice(0, 12),
        country: next.country,
        latencyMs: next.latencyMs,
      });
    } catch (err) {
      logger.error('publish: send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      ConfigRepo.markDead(next.hash);
    }
  } finally {
    publishing = false;
  }
}

export function startScheduler(bot: Telegraf): void {
  if (!cron.validate(config.publishCron)) {
    throw new Error(`Invalid PUBLISH_CRON: ${config.publishCron}`);
  }
  if (!cron.validate(config.scrapeCron)) {
    throw new Error(`Invalid SCRAPE_CRON: ${config.scrapeCron}`);
  }

  publishTask = cron.schedule(config.publishCron, () => {
    void publishTick(bot);
  });
  scrapeTask = cron.schedule(config.scrapeCron, () => {
    void runScrapeCycle();
  });

  logger.info('scheduler: started', {
    publishCron: config.publishCron,
    scrapeCron: config.scrapeCron,
  });

  void runScrapeCycle();
}

export function stopScheduler(): void {
  publishTask?.stop();
  scrapeTask?.stop();
  publishTask = null;
  scrapeTask = null;
  logger.info('scheduler: stopped');
}

export async function forceValidateQueue(
  opts: ScrapeOptions = {},
): Promise<{ revalidated: number; alive: number }> {
  const rows = ConfigRepo.loadQueued();
  const parsed: ParsedConfig[] = rows.map((r) => ({
    hash: r.hash,
    raw: r.raw,
    protocol: r.protocol,
    host: r.host,
    port: r.port,
  }));

  let aliveCount = 0;
  const alive = await validateStreaming(parsed, {
    onProgress: (p) => {
      opts.onProgress?.({
        phase: 'validating',
        total: p.total,
        done: p.done,
        alive: p.alive,
      });
    },
    onAlive: () => {
      aliveCount++;
    },
  });
  const aliveHashes = new Set(alive.map((a) => a.hash));
  for (const r of rows) {
    if (!aliveHashes.has(r.hash)) ConfigRepo.markDead(r.hash);
  }
  queue.clear();
  queue.enqueueMany(alive);
  opts.onProgress?.({ phase: 'done', total: rows.length, alive: aliveCount });
  return { revalidated: rows.length, alive: alive.length };
}
