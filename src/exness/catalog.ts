import fs from "node:fs";
import path from "node:path";

import type { ExnessClient } from "./client.js";
import type { InstrumentConditions, InstrumentListResponse } from "./types.js";

export type InstrumentCategory = "fx" | "metals" | "crypto" | "index" | "stock" | "other";

export interface Catalog {
  fetchedAt: number;
  instruments: string[];
  byCategory: Record<InstrumentCategory, string[]>;
}

/**
 * The public API does not serve stock or index instruments. Keep them in the
 * catalog for display, but never subscribe to their ticks or scan them.
 */
const COMMODITY = /^(XAU|XAG|XPT|XPD|XAL|XCU|XNG|XNI|XPB|XZN|USOIL|UKOIL|XBR|XTI)/;
const CRYPTO_BASES = [
  "BTC", "ETH", "BCH", "LTC", "XRP", "ADA", "SOL", "DOT", "DOGE", "AVAX",
  "LINK", "UNI", "TRX", "MATIC", "SHIB", "ATOM", "EOS", "XLM", "XMR", "ZEC",
  "DASH", "ETC", "BNB", "APT", "ARB", "OP", "SUI", "PEPE", "USDT", "USDC",
];
const CRYPTO_QUOTES = new Set([
  "USD", "EUR", "JPY", "GBP", "CHF", "AUD", "NZD", "CAD", "CNH", "KRW",
  "THB", "ZAR", "TRY", "SEK", "NOK", "DKK", "PLN", "HUF", "CZK", "MXN",
  "SGD", "HKD", "ILS", "RUB", "BTC", "ETH", "XAU", "XAG", "USDT", "USDC",
]);

function isCrypto(symbol: string): boolean {
  for (const base of CRYPTO_BASES) {
    if (!symbol.startsWith(base)) continue;
    const quote = symbol.slice(base.length);
    if (quote.length >= 3 && CRYPTO_QUOTES.has(quote)) return true;
  }
  return false;
}

export function categorize(symbol: string): InstrumentCategory {
  if (COMMODITY.test(symbol)) return "metals";
  if (isCrypto(symbol)) return "crypto";
  if (/^[A-Z]{6}$/.test(symbol)) return "fx";
  if (/\d/.test(symbol)) return "index";
  return "stock";
}

/** Instruments the public API can stream and trade. */
export function apiInstruments(catalog: Catalog): string[] {
  return [
    ...catalog.byCategory.fx,
    ...catalog.byCategory.metals,
    ...catalog.byCategory.crypto,
    ...catalog.byCategory.other,
  ];
}

/** Display precision heuristic, used when instrument conditions are not cached yet. */
export function digitsFor(symbol: string): number {
  const category = categorize(symbol);
  if (category === "fx") return symbol.endsWith("JPY") ? 3 : 5;
  if (category === "metals") return symbol.startsWith("XAU") ? 2 : 3;
  if (category === "crypto") return 2;
  if (category === "index") return 1;
  if (category === "stock") return 2;
  return 4;
}

const CATALOG_TTL_MS = 60 * 60 * 1000;
const CONDITIONS_TTL_MS = 60 * 60 * 1000;

interface CachedConditions {
  fetchedAt: number;
  conditions: InstrumentConditions;
}

export class CatalogService {
  private readonly catalogFile: string;
  private readonly conditionsDir: string;
  private cachedCatalog?: Catalog;

  constructor(
    private readonly client: ExnessClient,
    private readonly cacheDir: string,
    private readonly accountId: string,
  ) {
    this.catalogFile = path.join(cacheDir, "instruments.json");
    this.conditionsDir = path.join(cacheDir, "conditions");
  }

  async catalog(options: { force?: boolean } = {}): Promise<Catalog> {
    if (this.cachedCatalog && !options.force) return this.cachedCatalog;

    if (!options.force) {
      const cached = this.readJson<Omit<Catalog, "byCategory"> & { byCategory?: Catalog["byCategory"] }>(
        this.catalogFile,
      );
      if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS && Array.isArray(cached.instruments)) {
        this.cachedCatalog = cached.byCategory
          ? (cached as Catalog)
          : buildCatalog(cached.instruments, cached.fetchedAt);
        return this.cachedCatalog;
      }
    }

    const response = await this.client.get<InstrumentListResponse>(
      `/v1/configuration/accounts/${this.accountId}/instruments`,
    );
    const catalog = buildCatalog(response.instruments ?? [], Date.now());
    this.cachedCatalog = catalog;
    this.writeJson(this.catalogFile, catalog);
    return catalog;
  }

  async conditions(symbol: string, options: { force?: boolean } = {}): Promise<InstrumentConditions> {
    const upper = symbol.toUpperCase();
    const file = path.join(this.conditionsDir, `${upper}.json`);
    if (!options.force) {
      const cached = this.readJson<CachedConditions>(file);
      if (cached && Date.now() - cached.fetchedAt < CONDITIONS_TTL_MS) return cached.conditions;
    }

    const conditions = await this.client.get<InstrumentConditions>(
      `/v1/configuration/accounts/${this.accountId}/instruments/${encodeURIComponent(upper)}/conditions`,
    );
    this.writeJson(file, { fetchedAt: Date.now(), conditions });
    return conditions;
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private writeJson(file: string, value: unknown): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value, null, 2));
    } catch {
      // Cache is best-effort only.
    }
  }
}

export function buildCatalog(instruments: string[], fetchedAt = Date.now()): Catalog {
  const byCategory: Record<InstrumentCategory, string[]> = {
    fx: [],
    metals: [],
    crypto: [],
    index: [],
    stock: [],
    other: [],
  };
  for (const instrument of instruments) {
    byCategory[categorize(instrument)].push(instrument);
  }
  return { fetchedAt, instruments, byCategory };
}
