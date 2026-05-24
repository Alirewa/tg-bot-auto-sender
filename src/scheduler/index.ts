import cron, { ScheduledTask } from 'node-cron';
import config from '../utils/config';
import logger from '../utils/logger';
import { scrapeAll } from '../scraper';
import { validateBatch } from '../validator';
import { ConfigRepo, SettingsRepo, StatsRepo } from '../database/repositories';
import { queue } from './queue';
import { publishConfig } from '../bot/publisher';
import { Telegraf } from 'telegraf';

let publishTask: ScheduledTask | null = null;
let scrapeTask: ScheduledTask | null = null;
let scraping = false;
let publishing = false;

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function runScrapeCycle(): Promise<{ scraped: number; added: number }> {
  if (scraping) {
    logger.info('scrape: skipped, already running');
    return { scraped: 0, added: 0 };
  }
  scraping = true;
  try {
    const parsed = await scrapeAll();
    const fresh = parsed.filter((c) => !ConfigRepo.exists(c.hash));
    logger.info('scrape: fresh after dedup', { fresh: fresh.length, total: parsed.length });

    const validated = await validateBatch(fresh);

    for (const v of validated) {
      ConfigRepo.insertValidated(v);
      StatsRepo.increment('total_validated', 1);
    }
    const failed = fresh.filter((f) => !validated.some((v) => v.hash === f.hash));
    for (const f of failed) {
      ConfigRepo.insertFailed(f, 'tcp probe failed');
      StatsRepo.increment('total_failed', 1);
    }

    const added = queue.enqueueMany(validated);

    const removed = ConfigRepo.deleteOldDead(ONE_WEEK_MS);
    if (removed > 0) logger.info('cleanup: removed old dead configs', { removed });

    return { scraped: parsed.length, added };
  } catch (err) {
    logger.error('scrape cycle failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { scraped: 0, added: 0 };
  } finally {
    scraping = false;
  }
}

async function publishTick(bot: Telegraf): Promise<void> {
  if (publishing) return;

  // Respect admin's auto-send toggle.
  if (!SettingsRepo.getBool('auto_send', true)) {
    return;
  }

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
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('publish: send failed', { error: msg });
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

export async function forceValidateQueue(): Promise<{ revalidated: number; alive: number }> {
  const rows = ConfigRepo.loadQueued();
  const parsed = rows.map((r) => ({
    hash: r.hash,
    raw: r.raw,
    protocol: r.protocol,
    host: r.host,
    port: r.port,
  }));
  const alive = await validateBatch(parsed);
  const aliveHashes = new Set(alive.map((a) => a.hash));
  for (const r of rows) {
    if (!aliveHashes.has(r.hash)) ConfigRepo.markDead(r.hash);
  }
  queue.clear();
  queue.enqueueMany(alive);
  return { revalidated: rows.length, alive: alive.length };
}
