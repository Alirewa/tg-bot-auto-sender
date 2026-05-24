import { ValidatedConfig } from '../types';

export interface SubFiles {
  /** All healthy configs — base64(uri1\nuri2\n…) — standard V2Ray/Clash sub format. */
  main: string;
  /** Plain-text list, one URI per line. */
  healthy: string;
  /** VLESS-only (includes REALITY transport, which is carried over vless://). */
  vless: string;
  /** VMess-only. */
  vmess: string;
  /** Trojan-only. */
  trojan: string;
  /** Shadowsocks-only. */
  ss: string;
  /** WireGuard-only. */
  wireguard: string;
}

/**
 * Pure transformation — no I/O.
 * Takes the validated alive configs and builds the content for each sub file.
 */
export function generateSubFiles(configs: ValidatedConfig[]): SubFiles {
  const byProtocol = (proto: ValidatedConfig['protocol']): string =>
    configs
      .filter((c) => c.protocol === proto)
      .map((c) => c.raw)
      .join('\n');

  const healthy = configs.map((c) => c.raw).join('\n');
  const main = Buffer.from(healthy, 'utf-8').toString('base64');

  return {
    main,
    healthy,
    vless: byProtocol('vless'),
    vmess: byProtocol('vmess'),
    trojan: byProtocol('trojan'),
    ss: byProtocol('ss'),
    wireguard: byProtocol('wireguard'),
  };
}
