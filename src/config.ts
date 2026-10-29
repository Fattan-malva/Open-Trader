import fs from "node:fs";
import path from "node:path";

/**
 * Loads .env from the project root without pulling in a dependency.
 * Walks up from the current working directory so the CLI also works from a subfolder.
 */
export function loadEnvFile(startDir: string = process.cwd(), maxDepth = 5): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i <= maxDepth; i += 1) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
        return candidate;
      } catch {
        // Fall back to a minimal parser for older runtimes / unusual encodings.
        applyManualEnv(fs.readFileSync(candidate, "utf8"));
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function applyManualEnv(contents: string): void {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export interface AppConfig {
  apiKey: string;
  privateKey: string;
  accountId: string;
  discoveryUrl: string;
  accessPoint?: string;
  cacheDir: string;
  envFile: string | null;
  timeoutMs: number;
  maxRetries: number;
  verbose: boolean;
}

const DEFAULT_DISCOVERY_URL = "https://api.exness.com";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Environment variable ${name} is missing. Copy .env.example to .env and fill in your Exness credentials.`,
    );
  }
  return value;
}

export interface LoadConfigOptions {
  verbose?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const envFile = loadEnvFile();

  const apiKey = required("EXNESS_API_KEY");
  const accountId = required("EXNESS_ACCOUNT_ID");

  // EXNESS_API_SECRET is the name used by the original .env; keep it as a fallback.
  const privateKey =
    process.env.EXNESS_PRIVATE_KEY?.trim() || process.env.EXNESS_API_SECRET?.trim() || "";
  if (!privateKey) {
    throw new Error(
      "EXNESS_PRIVATE_KEY (or EXNESS_API_SECRET) is missing. See .env.example for the accepted formats.",
    );
  }

  const timeoutMs = Number(process.env.EXNESS_TIMEOUT_MS ?? 20_000);
  const maxRetries = Number(process.env.EXNESS_MAX_RETRIES ?? 2);

  return {
    apiKey,
    privateKey,
    accountId,
    discoveryUrl: (process.env.EXNESS_DISCOVERY_URL?.trim() || DEFAULT_DISCOVERY_URL).replace(
      /\/+$/,
      "",
    ),
    accessPoint: process.env.EXNESS_ACCESS_POINT?.trim() || undefined,
    cacheDir: path.join(process.cwd(), ".cache"),
    envFile,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 20_000,
    maxRetries: Number.isFinite(maxRetries) ? maxRetries : 2,
    verbose: options.verbose ?? false,
  };
}
