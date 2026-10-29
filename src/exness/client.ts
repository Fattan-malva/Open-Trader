import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildSignedHeaders,
  type SigningIdentity,
} from "./signing.js";
import type {
  AccessPointResponse,
  ErrorResponse,
} from "./types.js";

export class ExnessApiError extends Error {
  override name = "ExnessApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly hint?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** Stable machine-readable form, e.g. `401/1001`. */
  get label(): string {
    return `${this.status}${this.code !== undefined ? `/${this.code}` : ""}`;
  }
}

const AUTH_HINTS: Record<number, string> = {
  1000: "Check EXN-API-KEY, key expiry and that EXN-DATA.api_key matches the header.",
  1001:
    "Signature rejected. Check private key format, EXN-DATA payload bytes, body_hash and base64url padding.",
  1002: "API key has no access to this account, IP or scope.",
};

const STATUS_HINTS: Record<number, string> = {
  400: "Request shape is invalid (query parameters, time range, count).",
  403: "The API key cannot access this account.",
  404: "Account or resource not found for this API key.",
  429: "Rate limited. Slow down or raise the client limit.",
  500: "Server error. Retry later.",
  503: "Service temporarily unavailable. Retry later.",
};

export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Required (non-empty) for mutating requests; ignored for GET. */
  idempotencyKey?: string;
  /** Overrides the per-route rate limiter. */
  skipRateLimit?: boolean;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface AccessPointInfo {
  accessPoint: string;
  source: "pin" | "cache" | "discovery";
  fetchedAt: number;
}

export interface ExnessClientOptions {
  identity: SigningIdentity;
  accountId: string;
  discoveryUrl: string;
  accessPoint?: string;
  cacheDir: string;
  timeoutMs?: number;
  maxRetries?: number;
  verbose?: boolean;
}

interface RouterLimit {
  match: RegExp;
  limit: number;
  windowMs: number;
}

/** Defaults observed for this account via /v1/configuration/.../limits. */
const ROUTE_LIMITS: RouterLimit[] = [
  // The broker token bucket is stricter than a plain 2-per-second window:
  // pace candles wider so a scan never trips 429 and pays retry latency.
  { match: /^\/v1\/market-data\/.*\/candles$/, limit: 2, windowMs: 1300 },
  { match: /^\/v1\/trading\/.*\/snapshot$/, limit: 2, windowMs: 1100 },
  { match: /^\/v1\/trading\/.*\/operations\/[^/]+$/, limit: 10, windowMs: 1000 },
  { match: /^\/v1\/trading\/.*\/(positions|orders)/, limit: 4, windowMs: 1000 },
  { match: /^\/v1\/configuration\/.*\/instruments\/[^/]+\/conditions$/, limit: 4, windowMs: 1000 },
  { match: /^\/v1\/configuration\/.*\/instruments$/, limit: 2, windowMs: 1000 },
  { match: /^\/v1\/configuration\/.*\/(account|limits)$/, limit: 2, windowMs: 1000 },
  { match: /^\/v1\/history\//, limit: 2, windowMs: 1000 },
];

const GLOBAL_LIMIT = { limit: 10, windowMs: 1000 };
const ACCESS_POINT_TTL_MS = 10 * 60 * 1000;

class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  async acquire(key: string, limit: number, windowMs: number): Promise<void> {
    const now = Date.now();
    const window = this.hits.get(key) ?? [];
    const fresh = window.filter((timestamp) => now - timestamp < windowMs);
    if (fresh.length >= limit) {
      const waitMs = windowMs - (now - fresh[0]!) + 5;
      this.hits.set(key, fresh);
      await sleep(waitMs);
      return this.acquire(key, limit, windowMs);
    }
    fresh.push(now);
    this.hits.set(key, fresh);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildPath(pathname: string, query?: Query): string {
  if (!query) return pathname;
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length === 0 ? pathname : `${pathname}?${pairs.join("&")}`;
}

export function createIdempotencyKey(prefix = "ot"): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class ExnessClient {
  readonly identity: SigningIdentity;
  readonly accountId: string;
  private readonly discoveryUrl: string;
  private readonly pinnedAccessPoint?: string;
  private readonly cacheDir: string;
  private readonly accessPointFile: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly limiter = new SlidingWindowLimiter();
  private accessPointInfo?: AccessPointInfo;
  readonly verbose: boolean;

  constructor(options: ExnessClientOptions) {
    this.identity = options.identity;
    this.accountId = options.accountId;
    this.discoveryUrl = options.discoveryUrl;
    this.pinnedAccessPoint = options.accessPoint;
    this.cacheDir = options.cacheDir;
    this.accessPointFile = path.join(options.cacheDir, "access-point.json");
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.verbose = options.verbose ?? false;
  }

  // ---------------------------------------------------------------- discovery

  async resolveAccessPoint(force = false): Promise<AccessPointInfo> {
    if (this.accessPointInfo && !force) return this.accessPointInfo;

    if (this.pinnedAccessPoint) {
      this.accessPointInfo = {
        accessPoint: this.pinnedAccessPoint.replace(/\/+$/, ""),
        source: "pin",
        fetchedAt: Date.now(),
      };
      return this.accessPointInfo;
    }

    if (!force) {
      const cached = this.readAccessPointCache();
      if (cached) {
        this.accessPointInfo = cached;
        return cached;
      }
    }

    const pathname = "/v1/trading/access-point";
    const pathWithQuery = buildPath(pathname, { account_id: this.accountId });
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.send("GET", this.discoveryUrl, pathWithQuery, "");
        if (response.status !== 200) {
          throw this.toApiError(response);
        }
        const parsed = JSON.parse(response.text) as AccessPointResponse;
        if (!parsed.access_point) {
          throw new ExnessApiError("Discovery response did not include access_point", 500);
        }
        this.accessPointInfo = {
          accessPoint: parsed.access_point.replace(/\/+$/, ""),
          source: "discovery",
          fetchedAt: Date.now(),
        };
        this.writeAccessPointCache(this.accessPointInfo);
        return this.accessPointInfo;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries && this.isRetryable(error)) {
          await sleep(this.retryDelay(error, attempt));
          continue;
        }
        break;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ExnessApiError("Access point discovery failed", 500);
  }

  private readAccessPointCache(): AccessPointInfo | null {
    try {
      const raw = fs.readFileSync(this.accessPointFile, "utf8");
      const parsed = JSON.parse(raw) as {
        accountId?: string;
        discoveryUrl?: string;
        accessPoint?: string;
        fetchedAt?: number;
      };
      if (
        parsed.accountId !== this.accountId ||
        parsed.discoveryUrl !== this.discoveryUrl ||
        !parsed.accessPoint ||
        !parsed.fetchedAt
      ) {
        return null;
      }
      if (Date.now() - parsed.fetchedAt > ACCESS_POINT_TTL_MS) return null;
      return {
        accessPoint: parsed.accessPoint.replace(/\/+$/, ""),
        source: "cache",
        fetchedAt: parsed.fetchedAt,
      };
    } catch {
      return null;
    }
  }

  private writeAccessPointCache(info: AccessPointInfo): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(
        this.accessPointFile,
        JSON.stringify(
          {
            accountId: this.accountId,
            discoveryUrl: this.discoveryUrl,
            accessPoint: info.accessPoint,
            fetchedAt: info.fetchedAt,
          },
          null,
          2,
        ),
      );
    } catch {
      // Cache is best-effort only.
    }
  }

  // ----------------------------------------------------------------- requests

  async get<T>(pathname: string, options: Omit<RequestOptions, "idempotencyKey"> = {}): Promise<T> {
    return this.request<T>("GET", pathname, options);
  }

  async post<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", pathname, options);
  }

  async patch<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", pathname, options);
  }

  async delete<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", pathname, options);
  }

  async request<T>(method: HttpMethod, pathname: string, options: RequestOptions = {}): Promise<T> {
    const pathWithQuery = buildPath(pathname, options.query);
    const bodyText =
      options.body === undefined
        ? ""
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);

    const idempotencyKey =
      method === "GET" ? "" : (options.idempotencyKey ?? createIdempotencyKey(method.toLowerCase()));

    let lastError: unknown;
    let refreshedAccessPoint = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const { accessPoint } = await this.resolveAccessPoint(refreshedAccessPoint && attempt > 0);

        if (!options.skipRateLimit) {
          // The broker enforces one global bucket per account, not one bucket
          // per route. Keep both: global first, then the stricter route limit.
          await this.limiter.acquire("global", GLOBAL_LIMIT.limit, GLOBAL_LIMIT.windowMs);
          const route = this.routeLimit(pathname);
          if (route) {
            await this.limiter.acquire(`${method} ${pathname}`, route.limit, route.windowMs);
          }
        }

        const response = await this.send(
          method,
          accessPoint,
          pathWithQuery,
          bodyText,
          idempotencyKey,
          options.timeoutMs,
        );

        if (response.status === 401 && !refreshedAccessPoint && !this.pinnedAccessPoint) {
          refreshedAccessPoint = true;
          this.accessPointInfo = undefined;
          continue;
        }

        if (response.status === 429 || response.status === 503 || response.status === 500) {
          const error = this.toApiError(response);
          if (attempt < this.maxRetries) {
            await sleep(error.retryAfterMs ?? this.retryDelay(error, attempt));
            continue;
          }
          throw error;
        }

        if (response.status < 200 || response.status >= 300) {
          throw this.toApiError(response);
        }

        return this.parseBody<T>(response, method, pathWithQuery);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries && this.isRetryable(error)) {
          await sleep(this.retryDelay(error, attempt));
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ExnessApiError("Request failed", 500);
  }

  private parseBody<T>(response: RawResponse, method: string, pathWithQuery: string): T {
    if (response.text.trim() === "") return undefined as T;
    try {
      return JSON.parse(response.text) as T;
    } catch {
      throw new ExnessApiError(
        `Expected JSON but received: ${response.text.slice(0, 200)}`,
        response.status,
        undefined,
        `${method} ${pathWithQuery}`,
      );
    }
  }

  private async send(
    method: string,
    baseUrl: string,
    pathWithQuery: string,
    body: string,
    idempotencyKey = "",
    timeoutMs = this.timeoutMs,
  ): Promise<RawResponse> {
    const headers = buildSignedHeaders({
      identity: this.identity,
      method,
      pathWithQuery,
      body,
      idempotencyKey,
    });

    if (body !== "") headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (this.verbose) {
      console.error(`→ ${method} ${baseUrl}${pathWithQuery}`);
    }

    try {
      const response = await fetch(`${baseUrl}${pathWithQuery}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" || body === "" ? undefined : body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (this.verbose) {
        console.error(`← ${response.status} ${method} ${pathWithQuery} (${text.length}b)`);
      }
      return { status: response.status, headers: response.headers, text };
    } finally {
      clearTimeout(timer);
    }
  }

  private toApiError(response: RawResponse): ExnessApiError {
    let parsed: ErrorResponse = {};
    try {
      parsed = JSON.parse(response.text) as ErrorResponse;
    } catch {
      // Non-JSON error body (gateway/proxy).
    }

    const code = typeof parsed.code === "number" ? parsed.code : undefined;
    const codeText =
      typeof parsed.error_code === "string" ? parsed.error_code : undefined;
    const message =
      parsed.error_message ??
      parsed.description ??
      codeText ??
      `HTTP ${response.status}`;

    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;

    return new ExnessApiError(
      message,
      response.status,
      code,
      (code !== undefined ? AUTH_HINTS[code] : undefined) ?? STATUS_HINTS[response.status],
      Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
    );
  }

  private routeLimit(pathname: string): RouterLimit | undefined {
    return ROUTE_LIMITS.find((entry) => entry.match.test(pathname));
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof ExnessApiError) {
      return (
        error.status === 429 ||
        error.status === 500 ||
        error.status === 503 ||
        this.isRateLimitError(error)
      );
    }
    // Network-level failures (DNS, reset, timeout) are worth one more try.
    return true;
  }

  private isRateLimitError(error: ExnessApiError): boolean {
    return error.code === 3015 || /REQUEST_RATE_LIMIT|rate.?limit/i.test(error.message);
  }

  private retryDelay(error: unknown, attempt: number): number {
    if (error instanceof ExnessApiError && error.retryAfterMs !== undefined) {
      return Math.min(error.retryAfterMs, 10_000);
    }
    if (error instanceof ExnessApiError && this.isRateLimitError(error)) {
      // The broker may return REQUEST_RATE_LIMIT as HTTP 400 (code 3015), so
      // treat it like a real throttle with a longer cool-off.
      return Math.min(1_500 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250);
    }
    return Math.min(500 * 2 ** attempt, 5_000) + Math.floor(Math.random() * 250);
  }
}
