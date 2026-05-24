import * as crypto from 'crypto';
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
  return /^[A-Za-z0-9+/_\-=\s]+$/.test(s);
}

/**
 * Some sources serve a single base64 blob that decodes into plain-text URIs.
 * Detect and unwrap that wrapper; otherwise return text as-is.
 */
function unwrapBase64(text: string): string {
  const stripped = text.replace(/\s+/g, '');
  if (!looksBase64(stripped)) return text;
  try {
    const decoded = b64decode(stripped);
    if (PROTOCOL_DETECT_RE.test(decoded)) return decoded;
  } catch {
    /* ignore */
  }
  return text;
}

/**
 * Some files mix protocol lines with single-line base64 blobs. Decode lines that
 * look base64 AND decode into protocol URIs; pass everything else through.
 */
function decodePerLine(text: string): string {
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
    out.push(line);
  }
  return out.join('\n');
}

// --------------------- per-protocol host/port extraction ---------------------

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

/**
 * Manual extractor for vless:// and trojan:// URIs.
 *
 * Why not `new URL(raw)`? Node's WHATWG URL parser treats `vless`/`trojan` as
 * non-special schemes, which means `.hostname` and `.port` come back empty —
 * so EVERY config silently fails to parse. We extract them with a regex
 * instead, which also tolerates IPv6 hosts inside `[brackets]`.
 *
 *   vless://<userinfo>@<host>:<port>[?query][#fragment]
 */
function parseUserinfoUrl(raw: string, scheme: string): { host: string; port: number } | null {
  const prefix = `${scheme}://`;
  if (!raw.toLowerCase().startsWith(prefix)) return null;
  const body = raw.slice(prefix.length);

  const atIdx = body.indexOf('@');
  if (atIdx < 0) return null;

  let rest = body.slice(atIdx + 1);
  // Strip query and fragment.
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);

  let host: string;
  let portStr: string;

  if (rest.startsWith('[')) {
    // IPv6: [::1]:443
    const end = rest.indexOf(']');
    if (end < 0) return null;
    host = rest.slice(1, end);
    const after = rest.slice(end + 1);
    if (!after.startsWith(':')) return null;
    portStr = after.slice(1);
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon < 0) return null;
    host = rest.slice(0, colon);
    portStr = rest.slice(colon + 1);
    // Strip any trailing path separator the regex might have included.
    const slash = portStr.indexOf('/');
    if (slash >= 0) portStr = portStr.slice(0, slash);
  }

  host = host.trim();
  const port = Number.parseInt(portStr, 10);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function parseSs(raw: string): { host: string; port: number } | null {
  // ss URIs come in two shapes:
  //   1) ss://base64(method:password)@host:port[?plugin=...][#name]
  //   2) ss://base64(method:password@host:port)[#name]
  try {
    const payload = raw.slice('ss://'.length);
    const hashIdx = payload.indexOf('#');
    const body = hashIdx >= 0 ? payload.slice(0, hashIdx) : payload;

    const atIdx = body.indexOf('@');
    if (atIdx >= 0) {
      let hostPart = body.slice(atIdx + 1);
      const cut = hostPart.search(/[?/]/);
      if (cut >= 0) hostPart = hostPart.slice(0, cut);
      let host: string;
      let portStr: string;
      if (hostPart.startsWith('[')) {
        const end = hostPart.indexOf(']');
        if (end < 0) return null;
        host = hostPart.slice(1, end);
        const after = hostPart.slice(end + 1);
        if (!after.startsWith(':')) return null;
        portStr = after.slice(1);
      } else {
        const colon = hostPart.lastIndexOf(':');
        if (colon < 0) return null;
        host = hostPart.slice(0, colon);
        portStr = hostPart.slice(colon + 1);
      }
      const port = Number.parseInt(portStr, 10);
      if (host && Number.isFinite(port) && port > 0 && port <= 65535) {
        return { host, port };
      }
      return null;
    }

    const decoded = b64decode(body);
    const at = decoded.lastIndexOf('@');
    if (at < 0) return null;
    const hp = decoded.slice(at + 1);
    const colon = hp.lastIndexOf(':');
    if (colon < 0) return null;
    const host = hp.slice(0, colon);
    const port = Number.parseInt(hp.slice(colon + 1), 10);
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
      return parseUserinfoUrl(raw, 'vless');
    case 'trojan':
      return parseUserinfoUrl(raw, 'trojan');
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
  // Stage 1: unwrap a whole-body base64 blob (some sources do this).
  let body = unwrapBase64(text);
  // Stage 2: also decode per-line in case some lines are individually base64.
  body = decodePerLine(body);

  const matches = body.match(PROTOCOL_RE) ?? [];
  const out: ParsedConfig[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const m of matches) {
    const raw = normalize(m);
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);

    const protocol = detectProtocol(raw);
    if (!protocol) {
      dropped++;
      continue;
    }

    try {
      const hp = extractHostPort(protocol, raw);
      if (!hp) {
        dropped++;
        continue;
      }
      out.push({
        hash: sha256(raw),
        raw,
        protocol,
        host: hp.host,
        port: hp.port,
      });
    } catch (err) {
      dropped++;
      logger.debug('parser error', {
        protocol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (matches.length > 0 && out.length === 0) {
    logger.warn('parser: regex matched URIs but extraction yielded zero', {
      matched: matches.length,
      dropped,
      sample: matches[0]?.slice(0, 120),
    });
  } else if (dropped > 0) {
    logger.info('parser: dropped malformed URIs', { kept: out.length, dropped });
  }

  return out;
}
