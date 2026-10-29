import { loadConfig } from "../config.js";
import { CatalogService } from "../exness/catalog.js";
import { ExnessApiError, ExnessClient } from "../exness/client.js";
import { loadIdentity, SigningError } from "../exness/signing.js";
import { boolFlag, type ParsedArgs } from "./args.js";
import { style } from "./render.js";

export function createContext(parsed: ParsedArgs) {
  const verbose = boolFlag(parsed, "verbose");
  const config = loadConfig({ verbose });
  const identity = loadIdentity(config.apiKey, config.privateKey);
  const client = new ExnessClient({
    identity,
    accountId: config.accountId,
    discoveryUrl: config.discoveryUrl,
    accessPoint: config.accessPoint,
    cacheDir: config.cacheDir,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    verbose,
  });
  const catalog = new CatalogService(client, config.cacheDir, config.accountId);

  return {
    config,
    identity,
    client,
    catalog,
    verbose,
  };
}

export function describeError(error: unknown): string[] {
  if (error instanceof ExnessApiError) {
    const lines = [`${error.label} ${error.message}`];
    if (error.hint) lines.push(style.dim(error.hint));
    return lines;
  }
  if (error instanceof SigningError) {
    return [error.message];
  }
  if (error instanceof Error) {
    const lines = [error.message];
    if (error.name === "TypeError" && /fetch failed/i.test(error.message)) {
      lines.push(style.dim("Network error: check the discovery URL and your connection."));
    }
    return lines;
  }
  return [String(error)];
}

export function reportError(error: unknown, verbose = false): void {
  const [first, ...rest] = describeError(error);
  process.stderr.write(`${style.red("✖")} ${first}\n`);
  for (const line of rest) process.stderr.write(`  ${line}\n`);
  if (verbose && error instanceof Error && error.stack) {
    process.stderr.write(`${style.dim(error.stack)}\n`);
  }
}
