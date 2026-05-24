import { Protocol } from '../types';

function b64decode(s: string): string {
  const cleaned = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = cleaned.length % 4;
  const padded = pad ? cleaned + '='.repeat(4 - pad) : cleaned;
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function b64encode(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

/**
 * Rewrites the human-readable label of a config URI to `label`.
 * - vmess: rewrites the `ps` field inside the base64 JSON payload.
 * - vless / trojan / ss: replaces the URI fragment (`#...`).
 *
 * If anything goes wrong the original `raw` is returned unchanged so the
 * publisher can still send a working (but un-renamed) config.
 */
export function renameConfig(protocol: Protocol, raw: string, label: string): string {
  try {
    if (protocol === 'vmess') return renameVmess(raw, label);
    return replaceFragment(raw, label);
  } catch {
    return raw;
  }
}

function renameVmess(raw: string, label: string): string {
  const prefix = 'vmess://';
  if (!raw.toLowerCase().startsWith(prefix)) return raw;
  const payload = raw.slice(prefix.length);
  const hashIdx = payload.indexOf('#');
  const body = hashIdx >= 0 ? payload.slice(0, hashIdx) : payload;
  const decoded = b64decode(body);
  const json = JSON.parse(decoded);
  json.ps = label;
  const re = b64encode(JSON.stringify(json));
  return prefix + re;
}

function replaceFragment(raw: string, label: string): string {
  const hashIdx = raw.indexOf('#');
  const base = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  return `${base}#${encodeURIComponent(label)}`;
}
