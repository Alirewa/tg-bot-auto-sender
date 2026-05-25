import axios from 'axios';
import { getActiveSources, Source } from './sources';
import { parseConfigsFromText } from './parser';
import { ParsedConfig } from '../types';
import { retry } from '../utils/retry';
import logger from '../utils/logger';
import { SubsRepo } from '../database/repositories';

const HTTP_TIMEOUT_MS = 15_000;

async function fetchOne(url: string): Promise<string> {
  return retry(
    async () => {
      const res = await axios.get<string>(url, {
        timeout: HTTP_TIMEOUT_MS,
        responseType: 'text',
        transformResponse: [(v) => v],
        headers: {
          'User-Agent': 'tg-bot-auto-sender/1.0 (+https://t.me/webdw)',
          Accept: 'text/plain,*/*',
        },
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return typeof res.data === 'string' ? res.data : String(res.data);
    },
    { attempts: 3, baseDelayMs: 800, label: `fetch ${url}` },
  );
}

export interface PerSourceResult {
  source: Source;
  parsed: number;
  error?: string;
}

/**
 * Scrape configs from sources.
 *
 * @param sourceIds  If provided, only scrape sources with these IDs.
 *                   If omitted/empty, scrape all enabled sources.
 * @returns          Deduplicated configs + per-source breakdown.
 */
export async function scrapeAll(sourceIds?: number[]): Promise<{
  configs: ParsedConfig[];
  perSource: PerSourceResult[];
}> {
  let sources = getActiveSources();
  if (sourceIds && sourceIds.length > 0) {
    sources = sources.filter((s) => sourceIds.includes(s.id));
  }
  if (sources.length === 0) {
    logger.warn('scrape: no enabled subscription links');
    return { configs: [], perSource: [] };
  }
  logger.info('scrape: starting', { sources: sources.length, filter: sourceIds ?? 'all' });

  const results = await Promise.allSettled(sources.map((s) => fetchOne(s.url)));

  const perSource: PerSourceResult[] = [];
  let combinedText = '';

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const src = sources[i]!;
    if (r.status === 'fulfilled') {
      const text = r.value;
      const parsed = parseConfigsFromText(text);
      perSource.push({ source: src, parsed: parsed.length });
      combinedText += '\n' + text;
    } else {
      const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      logger.warn('scrape: source failed', { source: src.url, error: errMsg });
      perSource.push({ source: src, parsed: 0, error: errMsg });
    }
  }

  const allParsed = parseConfigsFromText(combinedText);
  const byHash = new Map<string, ParsedConfig>();
  for (const c of allParsed) {
    if (!byHash.has(c.hash)) byHash.set(c.hash, c);
  }
  const configs = [...byHash.values()];

  logger.info('scrape: parsed', { total: allParsed.length, unique: configs.length });
  return { configs, perSource };
}

// ---------------------------------------------------------------------------
// Source health check
// ---------------------------------------------------------------------------

export type SourceHealthStatus = 'ok' | 'empty' | 'error';

export interface SourceHealthResult {
  id: number;
  url: string;
  enabled: boolean;
  status: SourceHealthStatus;
  configCount: number;
  error?: string;
}

/**
 * Fetch every source (enabled + disabled) and report how many valid
 * configs each one returns.  Broken or empty sources are auto-disabled.
 *
 * @returns per-source results + how many were auto-disabled
 */
export async function checkSourcesHealth(): Promise<{
  results: SourceHealthResult[];
  autoDisabled: number;
}> {
  const all = SubsRepo.list();
  if (all.length === 0) return { results: [], autoDisabled: 0 };

  logger.info('source-health: checking', { total: all.length });

  const fetches = await Promise.allSettled(all.map((s) => fetchOne(s.url)));

  const results: SourceHealthResult[] = [];
  let autoDisabled = 0;

  for (let i = 0; i < all.length; i++) {
    const sub = all[i]!;
    const r = fetches[i]!;

    let status: SourceHealthStatus;
    let configCount = 0;
    let error: string | undefined;

    if (r.status === 'rejected') {
      error = r.reason instanceof Error ? r.reason.message : String(r.reason);
      status = 'error';
    } else {
      configCount = parseConfigsFromText(r.value).length;
      status = configCount > 0 ? 'ok' : 'empty';
    }

    // Auto-disable sources that are broken or return nothing.
    if (status !== 'ok' && sub.enabled) {
      SubsRepo.toggle(sub.id, false);
      autoDisabled++;
      logger.warn('source-health: auto-disabled', { id: sub.id, url: sub.url, status, error });
    }

    results.push({
      id: sub.id,
      url: sub.url,
      enabled: sub.enabled === 1,
      status,
      configCount,
      error,
    });
  }

  logger.info('source-health: done', {
    ok: results.filter((r) => r.status === 'ok').length,
    empty: results.filter((r) => r.status === 'empty').length,
    error: results.filter((r) => r.status === 'error').length,
    autoDisabled,
  });

  return { results, autoDisabled };
}
