import { createIdempotencyKey, ExnessApiError, sleep } from "../exness/client.js";
import type {
  AckResponse,
  OperationStatusResponse,
  OrderSide,
  TransactionEvent,
  TransactionPayload,
} from "../exness/types.js";
import type { EventHub, RuntimeEvent } from "./hubs.js";

export type OperationKind = "open" | "close" | "sltp" | "modify" | "cancel";

export type OperationStatus =
  | "confirmed"
  | "rejected"
  | "failed"
  | "timeout"
  | "error";

export interface OperationResult {
  ok: boolean;
  kind: OperationKind;
  clientRequestId: string;
  operationId?: string;
  status: OperationStatus;
  errorCode?: number;
  errorMessage?: string;
  data?: TransactionPayload;
  latencyMs: number;
  /** Raw transaction event when it arrived (handy for debugging/probes). */
  event?: TransactionEvent;
}

export interface OpenPositionRequest {
  instrument: string;
  side: OrderSide;
  volume: string;
  stop_loss_price?: string;
  comment?: string;
}

export interface SltpPatch {
  stop_loss_price?: string | null;
}

interface Waiter {
  resolve: (event: TransactionEvent) => void;
  timer: NodeJS.Timeout;
}

const EVENT_TIMEOUT_MS = 8000;
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 400;

function asTransactionEvent(raw: unknown): TransactionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as TransactionEvent;
  return candidate.event_type === "transaction_event" ? candidate : null;
}

/**
 * Wraps every mutating trading call with the async contract of the API:
 *
 *   POST/PATCH/DELETE -> 202 { operation_id, client_request_id, status: accepted }
 *   transaction_event (matched by client_request_id) -> final result
 *   GET /operations/{id} -> fallback when the event was missed
 *
 * The waiter is registered *before* the request is sent so a fast event cannot
 * be lost, and the ACK's operation id is used for the fallback poll.
 */
export class ExecutionGateway {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly client: import("../exness/client.js").ExnessClient,
    private readonly events: EventHub,
    private readonly log: (line: string) => void = () => {},
    private readonly accountId: string = client.accountId,
  ) {
    this.events.on((event) => this.handleEvent(event));
  }

  private basePath(): string {
    return `/v1/trading/accounts/${this.accountId}`;
  }

  async openPosition(request: OpenPositionRequest): Promise<OperationResult> {
    return this.submit("open", "POST", `${this.basePath()}/positions`, request, true);
  }

  async closePosition(positionId: string, volume?: string): Promise<OperationResult> {
    return this.submit("close", "DELETE", `${this.basePath()}/positions/${positionId}`, undefined, true, {
      volume,
    });
  }

  async createSltp(
    positionId: string,
    patch: { stop_loss_price: string },
  ): Promise<OperationResult> {
    return this.submit(
      "sltp",
      "POST",
      `${this.basePath()}/orders`,
      { position_id: positionId, type: "sltp", ...patch },
      true,
    );
  }

  async modifyOrder(orderId: string, patch: SltpPatch): Promise<OperationResult> {
    return this.submit("modify", "PATCH", `${this.basePath()}/orders/${orderId}`, patch, true);
  }

  async getOperation(operationId: string): Promise<OperationStatusResponse> {
    return this.client.get<OperationStatusResponse>(
      `${this.basePath()}/operations/${operationId}`,
    );
  }

  close(): void {
    for (const [key, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      this.waiters.delete(key);
    }
  }

  private async submit(
    kind: OperationKind,
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    mutating: boolean,
    query?: Record<string, string | undefined>,
  ): Promise<OperationResult> {
    const clientRequestId = createIdempotencyKey(`ot-${kind}`);
    const started = Date.now();
    const eventPromise = this.waitForEvent(clientRequestId);

    let ack: AckResponse;
    try {
      ack = await this.client.request<AckResponse>(method, path, {
        body,
        query: query as Record<string, string | undefined>,
        idempotencyKey: mutating ? clientRequestId : undefined,
      });
    } catch (error) {
      this.cancelWaiter(clientRequestId);
      const apiError = error instanceof ExnessApiError ? error : undefined;
      return {
        ok: false,
        kind,
        clientRequestId,
        status: "error",
        errorCode: apiError?.code ?? apiError?.status,
        errorMessage: apiError?.message ?? (error instanceof Error ? error.message : String(error)),
        latencyMs: Date.now() - started,
      };
    }

    let event = await eventPromise;
    const operationId = ack?.operation_id;
    if (!event && operationId) {
      event = await this.pollOperation(operationId);
    }
    this.cancelWaiter(clientRequestId);

    if (!event) {
      return {
        ok: false,
        kind,
        clientRequestId,
        operationId,
        status: "timeout",
        errorCode: undefined,
        errorMessage: `No transaction_event within ${EVENT_TIMEOUT_MS}ms and no final operation status`,
        latencyMs: Date.now() - started,
      };
    }

    const status = event.status === "success" ? "confirmed" : event.status === "rejected" ? "rejected" : "failed";
    return {
      ok: status === "confirmed",
      kind,
      clientRequestId,
      operationId: event.operation_id ?? operationId,
      status,
      errorCode: event.error_code,
      errorMessage: event.error_message,
      data: event.payload,
      latencyMs: Date.now() - started,
      event,
    };
  }

  private waitForEvent(clientRequestId: string): Promise<TransactionEvent | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(clientRequestId);
        resolve(null);
      }, EVENT_TIMEOUT_MS);
      timer.unref?.();

      this.waiters.set(clientRequestId, {
        resolve: (event) => resolve(event),
        timer,
      });
    });
  }

  private cancelWaiter(clientRequestId: string): void {
    const waiter = this.waiters.get(clientRequestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(clientRequestId);
  }

  private async pollOperation(operationId: string): Promise<TransactionEvent | null> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      await sleep(POLL_DELAY_MS);
      try {
        const status = await this.getOperation(operationId);
        if (status.status === "confirmed") {
          return {
            event_type: "transaction_event",
            operation_id: status.operation_id,
            client_request_id: status.client_request_id,
            status: "success",
            event_time: status.updated_at,
          };
        }
        if (status.status === "rejected" || status.status === "failed") {
          return {
            event_type: "transaction_event",
            operation_id: status.operation_id,
            client_request_id: status.client_request_id,
            status: status.status,
            error_code: status.error_code,
            error_message: status.error_message,
            event_time: status.updated_at,
          };
        }
      } catch (error) {
        this.log(
          `operation poll failed for ${operationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return null;
  }

  private handleEvent(event: RuntimeEvent): void {
    const transaction = asTransactionEvent(event.raw);
    if (!transaction) return;
    const key = transaction.client_request_id;
    if (!key) return;

    const waiter = this.waiters.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(key);
    waiter.resolve(transaction);
  }
}
