export type IntegrityConfig = {
  enabled: boolean;
  intervalHours: number;
};

const DEFAULT_INTERVAL_HOURS = 168;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 31;

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name}_invalid`);
}

function parseBoundedInteger(name: string, value: string | undefined, defaultValue: number) {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) throw new Error(`${name}_invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_INTERVAL_HOURS || parsed > MAX_INTERVAL_HOURS) {
    throw new Error(`${name}_invalid`);
  }
  return parsed;
}

export function readIntegrityConfig(input: {
  INTEGRITY_CHECKS_ENABLED?: string;
  INTEGRITY_CHECK_INTERVAL_HOURS?: string;
}): IntegrityConfig {
  return {
    enabled: parseBoolean("INTEGRITY_CHECKS_ENABLED", input.INTEGRITY_CHECKS_ENABLED, false),
    intervalHours: parseBoundedInteger(
      "INTEGRITY_CHECK_INTERVAL_HOURS",
      input.INTEGRITY_CHECK_INTERVAL_HOURS,
      DEFAULT_INTERVAL_HOURS
    )
  };
}
