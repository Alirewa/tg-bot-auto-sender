import cron, { ScheduledTask } from 'node-cron';
import config from '../utils/config';
import logger from '../utils/logger';
import { scrapeAll } from '../scraper';
import { validateStreaming, ProgressCallback } from '../validator';
import { AnalyticsRepo, ConfigRepo, SettingsRepo, StatsRepo } from '../database/repositories';
import { queue } from './queue';
import { publishConfig, PublishError } from '../bot/publisher';
import { Telegraf } from 'telegraf';
import { ParsedConfig, ValidatedConfig } from '../types';
import { generateAndWriteSubs } from '../subscriptions';
import { getGithubPublisher } from '../github';
import { findXrayBinary, xrayProbe } from '../validator/xray';
import pLimit from 'p-limit';

let publishTask: ScheduledTask | null = null;
let scrapeTask: ScheduledTask | null = null;
let scraping = false;
let publishing = false;

// All active progress listeners — supports multiple concurrent callers
// watching the same scrape cycle (e.g. manual trigger while auto-cycle runs).
const progressListeners = new Set<(e: ScrapeProgressEvent) => void>();

function broadcast(e: ScrapeProgressEvent): void {
  for (const cb of progressListeners) {
    try { cb(e); } catch { /* never let a bad listener crash the cycle */ }
  }
  if (e.phase === 'done') progressListeners.clear();
}

export function isScraping(): boolean { return scraping; }

// Throttle the "auto_send is OFF" warning to once per 5 minutes so it
// appears in logs at warn level without flooding them.
let lastAutoSendWarnMs = 0;
const AUTO_SEND_WARN_INTERVAL_MS = 5 * 60 * 1000;

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScrapeProgressEvent {
  phase: 'fetching' | 'parsing' | 'validating' | 'xray' | 'done';
  scraped?: number;
  fresh?: number;
  validated?: number;
  alive?: number;
  total?: number;
  done?: number;
}

export interface ScrapeOptions {
  onProgress?: (e: ScrapeProgressEvent) => void;
  /** Limit scrape to specific source IDs. Omit to scrape all enabled sources. */
  sourceIds?: number[];
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
  // Register this caller's progress listener — works even when already scraping,
  // so a second manual trigger joins the live cycle instead of hanging.
  if (opts.onProgress) progressListeners.add(opts.onProgress);

  if (scraping) {
    logger.info('scrape: already running — subscriber joined');
    // Caller will receive remaining broadcast events from the running cycle.
    return { scraped: 0, fresh: 0, alive: 0, added: 0 };
  }
  scraping = true;
  const empty: ScrapeResult = { scraped: 0, fresh: 0, alive: 0, added: 0 };

  try {
    broadcast({ phase: 'fetching' });
    const { configs: parsed, perSource } = await scrapeAll(opts.sourceIds);
    if (perSource.length > 0) {
      logger.info('scrape: per-source results', {
        sources: perSource.map((r) => ({
          id: r.source.id,
          url: r.source.url.slice(0, 60),
          parsed: r.parsed,
          error: r.error,
        })),
      });
      // Persist per-source stats so the Sources menu can display them.
      SettingsRepo.setString(
        'last_scrape_per_source',
        JSON.stringify(
          perSource.map((r) => ({
            id: r.source.id,
            parsed: r.parsed,
            error: r.error ?? null,
          })),
        ),
      );
      SettingsRepo.setString('last_scrape_at', new Date().toISOString());
    }
    broadcast({ phase: 'parsing', scraped: parsed.length });

    // Filter against permanent dedup set.
    const fresh = parsed.filter((c) => !ConfigRepo.exists(c.hash));
    logger.info('scrape: fresh after dedup', { fresh: fresh.length, total: parsed.length });

    // Randomly sample to cap cycle time.
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
      broadcast({ phase: 'done', scraped: parsed.length, fresh: 0, alive: 0 });
      return { scraped: parsed.length, fresh: 0, alive: 0, added: 0 };
    }

    const progressCb: ProgressCallback = (p) => {
      broadcast({
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
    // Collect alive configs for subscription generation.
    const aliveConfigs: ValidatedConfig[] = [];

    // Streaming: each alive config goes straight into the DB queue and the
    // in-memory publish queue the instant its probe returns.
    const alive = await validateStreaming(sample, {
      onProgress: progressCb,
      onAlive: (v) => {
        if (seenInThisCycle.has(v.hash)) return;
        seenInThisCycle.add(v.hash);
        aliveConfigs.push(v); // collect for subscription generation
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

    // Record analytics for this cycle.
    try {
      const protoCounts: Record<string, number> = {};
      let latencySum = 0;
      for (const v of aliveConfigs) {
        protoCounts[v.protocol] = (protoCounts[v.protocol] ?? 0) + 1;
        latencySum += v.latencyMs;
      }
      const bestProtocol = aliveConfigs.length
        ? (Object.entries(protoCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
        : null;
      const countryCounts: Record<string, number> = {};
      for (const v of aliveConfigs) {
        if (v.country) countryCounts[v.country] = (countryCounts[v.country] ?? 0) + 1;
      }
      const bestCountry = aliveConfigs.length
        ? (Object.entries(countryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
        : null;

      AnalyticsRepo.insertCycle({
        cycle_at: Date.now(),
        total_scraped: parsed.length,
        total_validated: sample.length,
        alive_count: alive.length,
        dead_count: sample.length - alive.length,
        best_protocol: bestProtocol,
        best_country: bestCountry,
        avg_latency_ms:
          aliveConfigs.length > 0 ? Math.round(latencySum / aliveConfigs.length) : null,
        source_count: aliveConfigs.length,
      });
    } catch (err) {
      logger.debug('analytics: insert failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Xray sweep — always runs after TCP probe if xray binary is present.
    // Progress is forwarded to the caller so the UI can show a live xray bar.
    let finalAlive = alive.length;
    if (aliveConfigs.length > 0) {
      const xrayBin = findXrayBinary();
      if (xrayBin) {
        logger.info('scrape: xray sweep starting', { configs: aliveConfigs.length });
        opts.onProgress?.({ phase: 'xray', total: aliveConfigs.length, done: 0, alive: 0 });
        // Pass hashFilter so only this batch is tested — previous queue entries untouched.
        const newBatchHashes = new Set(aliveConfigs.map((v) => v.hash));
        try {
          const xrayResult = await validateWithXray({
            hashFilter: newBatchHashes,
            onProgress: (e) => {
              broadcast({
                phase: 'xray',
                total: e.total,
                done: e.done,
                alive: e.alive,
                scraped: parsed.length,
                fresh: sample.length,
              });
            },
          });
          finalAlive = xrayResult.alive;
          logger.info('scrape: xray sweep done', {
            revalidated: xrayResult.revalidated,
            alive: xrayResult.alive,
            removed: xrayResult.revalidated - xrayResult.alive,
          });
          // Persist xray result for Sources / Scan menu display.
          SettingsRepo.setString(
            'last_xray_result',
            JSON.stringify({
              tcpAlive: aliveConfigs.length,
              xrayAlive: xrayResult.alive,
              at: new Date().toISOString(),
            }),
          );
        } catch (err) {
          logger.warn('scrape: xray sweep failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Fire done AFTER xray so the final summary reflects confirmed-working configs.
    broadcast({
      phase: 'done',
      scraped: parsed.length,
      fresh: sample.length,
      alive: finalAlive,
    });

    // Generate subscription files from alive configs (non-blocking — errors are caught).
    if (aliveConfigs.length > 0) {
      try {
        await generateAndWriteSubs(aliveConfigs, {
          subsDir: config.subsDir,
          githubPublisher: getGithubPublisher(),
        });
      } catch (err) {
        logger.error('subscriptions: generation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
  if (!SettingsRepo.getBool('auto_send', true)) {
    const now = Date.now();
    if (now - lastAutoSendWarnMs > AUTO_SEND_WARN_INTERVAL_MS) {
      logger.warn('publish: auto_send is OFF — send /on to the bot to re-enable', {
        queueSize: queue.size(),
      });
      lastAutoSendWarnMs = now;
    }
    return;
  }

  publishing = true;
  logger.info('publish: tick — attempting', {
    queueSize: queue.size(),
    channel: SettingsRepo.getString('publish_channel', ''),
  });
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

    logger.info('publish: sending', {
      hash: next.hash.slice(0, 12),
      protocol: next.protocol,
      country: next.country,
    });

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
      if (err instanceof PublishError) {
        if (err.permanent) {
          // 400/401/403 — this config itself is not the problem; don't lose it.
          // Re-queue so it can be tried next cycle.
          queue.enqueueMany([next]);
          logger.warn('publish: re-queued config after permanent channel error', {
            hash: next.hash.slice(0, 12),
          });
          if (err.disableAutoSend) {
            SettingsRepo.setBool('auto_send', false);
            logger.error('publish: auto_send disabled — fix channel permissions and re-enable');
            // Notify the admin via DM so they don't have to check logs.
            bot.telegram
              .sendMessage(
                config.adminUserId,
                '⚠️ <b>Auto-send has been disabled!</b>\n\n' +
                  'Telegram rejected the last publish attempt.\n' +
                  `Error: <code>${err.message}</code>\n\n` +
                  'Fix the channel permissions, then send /on to re-enable.',
                { parse_mode: 'HTML' },
              )
              .catch(() => {
                /* ignore — bot might not have DM access yet */
              });
          }
        } else {
          // Transient (network, 5xx) — just log and skip, config stays in DB as queued.
          logger.warn('publish: transient failure, config kept queued', {
            hash: next.hash.slice(0, 12),
            error: err.message,
          });
          // Re-insert into memory queue for next tick.
          queue.enqueueMany([next]);
        }
      } else {
        // Unknown error — mark dead to avoid infinite retry loops.
        logger.error('publish: unknown error, marking dead', {
          hash: next.hash.slice(0, 12),
          error: err instanceof Error ? err.message : String(err),
        });
        ConfigRepo.markDead(next.hash);
      }
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

/**
 * Re-validates the current queue with a strict 1000ms timeout.
 * Only configs that respond within 1 second survive — the rest are marked dead.
 * Produces a much smaller but much higher-quality queue.
 */
/**
 * Validate queued configs using a real xray subprocess.
 * Routes an HTTP request through each config's VPN — only configs that
 * successfully proxy the request survive in the queue.
 *
 * This is the gold-standard check: it proves the UUID/password is valid
 * and the server actually routes traffic, not just that the port is open.
 *
 * Concurrency is low (default 5) because each check spawns a real process.
 */
export interface XrayValidateOptions {
  onProgress?: (e: ScrapeProgressEvent) => void;
  /**
   * When provided, only configs whose hash is in this set are tested.
   * Dead ones are removed from queue individually (not queue.clear).
   * When omitted the entire queued set is tested and queue is rebuilt.
   */
  hashFilter?: Set<string>;
}

export async function validateWithXray(
  opts: XrayValidateOptions = {},
): Promise<{ xrayFound: boolean; revalidated: number; alive: number }> {
  const xrayBin = findXrayBinary();
  if (!xrayBin) {
    return { xrayFound: false, revalidated: 0, alive: 0 };
  }

  const XRAY_CONCURRENCY = 5;
  const XRAY_TIMEOUT_MS = 10_000;

  const allQueued = ConfigRepo.loadQueued();
  // If a hashFilter is given, only test configs in this batch.
  const rows = opts.hashFilter
    ? allQueued.filter((r) => opts.hashFilter!.has(r.hash))
    : allQueued;

  if (rows.length === 0) {
    return { xrayFound: true, revalidated: 0, alive: 0 };
  }

  logger.info('xray-validate: starting', {
    total: rows.length,
    filtered: !!opts.hashFilter,
    concurrency: XRAY_CONCURRENCY,
    timeoutMs: XRAY_TIMEOUT_MS,
  });

  const limit = pLimit(XRAY_CONCURRENCY);
  let done = 0;
  let aliveCount = 0;

  opts.onProgress?.({ phase: 'validating', total: rows.length, done: 0, alive: 0 });

  await Promise.all(
    rows.map((r) =>
      limit(async () => {
        const c: ParsedConfig = {
          hash: r.hash,
          raw: r.raw,
          protocol: r.protocol,
          host: r.host,
          port: r.port,
        };
        const result = await xrayProbe(c, xrayBin, XRAY_TIMEOUT_MS);
        done++;
        if (result.alive) {
          aliveCount++;
        } else {
          // Mark dead in DB and remove from in-memory queue without touching other batches.
          ConfigRepo.markDead(r.hash);
          queue.remove(r.hash);
        }
        opts.onProgress?.({ phase: 'validating', total: rows.length, done, alive: aliveCount });
      }),
    ),
  );

  // When no filter: full queue rebuild (manual "Test queue" button path).
  // markDead already removed dead rows from DB; reload survivors from DB.
  if (!opts.hashFilter) {
    const survivors = ConfigRepo.loadQueued();
    const survivorValidated: ValidatedConfig[] = survivors.map((r) => {
      const code = r.country ?? 'XX';
      return {
        hash: r.hash, raw: r.raw, protocol: r.protocol,
        host: r.host, port: r.port,
        latencyMs: r.latency_ms ?? 0,
        country: code,
        flag: code.length === 2
          ? String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65))
          : '🏳️',
      };
    });
    queue.clear();
    queue.enqueueMany(survivorValidated);
  }

  opts.onProgress?.({ phase: 'done', total: rows.length, alive: aliveCount });
  logger.info('xray-validate: done', { revalidated: rows.length, alive: aliveCount });
  return { xrayFound: true, revalidated: rows.length, alive: aliveCount };
}

export async function validateQueueStrict(
  opts: ScrapeOptions = {},
): Promise<{ revalidated: number; alive: number }> {
  const STRICT_TIMEOUT_MS = 1000;
  const rows = ConfigRepo.loadQueued();
  const parsed: ParsedConfig[] = rows.map((r) => ({
    hash: r.hash,
    raw: r.raw,
    protocol: r.protocol,
    host: r.host,
    port: r.port,
  }));

  opts.onProgress?.({ phase: 'validating', total: parsed.length, done: 0, alive: 0 });

  const alive = await validateStreaming(parsed, {
    timeoutMs: STRICT_TIMEOUT_MS,
    onProgress: (p) => {
      opts.onProgress?.({ phase: 'validating', total: p.total, done: p.done, alive: p.alive });
    },
    onAlive: () => {},
  });

  const aliveHashes = new Set(alive.map((a) => a.hash));
  for (const r of rows) {
    if (!aliveHashes.has(r.hash)) ConfigRepo.markDead(r.hash);
  }
  queue.clear();
  queue.enqueueMany(alive);
  opts.onProgress?.({ phase: 'done', total: rows.length, alive: alive.length });
  logger.info('validate-strict: done', { revalidated: rows.length, alive: alive.length });
  return { revalidated: rows.length, alive: alive.length };
}

// ---------------------------------------------------------------------------
// Per-source xray health test
// ---------------------------------------------------------------------------

export interface SourceXrayStats {
  id: number;
  url: string;
  enabled: boolean;
  configCount: number;   // configs parsed from source
  sampled: number;       // how many were attempted (includes skipped)
  xrayTested: number;    // how many were actually tested (excl. skipped REALITY etc.)
  xrayAlive: number;     // how many passed xray
  xraySkipped: number;   // REALITY / WireGuard — untestable, not counted as failed
  fetchError?: string;
  checkedAt: string;
}

/**
 * For each subscription source (enabled + disabled), fetch it, parse configs,
 * take a small sample, and xray-test them.  Stores results in settings DB.
 * Returns per-source stats so the caller can display them.
 */
export async function testSourcesWithXray(
  maxSamplePerSource = 20,
): Promise<{ results: SourceXrayStats[]; xrayFound: boolean }> {
  const xrayBin = findXrayBinary();
  if (!xrayBin) return { results: [], xrayFound: false };

  const { SubsRepo: SR } = await import('../database/repositories');
  const { default: axios } = await import('axios');
  const { parseConfigsFromText } = await import('../scraper/parser');

  const all = SR.list();
  const XRAY_TIMEOUT = 12_000;  // 12s — generous timeout for real VPN test
  const CONCURRENCY = 3;
  const limit = pLimit(CONCURRENCY);
  const results: SourceXrayStats[] = [];

  for (const sub of all) {
    let configCount = 0;
    let sampled = 0;
    let xrayTested = 0;
    let xrayAlive = 0;
    let xraySkipped = 0;
    let fetchError: string | undefined;

    try {
      const res = await axios.get<string>(sub.url, {
        timeout: 15_000,
        responseType: 'text',
        transformResponse: [(v) => v],
        validateStatus: (s) => s >= 200 && s < 300,
      });
      const text = typeof res.data === 'string' ? res.data : String(res.data);
      const parsed = parseConfigsFromText(text);
      configCount = parsed.length;

      // Shuffle so the sample covers different servers, not just the first N.
      const shuffled = [...parsed].sort(() => Math.random() - 0.5);
      const sample = shuffled.slice(0, maxSamplePerSource);
      sampled = sample.length;

      const xrayTasks = sample.map((c) =>
        limit(async () => {
          const r = await xrayProbe(c, xrayBin, XRAY_TIMEOUT);
          if (r.skipped) {
            xraySkipped++;
          } else {
            xrayTested++;
            if (r.alive) xrayAlive++;
          }
        }),
      );
      await Promise.all(xrayTasks);
    } catch (err) {
      fetchError = err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80);
    }

    results.push({
      id: sub.id,
      url: sub.url,
      enabled: sub.enabled === 1,
      configCount,
      sampled,
      xrayTested,
      xrayAlive,
      xraySkipped,
      fetchError,
      checkedAt: new Date().toISOString(),
    });

    logger.info('source-xray-test', {
      id: sub.id,
      configCount,
      sampled,
      xrayTested,
      xrayAlive,
      xraySkipped,
      fetchError,
    });
  }

  // Persist for display in Sources menu.
  SettingsRepo.setString('last_source_xray', JSON.stringify(results));

  return { results, xrayFound: true };
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
