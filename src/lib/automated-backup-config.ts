const DEFAULT_DIRECTORY = "/var/lib/cubby/backups";
const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_RETENTION_COUNT = 30;
const DEFAULT_POLL_MINUTES = 15;
const DEFAULT_RETRY_MINUTES = 60;

export type AutomatedBackupConfig = {
  enabled: boolean;
  directory: string;
  intervalHours: number;
  retentionCount: number;
  pollMinutes: number;
  retryMinutes: number;
};

type EnvSource = Partial<Record<
  | "AUTOMATED_BACKUPS_ENABLED"
  | "AUTOMATED_BACKUP_DIRECTORY"
  | "AUTOMATED_BACKUP_INTERVAL_HOURS"
  | "AUTOMATED_BACKUP_RETENTION_COUNT"
  | "AUTOMATED_BACKUP_POLL_MINUTES"
  | "AUTOMATED_BACKUP_RETRY_MINUTES",
  string | undefined
>>;

function readBoolean(name: keyof EnvSource, value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly "true" or "false"`);
}

function readBoundedInteger(
  name: keyof EnvSource,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function readDirectory(value: string | undefined) {
  if (value === undefined) return DEFAULT_DIRECTORY;
  const trimmed = value.trim();
  if (!trimmed) throw new Error("AUTOMATED_BACKUP_DIRECTORY must not be blank");
  if (trimmed === "/" || /^[A-Za-z]:\\?$/.test(trimmed)) {
    throw new Error("AUTOMATED_BACKUP_DIRECTORY must not be a filesystem root");
  }
  if (trimmed.includes("..")) {
    throw new Error("AUTOMATED_BACKUP_DIRECTORY must not contain relative traversal");
  }
  return trimmed;
}

export function readAutomatedBackupConfig(source: EnvSource): AutomatedBackupConfig {
  return {
    enabled: readBoolean("AUTOMATED_BACKUPS_ENABLED", source.AUTOMATED_BACKUPS_ENABLED, false),
    directory: readDirectory(source.AUTOMATED_BACKUP_DIRECTORY),
    intervalHours: readBoundedInteger("AUTOMATED_BACKUP_INTERVAL_HOURS", source.AUTOMATED_BACKUP_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS, 1, 168),
    retentionCount: readBoundedInteger("AUTOMATED_BACKUP_RETENTION_COUNT", source.AUTOMATED_BACKUP_RETENTION_COUNT, DEFAULT_RETENTION_COUNT, 1, 365),
    pollMinutes: readBoundedInteger("AUTOMATED_BACKUP_POLL_MINUTES", source.AUTOMATED_BACKUP_POLL_MINUTES, DEFAULT_POLL_MINUTES, 1, 1440),
    retryMinutes: readBoundedInteger("AUTOMATED_BACKUP_RETRY_MINUTES", source.AUTOMATED_BACKUP_RETRY_MINUTES, DEFAULT_RETRY_MINUTES, 1, 1440)
  };
}

export function automatedBackupStatusConfig(config: AutomatedBackupConfig) {
  return {
    enabled: config.enabled,
    intervalHours: config.intervalHours,
    retentionCount: config.retentionCount,
    pollMinutes: config.pollMinutes,
    retryMinutes: config.retryMinutes
  };
}
