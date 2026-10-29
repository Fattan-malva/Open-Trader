export type AgentRole = "screener" | "entry" | "trader";

export type AgentTone = "info" | "success" | "warn" | "error";

export interface AgentActivity {
  at: number;
  agent: AgentRole;
  message: string;
  tone: AgentTone;
}

/**
 * Small in-memory journal so the dashboard can show what each deterministic
 * agent is doing without scraping stdout. The engine persists the tail of this
 * journal inside agent-state.json; it is not a trading audit log (that is the
 * per-trade JSONL file).
 */
export class AgentJournal {
  private entries: AgentActivity[] = [];

  constructor(private readonly limit = 120) {}

  record(agent: AgentRole, message: string, tone: AgentTone = "info"): void {
    const text = message.trim();
    if (!text) return;
    this.entries.push({ at: Date.now(), agent, message: text, tone });
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  all(): AgentActivity[] {
    return [...this.entries];
  }

  recent(limit = 40): AgentActivity[] {
    return this.entries.slice(-Math.max(1, limit));
  }

  /** Restore a recent tail after a restart; old sessions are not replayed. */
  restore(entries: AgentActivity[] | undefined, maxAgeMs = 10 * 60_000): void {
    if (!Array.isArray(entries)) return;
    const cutoff = Date.now() - maxAgeMs;
    this.entries = entries.filter((entry) => entry && entry.at >= cutoff).slice(-this.limit);
  }
}
