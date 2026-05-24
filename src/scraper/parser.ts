import * as crypto from 'crypto';
import { URL } from 'url';
import { ParsedConfig, Protocol } from '../types';
import logger from '../utils/logger';

const PROTOCOL_RE = /(vmess:\/\/[^\s]+|vless:\/\/[^\s]+|trojan:\/\/[^\s]+|ss:\/\/[^\s]+)/gi;
const PROTOCOL_DETECT_RE = /(vmess|vless|trojan|ss):\/\//i;

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalize(raw: string): string {
  return raw.trim();
}

function b64decode(s: string): string {
  const cleaned = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = cleaned.length % 4;
  const padded = pad ? cleaned + '='.repeat(4 - pad) : cleaned;
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function looksBase64(s: string): boolean {
  if (s.length < 24) return false;
  // Permit standard + URL-safe alphabets and padding.
  return /^[A-Za-z0-9+/_\-=\s]+$/.test(s);
}

/**
 * Many subscription endpoints return EITHER:
 *  - plain text with one config URI per line, OR
 *  - a single base64 blob that decodes into the plain-text form above.
 *
 * Some return the blob with embedded newlines. We unify all these into one
 * plain-text body before regex extraction.
 */
function unwrapBase64(text: string): string {
  const stripped = text.replace(/\s+/g, '');
  if (!looksBase64(stripped)) return text;
  try {
    const decoded = b64decode(stripped);
    if (PROTOCOL_DETECT_RE.test(decoded)) {
      return decoded;
    }
  } catch {
    /* ignore */
  }
  return text;
}

function decodePerLine(text: string): string {
  // Some sources mix protocol lines with base64-only lines. Decode the base64-only lines.
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (PROTOCOL_DETECT_RE.test(line)) {
      out.push(line);
      continue;
    }
    if (looksBase64(line)) {
      try {
        const decoded = b64decode(line);
        if (PROTOCOL_DETECT_RE.test(decoded)) {
          out.push(decoded);
          continue;
        }
      } catch {
        /* ignore */
      }
    }
    // keep as-is so the global regex can still try (cheap).
    out.push(line);
  }
  return out.join('\n');
}

function parseVmess(raw: string): { host: string; port: number } | null {
  try {
    const payload = raw.slice('vmess://'.length);
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
  try {
    const payload = raw.slice('ss://'.length);
    const hashIdx = payload.indexOf('#');
    const body = hashIdx >= 0 ? payload.slice(0, hashIdx) : payload;

    const atIdx = body.indexOf('@');
    if (atIdx >= 0) {
      const hostPart = body.slice(atIdx + 1).split('?')[0];
      const [host, portStr] = hostPart.split(':');
      const port = Number(portStr);
      if (host && Number.isFinite(port) && port > 0 && port <= 65535) {
        return { host, port };
      }
      return null;
    }

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
  // Step 1: if the whole body is one big base64 blob, decode it.
  let body = unwrapBase64(text);
  // Step 2: if some lines are individually base64-encoded, decode those.
  if (!PROTOCOL_DETECT_RE.test(body) || body === text) {
    body = decodePerLine(body);
  } else {
    // Still run per-line in case the decoded blob itself contains base64 lines.
    body = decodePerLine(body);
  }

  const matches = body.match(PROTOCOL_RE) ?? [];
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
