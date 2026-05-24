import { Database as DB } from 'better-sqlite3';

export const DEFAULT_TEMPLATE = '{flag} - #{n} {channel}';

// Default seed sources (added on first boot only). Admin can edit via /addsub /delsub later.
const DEFAULT_SOURCES = [
  'https://raw.githubusercontent.com/4n0nymou3/multi-proxy-config-fetcher/refs/heads/main/configs/proxy_configs.txt',
  'https://raw.githubusercontent.com/hiddify/hiddify-app/refs/heads/main/test.configs/mahsa',
];

export function runMigrations(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS configs (
      hash       TEXT PRIMARY KEY,
      raw        TEXT NOT NULL,
      protocol   TEXT NOT NULL,
      host       TEXT NOT NULL,
      port       INTEGER NOT NULL,
      country    TEXT,
      latency_ms INTEGER,
      status     TEXT NOT NULL CHECK(status IN ('queued','posted','failed','dead')),
      created_at INTEGER NOT NULL,
      posted_at  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_configs_status ON configs(status);
    CREATE INDEX IF NOT EXISTS idx_configs_posted_at ON configs(posted_at);

    CREATE TABLE IF NOT EXISTS stats (
      key   TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      level      TEXT NOT NULL,
      message    TEXT NOT NULL,
      meta       TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sub_links (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      url        TEXT NOT NULL UNIQUE,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);

  // Seed defaults
  const seed = db.prepare(
    `INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)`,
  );
  seed.run('auto_send', '1');
  seed.run('template', DEFAULT_TEMPLATE);
  seed.run('post_counter', '0');

  const subCount = (
    db.prepare('SELECT COUNT(*) AS c FROM sub_links').get() as { c: number }
  ).c;
  if (subCount === 0) {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO sub_links(url, enabled, created_at) VALUES(?, 1, ?)`,
    );
    const now = Date.now();
    for (const u of DEFAULT_SOURCES) ins.run(u, now);
  }
}
