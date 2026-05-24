import { getDb } from './index';
import { ConfigRow, ConfigStatus, ParsedConfig, ValidatedConfig } from '../types';

function todayKey(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `posted_${y}${m}${day}`;
}

// ----------------------- configs -----------------------

export const ConfigRepo = {
  exists(hash: string): boolean {
    const db = getDb();
    const row = db.prepare('SELECT 1 FROM configs WHERE hash = ?').get(hash);
    return !!row;
  },

  insertValidated(c: ValidatedConfig): void {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO configs
        (hash, raw, protocol, host, port, country, latency_ms, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(c.hash, c.raw, c.protocol, c.host, c.port, c.country, c.latencyMs, Date.now());
  },

  insertFailed(c: ParsedConfig, reason: string): void {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO configs
        (hash, raw, protocol, host, port, country, latency_ms, status, created_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, 'failed', ?)`,
    ).run(c.hash, c.raw, c.protocol, c.host, c.port, Date.now());
    void reason;
  },

  markPosted(hash: string): void {
    const db = getDb();
    db.prepare(
      `UPDATE configs SET status = 'posted', posted_at = ? WHERE hash = ?`,
    ).run(Date.now(), hash);
  },

  markDead(hash: string): void {
    const db = getDb();
    db.prepare(`UPDATE configs SET status = 'dead' WHERE hash = ?`).run(hash);
  },

  loadQueued(): ConfigRow[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT * FROM configs WHERE status = 'queued' ORDER BY latency_ms ASC, created_at ASC`,
      )
      .all() as ConfigRow[];
  },

  countByStatus(status: ConfigStatus): number {
    const db = getDb();
    const row = db
      .prepare('SELECT COUNT(*) as c FROM configs WHERE status = ?')
      .get(status) as { c: number };
    return row.c;
  },

  deleteOldDead(olderThanMs: number): number {
    const db = getDb();
    const cutoff = Date.now() - olderThanMs;
    const res = db
      .prepare(`DELETE FROM configs WHERE status = 'dead' AND created_at < ?`)
      .run(cutoff);
    return res.changes;
  },
};

// ----------------------- stats -----------------------

export const StatsRepo = {
  increment(key: string, delta = 1): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO stats(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
    ).run(key, delta);
  },

  get(key: string): number {
    const db = getDb();
    const row = db.prepare('SELECT value FROM stats WHERE key = ?').get(key) as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  },

  incrementPostedToday(): void {
    this.increment('total_posted', 1);
    this.increment(todayKey(), 1);
  },

  getPostedToday(): number {
    return this.get(todayKey());
  },
};

// ----------------------- logs -----------------------

export const LogRepo = {
  insert(level: string, message: string, meta?: Record<string, unknown>): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO logs(level, message, meta, created_at) VALUES(?, ?, ?, ?)`,
    ).run(level, message, meta ? JSON.stringify(meta) : null, Date.now());
  },

  trim(keepLast: number): void {
    const db = getDb();
    db.prepare(
      `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)`,
    ).run(keepLast);
  },
};

// ----------------------- settings -----------------------

export const SettingsRepo = {
  getString(key: string, fallback = ''): string {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? fallback;
  },

  setString(key: string, value: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  },

  getBool(key: string, fallback = false): boolean {
    const v = this.getString(key, fallback ? '1' : '0');
    return v === '1' || v.toLowerCase() === 'true';
  },

  setBool(key: string, value: boolean): void {
    this.setString(key, value ? '1' : '0');
  },

  getInt(key: string, fallback = 0): number {
    const v = this.getString(key, String(fallback));
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  },

  setInt(key: string, value: number): void {
    this.setString(key, String(value));
  },

  // Atomic increment & return new value (uses a single SQL statement under transaction).
  incrementInt(key: string, delta = 1): number {
    const db = getDb();
    const trx = db.transaction((k: string, d: number): number => {
      const cur = this.getInt(k, 0);
      const next = cur + d;
      this.setInt(k, next);
      return next;
    });
    return trx(key, delta);
  },
};

// ----------------------- subscription links -----------------------

export interface SubLink {
  id: number;
  url: string;
  enabled: number;
  created_at: number;
}

export const SubsRepo = {
  add(url: string): void {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO sub_links(url, enabled, created_at) VALUES(?, 1, ?)`,
    ).run(url, Date.now());
  },

  remove(id: number): boolean {
    const db = getDb();
    const r = db.prepare('DELETE FROM sub_links WHERE id = ?').run(id);
    return r.changes > 0;
  },

  list(): SubLink[] {
    const db = getDb();
    return db
      .prepare('SELECT id, url, enabled, created_at FROM sub_links ORDER BY id ASC')
      .all() as SubLink[];
  },

  listEnabled(): SubLink[] {
    const db = getDb();
    return db
      .prepare(
        'SELECT id, url, enabled, created_at FROM sub_links WHERE enabled = 1 ORDER BY id ASC',
      )
      .all() as SubLink[];
  },

  toggle(id: number, enabled: boolean): boolean {
    const db = getDb();
    const r = db
      .prepare('UPDATE sub_links SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id);
    return r.changes > 0;
  },
};
