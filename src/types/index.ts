export type Protocol = 'vmess' | 'vless' | 'trojan' | 'ss';

export interface ParsedConfig {
  hash: string;
  raw: string;
  protocol: Protocol;
  host: string;
  port: number;
}

export interface ValidatedConfig extends ParsedConfig {
  latencyMs: number;
  country: string;
  flag: string;
}

export type ConfigStatus = 'queued' | 'posted' | 'failed' | 'dead';

export interface ConfigRow {
  hash: string;
  raw: string;
  protocol: Protocol;
  host: string;
  port: number;
  country: string | null;
  latency_ms: number | null;
  status: ConfigStatus;
  created_at: number;
  posted_at: number | null;
}

export interface ProbeResult {
  alive: boolean;
  latencyMs: number;
  error?: string;
}

export interface GeoResult {
  countryCode: string;
  flag: string;
}

export interface StatsSnapshot {
  totalPosted: number;
  totalValidated: number;
  totalFailed: number;
  postedToday: number;
  queueSize: number;
  uptimeSeconds: number;
}
