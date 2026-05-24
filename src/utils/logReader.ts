import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Reads the last `n` structured log entries from combined.log.
 * Reads the tail of the file (max 80 KB) to avoid loading huge files.
 * Returns entries in chronological order (oldest first).
 */
export function readRecentLogs(n = 20): LogEntry[] {
  const logFile = path.resolve('./logs/combined.log');

  try {
    if (!fs.existsSync(logFile)) return [];
    const stat = fs.statSync(logFile);
    if (stat.size === 0) return [];

    const bytesToRead = Math.min(stat.size, 80 * 1024);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(logFile, 'r');
    fs.readSync(fd, buf, 0, bytesToRead, stat.size - bytesToRead);
    fs.closeSync(fd);

    const entries: LogEntry[] = [];
    for (const raw of buf.toString('utf-8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as LogEntry);
      } catch {
        /* skip malformed / partial first line from tail-read */
      }
    }

    return entries.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Same as readRecentLogs but filters to entries whose message contains `keyword`.
 */
export function readLogsFiltered(keyword: string, n = 20): LogEntry[] {
  const logFile = path.resolve('./logs/combined.log');

  try {
    if (!fs.existsSync(logFile)) return [];
    const stat = fs.statSync(logFile);
    if (stat.size === 0) return [];

    // Read more when filtering so we still get n results after the filter.
    const bytesToRead = Math.min(stat.size, 200 * 1024);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(logFile, 'r');
    fs.readSync(fd, buf, 0, bytesToRead, stat.size - bytesToRead);
    fs.closeSync(fd);

    const entries: LogEntry[] = [];
    for (const raw of buf.toString('utf-8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line) as LogEntry;
        if (e.message.includes(keyword)) entries.push(e);
      } catch {
        /* skip */
      }
    }

    return entries.slice(-n);
  } catch {
    return [];
  }
}
