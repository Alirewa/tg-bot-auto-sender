import axios from 'axios';
import { getActiveSourceUrls } from './sources';
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

export async function scrapeAll(): Promise<ParsedConfig[]> {
  const urls = getActiveSourceUrls();
  if (urls.length === 0) {
    logger.warn('scrape: no enabled subscription links');
    return [];
  }
  logger.info('scrape: starting', { sources: urls.length });

  const results = await Promise.allSettled(urls.map((u) => fetchOne(u)));

  let combinedText = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      combinedText += '\n' + r.value;
    } else {
      logger.warn('scrape: source failed', {
        source: urls[i],
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  const parsed = parseConfigsFromText(combinedText);
  const byHash = new Map<string, ParsedConfig>();
  for (const c of parsed) {
    if (!byHash.has(c.hash)) byHash.set(c.hash, c);
  }
  const unique = [...byHash.values()];

  logger.info('scrape: parsed', { total: parsed.length, unique: unique.length });
  return unique;
}
