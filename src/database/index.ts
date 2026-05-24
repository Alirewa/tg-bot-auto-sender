import * as fs from 'fs';
import * as path from 'path';
import Database, { Database as DB } from 'better-sqlite3';
import config from '../utils/config';
import logger from '../utils/logger';
import { runMigrations } from './migrations';

let db: DB | null = null;

export function getDb(): DB {
  if (db) return db;

  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  logger.info('SQLite database opened', { path: config.dbPath });
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite database closed');
  }
}
