import * as os from 'os';

// Note: deliberately does NOT import logger to avoid a circular dependency.
// (logger → config → system → logger). Boot-time output goes to console directly.

export interface TunedValues {
  validationConcurrency: number;
  maxConfigsPerCycle: number;
  tcpTimeoutMs: number;
}

/**
 * Detects CPU count and total RAM, then returns optimal tuning values.
 * Any values supplied in `explicit` override the auto-detected defaults —
 * so users who set these in .env always get their exact values.
 */
export function autoTune(explicit: Partial<TunedValues>): TunedValues {
  const cpus = os.cpus().length;
  const ramGb = os.totalmem() / (1024 ** 3);

  let defaults: TunedValues;

  if (cpus >= 8 && ramGb > 8) {
    defaults = { validationConcurrency: 1000, maxConfigsPerCycle: 5000, tcpTimeoutMs: 2500 };
  } else if (cpus >= 4 && ramGb > 4) {
    defaults = { validationConcurrency: 600, maxConfigsPerCycle: 2500, tcpTimeoutMs: 2500 };
  } else if (cpus >= 2 && ramGb > 2) {
    defaults = { validationConcurrency: 300, maxConfigsPerCycle: 1200, tcpTimeoutMs: 2500 };
  } else {
    defaults = { validationConcurrency: 100, maxConfigsPerCycle: 400, tcpTimeoutMs: 3000 };
  }

  const result: TunedValues = {
    validationConcurrency: explicit.validationConcurrency ?? defaults.validationConcurrency,
    maxConfigsPerCycle: explicit.maxConfigsPerCycle ?? defaults.maxConfigsPerCycle,
    tcpTimeoutMs: explicit.tcpTimeoutMs ?? defaults.tcpTimeoutMs,
  };

  // Use console at boot time — logger isn't ready yet (it imports config which imports us).
  console.info(
    '[system] auto-tune:',
    JSON.stringify({
      cpus,
      ramGb: +ramGb.toFixed(1),
      result,
    }),
  );

  return result;
}
