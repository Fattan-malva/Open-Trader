import type { ExnessClient } from "../exness/client.js";
import type { CatalogService, Catalog } from "../exness/catalog.js";
import { apiInstruments } from "../exness/catalog.js";
import type { EquityTracker } from "../monitor/equity.js";
import { ExecutionGateway } from "../runtime/execution.js";
import type { EventHub, TickHub } from "../runtime/hubs.js";
import type { SnapshotCache } from "../runtime/snapshot.js";
import { createTools } from "../tools/index.js";
import { TradeTools } from "../tools/trading.js";
import { loadAgentConfig } from "./config.js";
import { AgentEngine } from "./engine.js";
import { AgentJournal } from "./journal.js";
import { RiskExecutor } from "./risk-and-executor.js";

export interface AgentRuntimeInput {
  client: ExnessClient;
  catalog: CatalogService;
  catalogData: Catalog;
  accountId: string;
  cacheDir: string;
  snapshot: SnapshotCache;
  ticks: TickHub;
  events: EventHub;
  equity: EquityTracker;
  log?: (line: string) => void;
}

export interface AgentRuntime {
  journal: AgentJournal;
  start(): Promise<void>;
  stop(): void;
}

/** One live agent, wired to the same feed and snapshot as the dashboard. */
export function createAgentRuntime(input: AgentRuntimeInput): AgentRuntime {
  const config = loadAgentConfig();
  const log = input.log ?? (() => {});
  const journal = new AgentJournal();
  const gateway = new ExecutionGateway(input.client, input.events, log, input.accountId);
  const tools = createTools({
    client: input.client,
    accountId: input.accountId,
  });
  const tradeTools = new TradeTools({
    snapshot: input.snapshot,
    catalog: input.catalog,
    gateway,
    accountId: input.accountId,
  });
  const executor = new RiskExecutor({
    tools: tradeTools,
    marketTools: tools,
    ticks: input.ticks,
    equity: input.equity,
    events: input.events,
    client: input.client,
    config,
    accountId: input.accountId,
    cacheDir: input.cacheDir,
    live: true,
    journal,
    log,
  });
  const engine = new AgentEngine({
    config,
    live: true,
    universe: apiInstruments(input.catalogData),
    cacheDir: input.cacheDir,
    tools,
    tradeTools,
    ticks: input.ticks,
    events: input.events,
    snapshot: input.snapshot,
    equity: input.equity,
    executor,
    journal,
    log,
  });

  return {
    journal,
    start: () => engine.start(),
    stop: () => {
      engine.stop();
      gateway.close();
    },
  };
}
