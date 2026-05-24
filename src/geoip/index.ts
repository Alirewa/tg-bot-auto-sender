import * as net from 'net';
import * as dns from 'dns';
import geoip from 'geoip-lite';
import { GeoResult } from '../types';
import { countryCodeToFlag } from './flags';
import logger from '../utils/logger';

const lookup = dns.promises.lookup;

interface CacheEntry {
  result: GeoResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const cache = new Map<string, CacheEntry>();

const FALLBACK: GeoResult = { countryCode: 'XX', flag: '🏳️' };

export async function resolveCountry(host: string): Promise<GeoResult> {
  if (!host) return FALLBACK;

  const cached = cache.get(host);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    let ip = host;
    if (net.isIP(host) === 0) {
      const r = await lookup(host, { family: 0 });
      ip = r.address;
    }
    const geo = geoip.lookup(ip);
    const result: GeoResult = geo
      ? { countryCode: geo.country, flag: countryCodeToFlag(geo.country) }
      : FALLBACK;
    cache.set(host, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('geoip resolution failed', { host, error: message });
    cache.set(host, { result: FALLBACK, expiresAt: Date.now() + 60_000 });
    return FALLBACK;
  }
}
