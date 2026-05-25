/**
 * Smart protocol-aware probe.
 *
 * Validation tiers (best-signal first):
 *   1. WS configs  → HTTP Upgrade handshake; alive only if server replies 101
 *   2. Trojan      → TLS handshake (rejectUnauthorized=false); alive if TLS succeeds
 *   3. Everything else (VMess/SS/WireGuard plain TCP, REALITY) → raw TCP probe
 *
 * Rationale: a plain TCP connect only proves the port is open. A WebSocket
 * upgrade proves the VPN WebSocket path is running. A TLS handshake proves
 * the Trojan TLS endpoint is up. Both cut out ~30–50% of false-positives that
 * slip through a TCP-only check.
 */

import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { ParsedConfig, Protocol, ProbeResult } from '../types';
import { tcpProbe } from './tcp';

// ---------------------------------------------------------------------------
// Transport info parsed from config URI
// ---------------------------------------------------------------------------

interface Transport {
  type: 'ws' | 'tls-only' | 'tcp';
  useTls: boolean;
  path: string;
  sni: string;
}

function parseQueryParams(raw: string): URLSearchParams {
  const qIdx = raw.indexOf('?');
  if (qIdx < 0) return new URLSearchParams();
  const fragment = raw.indexOf('#', qIdx);
  return new URLSearchParams(fragment >= 0 ? raw.slice(qIdx + 1, fragment) : raw.slice(qIdx + 1));
}

function parseVlessTransport(raw: string): Transport {
  try {
    const p = parseQueryParams(raw);
    const type = p.get('type') ?? 'tcp';
    const security = (p.get('security') ?? 'none').toLowerCase();
    // REALITY requires Xray internals — can't probe it; fall back to TCP.
    if (security === 'reality') {
      return { type: 'tcp', useTls: false, path: '/', sni: '' };
    }
    const useTls = security === 'tls';
    const path = p.get('path') ?? '/';
    const sni = p.get('sni') ?? p.get('host') ?? '';
    if (type === 'ws') return { type: 'ws', useTls, path, sni };
    if (useTls) return { type: 'tls-only', useTls: true, path, sni };
    return { type: 'tcp', useTls: false, path, sni };
  } catch {
    return { type: 'tcp', useTls: false, path: '/', sni: '' };
  }
}

function parseVmessTransport(raw: string): Transport {
  try {
    const payload = raw.slice('vmess://'.length).replace(/#.*/, '');
    const cleaned = payload.replace(/-/g, '+').replace(/_/g, '/');
    const pad = cleaned.length % 4;
    const json = JSON.parse(
      Buffer.from(pad ? cleaned + '='.repeat(4 - pad) : cleaned, 'base64').toString('utf8'),
    );
    const netType: string = json.net ?? json.network ?? 'tcp';
    const tlsField: string = json.tls ?? '';
    const useTls = tlsField === 'tls';
    const path: string = json.path ?? '/';
    const sni: string = json.sni ?? json.host ?? '';
    if (netType === 'ws') return { type: 'ws', useTls, path, sni };
    if (useTls) return { type: 'tls-only', useTls: true, path, sni };
    return { type: 'tcp', useTls: false, path, sni };
  } catch {
    return { type: 'tcp', useTls: false, path: '/', sni: '' };
  }
}

function parseTrojanTransport(raw: string): Transport {
  try {
    const p = parseQueryParams(raw);
    const type = p.get('type') ?? 'tcp';
    const sni = p.get('sni') ?? p.get('peer') ?? '';
    const path = p.get('path') ?? '/';
    // Trojan is always TLS; WS over TLS is supported too.
    if (type === 'ws') return { type: 'ws', useTls: true, path, sni };
    return { type: 'tls-only', useTls: true, path, sni };
  } catch {
    return { type: 'tls-only', useTls: true, path: '/', sni: '' };
  }
}

function parseTransport(protocol: Protocol, raw: string): Transport {
  switch (protocol) {
    case 'vless':
      return parseVlessTransport(raw);
    case 'vmess':
      return parseVmessTransport(raw);
    case 'trojan':
      return parseTrojanTransport(raw);
    default:
      // ss, wireguard — no protocol-specific probe available
      return { type: 'tcp', useTls: false, path: '/', sni: '' };
  }
}

// ---------------------------------------------------------------------------
// WebSocket upgrade probe
// ---------------------------------------------------------------------------

function wsProbe(
  host: string,
  port: number,
  transport: Transport,
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const start = Date.now();
    let settled = false;
    let socket: net.Socket | tls.TLSSocket | null = null;

    const done = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    // Hard outer timeout — guards against any edge case that bypasses the
    // socket's own timeout (e.g. TLS slow-start).
    const hardTimer = setTimeout(() => {
      done({ alive: false, latencyMs: timeoutMs, error: 'ws-hard-timeout' });
    }, timeoutMs + 200);

    const wsKey = crypto.randomBytes(16).toString('base64');
    const sni = transport.sni || host;
    const path = transport.path || '/';

    const request =
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${sni}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `\r\n`;

    const onConnect = (): void => {
      socket!.write(request);
    };

    const onData = (data: Buffer): void => {
      const resp = data.toString('ascii', 0, 48);
      // HTTP/1.x 101 → WebSocket upgrade accepted → VPN endpoint is live.
      if (/HTTP\/\d(?:\.\d)? 101/.test(resp)) {
        done({ alive: true, latencyMs: Date.now() - start });
      } else {
        // Any other HTTP response (400, 404, 200, etc.) means the server is
        // running but the WS path/config is wrong → treat as dead.
        const code = resp.match(/HTTP\/\d(?:\.\d)? (\d+)/)?.[1] ?? '???';
        done({ alive: false, latencyMs: Date.now() - start, error: `ws-${code}` });
      }
    };

    const onError = (err: Error): void => {
      done({ alive: false, latencyMs: Date.now() - start, error: err.message });
    };

    const onTimeout = (): void => {
      done({ alive: false, latencyMs: timeoutMs, error: 'ws-socket-timeout' });
    };

    if (transport.useTls) {
      socket = tls.connect(
        {
          host,
          port,
          servername: sni,
          rejectUnauthorized: false, // VPN servers often have self-signed / custom certs
          timeout: timeoutMs,
        },
        onConnect,
      );
    } else {
      socket = net.createConnection({ host, port }, onConnect);
      socket.setTimeout(timeoutMs);
    }

    socket.once('data', onData);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

// ---------------------------------------------------------------------------
// TLS-only probe (for Trojan non-WS / VLESS TLS-TCP)
// ---------------------------------------------------------------------------

function tlsOnlyProbe(
  host: string,
  port: number,
  sni: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const start = Date.now();
    let settled = false;

    const done = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const hardTimer = setTimeout(() => {
      done({ alive: false, latencyMs: timeoutMs, error: 'tls-hard-timeout' });
    }, timeoutMs + 200);

    const socket = tls.connect(
      {
        host,
        port,
        servername: sni || host,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {
        // TLS handshake succeeded — the server is up.
        done({ alive: true, latencyMs: Date.now() - start });
      },
    );

    socket.once('error', (err) => {
      done({ alive: false, latencyMs: Date.now() - start, error: err.message });
    });
    socket.once('timeout', () => {
      done({ alive: false, latencyMs: timeoutMs, error: 'tls-timeout' });
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Choose the best available probe for this config:
 *   - WS transport  → WebSocket upgrade (must receive HTTP 101)
 *   - TLS transport → TLS handshake
 *   - Otherwise     → raw TCP connect
 *
 * Falls back to TCP on any unexpected parse/probe error so a single
 * malformed config never crashes the whole validation batch.
 */
export async function smartProbe(c: ParsedConfig, timeoutMs: number): Promise<ProbeResult> {
  try {
    const t = parseTransport(c.protocol, c.raw);

    if (t.type === 'ws') {
      return await wsProbe(c.host, c.port, t, timeoutMs);
    }
    if (t.type === 'tls-only') {
      return await tlsOnlyProbe(c.host, c.port, t.sni, timeoutMs);
    }
    // tcp / fallback
    return await tcpProbe(c.host, c.port, timeoutMs);
  } catch {
    return await tcpProbe(c.host, c.port, timeoutMs);
  }
}
