import { loadEnvFile } from "node:process";
import type { Region } from "./types.js";

try {
  loadEnvFile();
} catch (error) {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined;
  if (code !== "ENOENT") {
    throw error;
  }
}

const REGIONS = new Set<Region>(["ap", "br", "eu", "kr", "latam", "na"]);

export interface AppConfig {
  discordWebhookUrl: string;
  henrikDevApiKey: string;
  leaderboardTimezone: string;
  tursoDatabaseUrl: string;
  tursoAuthToken: string;
}

export function loadConfig(): AppConfig {
  const discordWebhookUrl = mustGetEnv("DISCORD_WEBHOOK_URL");
  const henrikDevApiKey = mustGetEnv("HENRIKDEV_API_KEY");
  const leaderboardTimezone = process.env.LEADERBOARD_TIMEZONE ?? "UTC";
  const tursoDatabaseUrl = mustGetEnv("TURSO_DATABASE_URL");
  // Une base locale "file:" (tests, workflow de test Discord) n'a pas besoin de token Turso.
  const tursoAuthToken = tursoDatabaseUrl.startsWith("file:")
    ? process.env.TURSO_AUTH_TOKEN ?? ""
    : mustGetEnv("TURSO_AUTH_TOKEN");

  return {
    discordWebhookUrl,
    henrikDevApiKey,
    leaderboardTimezone,
    tursoDatabaseUrl,
    tursoAuthToken
  };
}

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function parseRegion(input: string): Region {
  const normalized = input.toLowerCase() as Region;
  if (!REGIONS.has(normalized)) {
    throw new Error(`Invalid region "${input}". Expected one of: ${Array.from(REGIONS).join(", ")}`);
  }

  return normalized;
}
