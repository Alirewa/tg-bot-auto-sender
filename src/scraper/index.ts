import axios from 'axios';
import { getActiveSources, Source } from './sources';
import { parseConfigsFromText } from './parser';
import { ParsedConfig } from '../types';
import { retry } from '../utils/retry';
import logger from '../utils/logger';

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
