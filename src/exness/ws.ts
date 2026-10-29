import WebSocket from "ws";

import { buildSignedHeaders, type SigningIdentity } from "./signing.js";

export type SocketState = "connecting" | "open" | "reconnecting" | "closed";

export interface ExnessSocketOptions {
  accessPoint: string;
  identity: SigningIdentity;
  /** WebSocket path, e.g. /v1/server-events/accounts/123/ws/ticks */
  path: string;
  onMessage: (message: unknown, raw: string) => void;
  onOpen?: () => void;
  onState?: (state: SocketState, detail?: string) => void;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  logger?: (line: string) => void;
}

const WS_PROTOCOL = "exness-ws-protocol";
const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

function toWebSocketUrl(accessPoint: string, path: string): string {
  const base = accessPoint.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:").replace(/\/+$/, "");
  return `${base}${path}`;
}

export class ExnessSocket {
  private socket?: WebSocket;
  private closedByClient = false;
  private attempt = 0;
  private heartbeat?: NodeJS.Timeout;
  private awaitingPong = false;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly autoReconnect: boolean;
  private readonly url: string;

  constructor(private readonly options: ExnessSocketOptions) {
    this.autoReconnect = options.autoReconnect ?? true;
    this.url = toWebSocketUrl(options.accessPoint, options.path);
  }

  get state(): SocketState {
    if (this.closedByClient) return "closed";
    if (!this.socket) return "connecting";
    const readyState = this.socket.readyState;
    if (readyState === WebSocket.OPEN) return "open";
    if (readyState === WebSocket.CONNECTING) return "connecting";
    return "reconnecting";
  }

  connect(): void {
    this.closedByClient = false;
    this.open();
  }

  private open(): void {
    this.options.onState?.("connecting");

    // Fresh headers for every handshake; the signature is bound to the path.
    const headers = buildSignedHeaders({
      identity: this.options.identity,
      method: "GET",
      pathWithQuery: this.options.path,
      body: "",
      idempotencyKey: "",
    });

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url, WS_PROTOCOL, {
        headers,
        handshakeTimeout: 15_000,
        perMessageDeflate: false,
      });
      this.socket = socket;
    } catch (error) {
      this.handleError(error as Error);
      this.scheduleReconnect();
      return;
    }

    socket.on("open", () => {
      this.attempt = 0;
      this.startHeartbeat();
      this.options.onState?.("open");
      this.options.onOpen?.();
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      try {
        this.options.onMessage(JSON.parse(raw), raw);
      } catch {
        this.options.onMessage(raw, raw);
      }
    });

    socket.on("pong", () => {
      this.awaitingPong = false;
    });

    socket.on("error", (error) => {
      this.handleError(error);
    });

    socket.on("close", (code, reason) => {
      this.stopHeartbeat();
      if (this.closedByClient) {
        this.options.onState?.("closed");
        return;
      }
      const detail = `${code}${reason.length ? ` ${reason.toString()}` : ""}`;
      this.options.onState?.("reconnecting", detail);
      this.options.logger?.(`socket closed (${detail}); reconnecting`);
      this.scheduleReconnect();
    });
  }

  send(payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  close(): void {
    this.closedByClient = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try {
      this.socket?.close(1000, "client shutdown");
    } catch {
      // ignore
    }
    this.socket = undefined;
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.closedByClient) return;
    const backoff = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    const delay = backoff + Math.floor(Math.random() * 300);
    this.attempt += 1;
    this.options.logger?.(`reconnecting in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeat = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        this.socket.terminate();
        return;
      }
      this.awaitingPong = true;
      this.socket.ping();
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private handleError(error: Error): void {
    this.options.onError?.(error);
    this.options.logger?.(`socket error: ${error.message}`);
  }
}
