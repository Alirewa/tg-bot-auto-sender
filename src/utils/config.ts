import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function asInt(name: string, value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Env ${name} must be an integer, got: ${value}`);
  }
  return n;
}

export interface AppConfig {
  botToken: string;
  adminUserId: number;
  publishChannel: string;
  publishChannelHandle: string; // @webdw style, used in template {channel}
  tcpTimeoutMs: number;
  validationConcurrency: number;
  publishCron: string;
  scrapeCron: string;
  dbPath: string;
  logLevel: string;
}

const publishChannel = required('PUBLISH_CHANNEL');
const publishChannelHandle = publishChannel.startsWith('@')
  ? publishChannel
  : publishChannel; // keep as-is for numeric IDs

const config: AppConfig = {
  botToken: required('BOT_TOKEN'),
  adminUserId: asInt('ADMIN_USER_ID', required('ADMIN_USER_ID')),
  publishChannel,
  publishChannelHandle,
  tcpTimeoutMs: asInt('TCP_TIMEOUT_MS', optional('TCP_TIMEOUT_MS', '5000')),
  validationConcurrency: asInt(
    'VALIDATION_CONCURRENCY',
    optional('VALIDATION_CONCURRENCY', '20'),
  ),
  publishCron: optional('PUBLISH_CRON', '* * * * *'),
  scrapeCron: optional('SCRAPE_CRON', '*/10 * * * *'),
  dbPath: path.resolve(optional('DB_PATH', './data/bot.sqlite')),
  logLevel: optional('LOG_LEVEL', 'info'),
};

export default config;
