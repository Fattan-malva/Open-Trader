import type { CatalogService } from "../exness/catalog.js";
import type { InstrumentConditions, Order, OrderSide } from "../exness/types.js";
import type { ExecutionGateway, OperationResult } from "../runtime/execution.js";
import type { SnapshotCache, AccountView } from "../runtime/snapshot.js";

export interface TradeContext {
  snapshot: SnapshotCache;
  catalog: CatalogService;
  gateway: ExecutionGateway;
  accountId: string;
}

function decimalsOf(step: number): number {
  const text = step.toString();
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Floor a volume to the instrument step (never rounds risk up). */
export function roundVolumeDown(volume: number, step: number): number {
  if (!Number.isFinite(volume) || !Number.isFinite(step) || step <= 0) return 0;
  return Math.floor((volume + 1e-9) / step) * step;
}

export function roundVolumeToStep(volume: number, step: number): number {
  if (!Number.isFinite(volume) || !Number.isFinite(step) || step <= 0) return 0;
  // Volumes arrive as tiny binary fractions (0.06999999); round to 8 decimals
  // before snapping to the step so legitimate values are not floored away.
  const snapped = Math.round((volume + 1e-12) / step) * step;
  return Number(snapped.toFixed(Math.max(decimalsOf(step), 2)));
}

export function volumeString(volume: number, step: number): string {
  return roundVolumeToStep(volume, step).toFixed(decimalsOf(step));
}

export function priceString(price: number, digits: number): string {
  return price.toFixed(Math.max(0, digits));
}

function findSltpOrder(view: AccountView, positionId: string): Order | undefined {
  return view.orders.find(
    (order) =>
      order.order_type === "sltp" &&
      order.position_id === positionId &&
      order.state === "placed",
  );
}

export class TradeTools {
  constructor(private readonly context: TradeContext) {}

  async conditions(symbol: string): Promise<InstrumentConditions> {
    return this.context.catalog.conditions(symbol);
  }

  async view(force = false): Promise<AccountView> {
    return this.context.snapshot.get(force);
  }

  invalidateSnapshot(): void {
    this.context.snapshot.invalidate();
  }

  private async resolveSltp(positionId: string): Promise<Order | undefined> {
    const view = await this.context.snapshot.get();
    return findSltpOrder(view, positionId);
  }

  async open(input: {
    symbol: string;
    side: OrderSide;
    volume: number;
    stopLoss: number;
    comment?: string;
  }): Promise<OperationResult> {
    const conditions = await this.conditions(input.symbol);
    const digits = conditions.point_digits ?? 5;
    const step = Number(conditions.volume_step ?? "0.01");
    return this.context.gateway.openPosition({
      instrument: input.symbol,
      side: input.side,
      volume: volumeString(input.volume, Number.isFinite(step) && step > 0 ? step : 0.01),
      stop_loss_price: priceString(input.stopLoss, digits),
      comment: input.comment,
    });
  }

  /**
   * Broker-side emergency stop only (no take-profit)
   */
  async setSltp(
    positionId: string,
    stopLoss: number,
    digits: number,
  ): Promise<OperationResult> {
    const existing = await this.resolveSltp(positionId);
    const body = { stop_loss_price: priceString(stopLoss, digits) };
    if (existing) {
      return this.context.gateway.modifyOrder(existing.order_id, body);
    }
    return this.context.gateway.createSltp(positionId, body);
  }

  async close(positionId: string, volume?: number, step = 0.01): Promise<OperationResult> {
    return this.context.gateway.closePosition(
      positionId,
      volume !== undefined ? volumeString(volume, step) : undefined,
    );
  }
}
