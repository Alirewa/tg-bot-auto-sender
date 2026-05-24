import * as crypto from 'crypto';
import { URL } from 'url';
import { ParsedConfig, Protocol } from '../types';
import logger from '../utils/logger';

const PROTOCOL_RE = /(vmess:\/\/[^\s]+|vless:\/\/[^\s]+|trojan:\/\/[^\s]+|ss:\/\/[^\s]+)/gi;

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalize(raw: string): string {
  return raw.trim();
}

function b64decode(s: string): string {
  // Handle URL-safe base64 and missing padding.
  const cleaned = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = cleaned.length % 4;
  const padded = pad ? cleaned + '='.repeat(4 - pad) : cleaned;
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function parseVmess(raw: string): { host: string; port: number } | null {
  try {
    const payload = raw.slice('vmess://'.length);
    // vmess payload may have a fragment we should strip first.
    const hashIdx = payload.indexOf('#');
    const body = hashIdx >= 0 ? payload.slice(0, hashIdx) : payload;
    const decoded = b64decode(body);
    const json = JSON.parse(decoded);
    const host = String(json.add ?? json.host ?? '').trim();
    const port = Number(json.port);
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function parseStandardUrl(raw: string): { host: string; port: number } | null {
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const port = Number(u.port);
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function parseSs(raw: string): { host: string; port: number } | null {
  // Two valid forms:
  // 1) ss://base64(method:password)@host:port[?plugin=...][#name]
  // 2) ss://base64(method:password@host:port)[#name]
  try {
    const payload = raw.slice('ss://'.length);
    const hashIdx = payload.indexOf('#');
    const body = hashIdx >= 0 ? payload.slice(0, hashIdx) : payload;

    const atIdx = body.indexOf('@');
    if (atIdx >= 0) {
      // Form (1): plain host:port part after @
      const hostPart = body.slice(atIdx + 1).split('?')[0];
      const [host, portStr] = hostPart.split(':');
      const port = Number(portStr);
      if (host && Number.isFinite(port) && port > 0 && port <= 65535) {
        return { host, port };
      }
      return null;
    }

    // Form (2): whole body is base64
    const decoded = b64decode(body);
    const at = decoded.lastIndexOf('@');
    if (at < 0) return null;
    const hp = decoded.slice(at + 1);
    const [host, portStr] = hp.split(':');
    const port = Number(portStr);
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function extractHostPort(
  protocol: Protocol,
  raw: string,
): { host: string; port: number } | null {
  switch (protocol) {
    case 'vmess':
      return parseVmess(raw);
    case 'vless':
    case 'trojan':
      return parseStandardUrl(raw);
    case 'ss':
      return parseSs(raw);
    default:
      return null;
  }
}

function detectProtocol(raw: string): Protocol | null {
  const lower = raw.slice(0, 10).toLowerCase();
  if (lower.startsWith('vmess://')) return 'vmess';
  if (lower.startsWith('vless://')) return 'vless';
  if (lower.startsWith('trojan://')) return 'trojan';
  if (lower.startsWith('ss://')) return 'ss';
  return null;
}

export function parseConfigsFromText(text: string): ParsedConfig[] {
  const matches = text.match(PROTOCOL_RE) ?? [];
  const out: ParsedConfig[] = [];
  const seen = new Set<string>();

  for (const m of matches) {
    const raw = normalize(m);
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);

    const protocol = detectProtocol(raw);
    if (!protocol) continue;

    try {
      const hp = extractHostPort(protocol, raw);
      if (!hp) continue;
      out.push({
        hash: sha256(raw),
        raw,
        protocol,
        host: hp.host,
        port: hp.port,
      });
    } catch (err) {
      logger.debug('parser error', {
        protocol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}
