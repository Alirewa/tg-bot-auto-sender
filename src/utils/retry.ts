import logger from './logger';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  label?: string;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  const factor = opts.factor ?? 2;
  const label = opts.label ?? 'retry';

  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`${label} attempt ${i}/${attempts} failed`, { error: message });
      if (i === attempts) break;
      const delay = Math.min(max, base * factor ** (i - 1));
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
