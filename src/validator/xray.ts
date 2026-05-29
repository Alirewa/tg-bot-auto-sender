/**
 * xray-based config validator.
 *
 * For each config:
 *   1. Parse the URI into an xray outbound JSON block
 *   2. Wrap it in a minimal xray config with a SOCKS5 inbound on a free port
 *   3. Spawn xray, wait for the SOCKS port to open
 *   4. Send an HTTP request through the SOCKS5 proxy to a neutral test URL
 *   5. If we get a 2xx/3xx within the timeout → the VPN actually works
 *
 * Protocols supported: vless, vmess, trojan, ss (shadowsocks)
 * REALITY configs are skipped (require Xray internals that can't be probed externally).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as child_process from 'child_process';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ParsedConfig, ProbeResult } from '../types';
import logger from '../utils/logger';

// Neutral URL that returns 204/200 quickly regardless of geo-location.
const TEST_URLS = [
  'http://cp.cloudflare.com/',
  'http://www.gstatic.com/generate_204',
  'http://detectportal.firefox.com/canonical.html',
];

// ---------------------------------------------------------------------------
// Find xray binary
// ---------------------------------------------------------------------------

let _cachedXrayPath: string | null | undefined; // undefined = not searched yet

export function findXrayBinary(): string | null {
  if (_cachedXrayPath !== undefined) return _cachedXrayPath;

  const candidates = [
    process.env['XRAY_PATH'],
    '/usr/local/bin/xray',
    '/usr/bin/xray',
    '/opt/xray/xray',
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        _cachedXrayPath = p;
        logger.info('xray: binary found', { path: p });
        return p;
      }
    } catch { /* ignore */ }
  }

  // Try `which`
  try {
    const which = child_process
      .execSync('which xray 2>/dev/null', { timeout: 3_000 })
      .toString()
      .trim();
    if (which) {
      _cachedXrayPath = which;
      logger.info('xray: binary found via which', { path: which });
      return which;
    }
  } catch { /* not installed */ }

  _cachedXrayPath = null;
  return null;
}

// ---------------------------------------------------------------------------
// Port helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForSocksPort(port: number, maxMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    function attempt(): void {
      if (Date.now() > deadline) { resolve(false); return; }
      const sock = new net.Socket();
      sock.setTimeout(250);
      sock.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => { sock.destroy(); setTimeout(attempt, 200); });
      sock.on('timeout', () => { sock.destroy(); setTimeout(attempt, 200); });
    }
    attempt();
  });
}

// ---------------------------------------------------------------------------
// URI → xray outbound
// ---------------------------------------------------------------------------

function b64(s: string): string {
  const c = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = c.length % 4;
  return Buffer.from(pad ? c + '='.repeat(4 - pad) : c, 'base64').toString('utf-8');
}

function qs(raw: string): URLSearchParams {
  const qi = raw.indexOf('?');
  if (qi < 0) return new URLSearchParams();
  const fi = raw.indexOf('#', qi);
  return new URLSearchParams(fi >= 0 ? raw.slice(qi + 1, fi) : raw.slice(qi + 1));
}

function decodePath(raw: string): string {
  try { return decodeURIComponent(raw || '/'); } catch { return raw || '/'; }
}

function streamSettings(
  network: string,
  security: string,
  wsPath: string,
  wsHost: string,
  sni: string,
  fallbackHost: string,
): Record<string, unknown> {
  const ss: Record<string, unknown> = { network };
  const effectiveHost = wsHost || sni || fallbackHost;

  if (security === 'tls') {
    ss['security'] = 'tls';
    ss['tlsSettings'] = {
      serverName: sni || wsHost || fallbackHost,
      allowInsecure: true,
      fingerprint: 'chrome',
    };
  } else {
    ss['security'] = 'none';
  }

  if (network === 'ws') {
    ss['wsSettings'] = {
      path: decodePath(wsPath),
      headers: { Host: effectiveHost },
    };
  } else if (network === 'grpc') {
    ss['grpcSettings'] = { serviceName: wsPath || '' };
  } else if (network === 'httpupgrade' || network === 'http') {
    // httpUpgrade transport — used widely in CDN-based free configs.
    ss['httpUpgradeSettings'] = {
      path: decodePath(wsPath),
      host: effectiveHost,
    };
  } else if (network === 'xhttp' || network === 'splithttp') {
    ss['xhttpSettings'] = {
      path: decodePath(wsPath),
      host: effectiveHost,
    };
  } else if (network === 'h2') {
    ss['h2Settings'] = {
      path: decodePath(wsPath),
      host: [effectiveHost].filter(Boolean),
    };
  }
  // tcp: no extra settings needed

  return ss;
}

function vlessOutbound(c: ParsedConfig): Record<string, unknown> | null {
  try {
    const body = c.raw.slice('vless://'.length);
    const atIdx = body.indexOf('@');
    if (atIdx < 0) return null;
    const uuid = body.slice(0, atIdx);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) return null;

    const p = qs(c.raw);
    const security = (p.get('security') ?? 'none').toLowerCase();
    if (security === 'reality') return null; // REALITY requires Xray internals

    return {
      protocol: 'vless',
      settings: {
        vnext: [{ address: c.host, port: c.port, users: [{ id: uuid, encryption: 'none', flow: p.get('flow') ?? '' }] }],
      },
      streamSettings: streamSettings(
        p.get('type') ?? 'tcp',
        security,
        p.get('path') ?? '/',
        p.get('host') ?? '',
        p.get('sni') ?? '',
        c.host,
      ),
    };
  } catch { return null; }
}

function vmessOutbound(c: ParsedConfig): Record<string, unknown> | null {
  try {
    const payload = c.raw.slice('vmess://'.length).replace(/#.*/, '');
    const j = JSON.parse(b64(payload));
    const security = j.tls === 'tls' ? 'tls' : 'none';
    return {
      protocol: 'vmess',
      settings: {
        vnext: [{
          address: c.host,
          port: c.port,
          users: [{ id: j.id, alterId: Number(j.aid ?? 0), security: 'auto' }],
        }],
      },
      streamSettings: streamSettings(
        j.net ?? 'tcp',
        security,
        j.path ?? '/',
        j.host ?? '',
        j.sni ?? '',
        c.host,
      ),
    };
  } catch { return null; }
}

function trojanOutbound(c: ParsedConfig): Record<string, unknown> | null {
  try {
    const body = c.raw.slice('trojan://'.length);
    const atIdx = body.indexOf('@');
    if (atIdx < 0) return null;
    const password = decodeURIComponent(body.slice(0, atIdx));
    const p = qs(c.raw);
    const network = p.get('type') ?? 'tcp';
    const sni = p.get('sni') ?? p.get('peer') ?? '';

    const ss = streamSettings(network, 'tls', p.get('path') ?? '/', p.get('host') ?? '', sni, c.host);
    // Trojan always TLS — ensure it's set even if security param missing
    if (!ss['tlsSettings']) {
      ss['security'] = 'tls';
      ss['tlsSettings'] = { serverName: sni || c.host, allowInsecure: true, fingerprint: 'chrome' };
    }

    return {
      protocol: 'trojan',
      settings: { servers: [{ address: c.host, port: c.port, password }] },
      streamSettings: ss,
    };
  } catch { return null; }
}

function ssOutbound(c: ParsedConfig): Record<string, unknown> | null {
  try {
    const body = c.raw.slice('ss://'.length);
    const main = body.split('#')[0]!;
    const atIdx = main.indexOf('@');
    let method: string;
    let password: string;

    if (atIdx >= 0) {
      let creds = main.slice(0, atIdx);
      try { const d = b64(creds); if (d.includes(':')) creds = d; } catch { /* plain text */ }
      const ci = creds.indexOf(':');
      if (ci < 0) return null;
      method = creds.slice(0, ci);
      password = creds.slice(ci + 1);
    } else {
      const decoded = b64(main);
      const at2 = decoded.lastIndexOf('@');
      if (at2 < 0) return null;
      const ci = decoded.slice(0, at2).indexOf(':');
      if (ci < 0) return null;
      method = decoded.slice(0, ci);
      password = decoded.slice(ci + 1, at2);
    }

    return {
      protocol: 'shadowsocks',
      settings: { servers: [{ address: c.host, port: c.port, method, password }] },
    };
  } catch { return null; }
}

function buildOutbound(c: ParsedConfig): Record<string, unknown> | null {
  switch (c.protocol) {
    case 'vless':   return vlessOutbound(c);
    case 'vmess':   return vmessOutbound(c);
    case 'trojan':  return trojanOutbound(c);
    case 'ss':      return ssOutbound(c);
    default:        return null;
  }
}

// ---------------------------------------------------------------------------
// Xray config wrapper
// ---------------------------------------------------------------------------

function makeXrayConfig(outbound: Record<string, unknown>, socksPort: number): object {
  return {
    log: { loglevel: 'none' },
    inbounds: [{
      listen: '127.0.0.1',
      port: socksPort,
      protocol: 'socks',
      tag: 'socks-in',
      settings: { auth: 'noauth', udp: false },
    }],
    outbounds: [{ ...outbound, tag: 'proxy' }, { protocol: 'freedom', tag: 'direct' }],
  };
}

// ---------------------------------------------------------------------------
// Public probe function
// ---------------------------------------------------------------------------

/**
 * Validate a config by actually routing an HTTP request through it via xray.
 * Returns `alive: true` only if the request succeeds end-to-end.
 */
export async function xrayProbe(
  c: ParsedConfig,
  xrayBin: string,
  timeoutMs = 8_000,
): Promise<ProbeResult> {
  const start = Date.now();

  const outbound = buildOutbound(c);
  if (!outbound) {
    // REALITY, WireGuard, or unknown protocol — cannot probe, not a failure.
    return { alive: false, latencyMs: 0, skipped: true, error: 'unsupported-or-skipped' };
  }

  let socksPort: number;
  try {
    socksPort = await getFreePort();
  } catch {
    return { alive: false, latencyMs: 0, error: 'no-free-port' };
  }

  const configPath = path.join(os.tmpdir(), `xray-${socksPort}.json`);
  let proc: child_process.ChildProcess | null = null;

  try {
    fs.writeFileSync(configPath, JSON.stringify(makeXrayConfig(outbound, socksPort)));

    proc = child_process.spawn(xrayBin, ['run', '-config', configPath], {
      stdio: 'ignore',
      detached: false,
    });

    proc.on('error', () => { /* handled below via waitForSocksPort */ });

    // Wait up to 2.5s for xray to open the SOCKS port
    const ready = await waitForSocksPort(socksPort, 2_500);
    if (!ready) {
      return { alive: false, latencyMs: Date.now() - start, error: 'xray-not-ready' };
    }

    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      return { alive: false, latencyMs: timeoutMs, error: 'no-time-left' };
    }

    const agent = new SocksProxyAgent(`socks5://127.0.0.1:${socksPort}`);

    // Try test URLs in order; first success wins.
    for (const url of TEST_URLS) {
      try {
        const resp = await axios.get(url, {
          httpAgent: agent,
          httpsAgent: agent,
          timeout: Math.min(remaining, 5_000),
          validateStatus: () => true,
          maxRedirects: 2,
        });
        if (resp.status >= 200 && resp.status < 500) {
          return { alive: true, latencyMs: Date.now() - start };
        }
      } catch {
        // Try next URL
      }
    }

    return { alive: false, latencyMs: Date.now() - start, error: 'all-test-urls-failed' };
  } catch (err) {
    return {
      alive: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (proc) {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  }
}
