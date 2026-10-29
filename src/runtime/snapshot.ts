import type { ExnessClient } from "../exness/client.js";
import type { AccountDetails, Order, Position, Snapshot } from "../exness/types.js";

export interface AccountView {
  accountId: string;
  name: string;
  isDemo: boolean;
  currency: string;
  leverage: string;
  status: string;
  tradeMode: string;
  executionMode: string;
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  marginLevel: number;
  unrealized: number;
  positions: Position[];
  orders: Order[];
  fetchedAt: number;
}

const DETAILS_TTL_MS = 5 * 60 * 1000;

function toNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toAccountView(
  details: AccountDetails | undefined,
  snapshot: Snapshot,
  accountId: string,
): AccountView {
  const balance = toNumber(snapshot.account_state.balance);
  const equity = toNumber(snapshot.account_state.equity);
  const usedMargin = toNumber(snapshot.account_state.used_margin);
  const settings = details?.settings;

  return {
    accountId,
    name: details?.account_name ?? `account ${accountId}`,
    isDemo: details?.is_demo ?? true,
    currency: settings?.currency ?? "USD",
    leverage: settings?.leverage ?? "?",
    status: settings?.account_status ?? "unknown",
    tradeMode: settings?.trade_mode ?? "unknown",
    executionMode: settings?.execution_mode ?? "unknown",
    balance,
    equity,
    usedMargin,
    freeMargin: equity - usedMargin,
    marginLevel: usedMargin > 0 ? (equity / usedMargin) * 100 : 0,
    unrealized: equity - balance,
    positions: snapshot.positions ?? [],
    orders: snapshot.orders ?? [],
    fetchedAt: Date.now(),
  };
}

/**
 * Coalesces snapshot reads: the endpoint is limited to 2 req/s and both the
 * dashboard and any agent may ask for the same data in the same second.
 */
export class SnapshotCache {
  private details?: { at: number; value: AccountDetails };
  private cache?: { at: number; value: AccountView };
  private inflight?: Promise<AccountView>;

  constructor(
    private readonly client: ExnessClient,
    private readonly accountId: string,
    private readonly ttlMs = 1200,
  ) {}

  async accountDetails(force = false): Promise<AccountDetails | undefined> {
    if (!force && this.details && Date.now() - this.details.at < DETAILS_TTL_MS) {
      return this.details.value;
    }
    try {
      const value = await this.client.get<AccountDetails>(
        `/v1/configuration/accounts/${this.accountId}/account`,
      );
      this.details = { at: Date.now(), value };
      return value;
    } catch {
      return this.details?.value;
    }
  }

  async get(force = false): Promise<AccountView> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.value;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchView().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchView(): Promise<AccountView> {
    const details = await this.accountDetails();
    const snapshot = await this.client.get<Snapshot>(
      `/v1/trading/accounts/${this.accountId}/snapshot`,
    );
    const view = toAccountView(details, snapshot, this.accountId);
    this.cache = { at: Date.now(), value: view };
    return view;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
