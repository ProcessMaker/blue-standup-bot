export const DEFAULT_NOTIFY_TIME_UTC = "15:00";
export const DEFAULT_MESSAGE =
  "Reminder: please post your standup update in your standup channel.";

export function getEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getSqlConnectionString(): string {
  return requireEnv("SQL_CONNECTION_STRING");
}

export function getBotCredentials(): {
  appId: string;
  appPassword: string;
  /** Publisher / home tenant for SingleTenant Bot Framework auth. */
  tenantId: string;
} {
  return {
    appId: requireEnv("MicrosoftAppId"),
    appPassword: requireEnv("MicrosoftAppPassword"),
    tenantId: getEnv("MicrosoftAppTenantId"),
  };
}

/** Format a SQL TIME / Date / "HH:MM:SS" value as HH:MM. */
export function formatTimeUtc(value: string | Date): string {
  if (value instanceof Date) {
    const h = value.getUTCHours().toString().padStart(2, "0");
    const m = value.getUTCMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  }
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) {
    return value;
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/** Parse user input HH:MM into SQL TIME string HH:MM:00. */
export function parseTimeUtc(input: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:00`;
}

export function isWeekdayUtc(date = new Date()): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

export function currentUtcHhMm(date = new Date()): string {
  const h = date.getUTCHours().toString().padStart(2, "0");
  const m = date.getUTCMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}
