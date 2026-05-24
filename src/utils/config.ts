import * as dotenv from 'dotenv';
import * as path from 'path';
import { autoTune } from './system';

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

/** Returns the parsed integer only if the env var is explicitly set, otherwise undefined. */
function optionalInt(name: string): number | undefined {
  const v = process.env[name];
  if (!v || v.trim() === '') return undefined;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

export interface AppConfig {
  botToken: string;
  adminUserId: number;
  publishChannel: string;
  publishChannelHandle: string;
  tcpTimeoutMs: number;
  validationConcurrency: number;
  maxConfigsPerCycle: number;
  publishCron: string;
  scrapeCron: string;
  dbPath: string;
  logLevel: string;
  // Subscription file generation
  subsDir: string;
  // GitHub auto-publisher (null = feature disabled)
  githubToken: string | null;
  githubRepo: string | null;
  githubBranch: string;
  subDir: string;
  githubPushIntervalMs: number;
}

const publishChannel = required('PUBLISH_CHANNEL');

// Auto-tune from hardware; explicit .env values always override.
const tuned = autoTune({
  validationConcurrency: optionalInt('VALIDATION_CONCURRENCY'),
  maxConfigsPerCycle: optionalInt('MAX_CONFIGS_PER_CYCLE'),
  tcpTimeoutMs: optionalInt('TCP_TIMEOUT_MS'),
});

const config: AppConfig = {
  botToken: required('BOT_TOKEN'),
  adminUserId: asInt('ADMIN_USER_ID', required('ADMIN_USER_ID')),
  publishChannel,
  publishChannelHandle: publishChannel,
  // Hardware-aware defaults (overridable via .env)
  tcpTimeoutMs: tuned.tcpTimeoutMs,
  validationConcurrency: tuned.validationConcurrency,
  maxConfigsPerCycle: tuned.maxConfigsPerCycle,
  publishCron: optional('PUBLISH_CRON', '* * * * *'),
  scrapeCron: optional('SCRAPE_CRON', '*/10 * * * *'),
  dbPath: path.resolve(optional('DB_PATH', './data/bot.sqlite')),
  logLevel: optional('LOG_LEVEL', 'info'),
  // Subscription files
  subsDir: path.resolve(optional('SUBS_DIR', './subs')),
  // GitHub (optional feature)
  githubToken: process.env['GITHUB_TOKEN']?.trim() || null,
  githubRepo: process.env['GITHUB_REPO']?.trim() || null,
  githubBranch: optional('GITHUB_BRANCH', 'main'),
  subDir: optional('SUB_DIR', 'subs'),
  githubPushIntervalMs: asInt(
    'GITHUB_PUSH_INTERVAL_MS',
    optional('GITHUB_PUSH_INTERVAL_MS', '300000'),
  ),
};

export default config;
