import * as net from 'net';
import { ProbeResult } from '../types';

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const start = Date.now();
    let settled = false;
    const sock = new net.Socket();

    const done = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    sock.setTimeout(timeoutMs);

    sock.once('connect', () => {
      done({ alive: true, latencyMs: Date.now() - start });
    });
    sock.once('timeout', () => {
      done({ alive: false, latencyMs: timeoutMs, error: 'timeout' });
    });
    sock.once('error', (err) => {
      done({ alive: false, latencyMs: Date.now() - start, error: err.message });
    });

    try {
      sock.connect(port, host);
    } catch (err) {
      done({
        alive: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
