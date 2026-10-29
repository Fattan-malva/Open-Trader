# open-trader

Terminal trading system for the **Exness Trader API**. The dashboard and the
live agent run in **one process**:

```powershell
npm install
npm start
```

`npm start` renders the full-screen board and starts the fast M1/M5 agent against
the account in `.env`. It is demo-first and deterministic (plain TypeScript
rules, no LLM). Use it on a demo account while tuning; profitability is not
guaranteed.

## What it does

```
every 2 s ──► fast screener (M5 trend + cached M1 pullback/breakout + adaptive spread)
          ──► entry (M1 confirmation + fresh executable quote)
          ──► risk (live account sizing + margin/risk limits + emergency SL)
          ──► trader (dynamic virtual trailing, no TP)
```

- **Screener** ranks fresh quotes every 2 seconds. The shortlist reserves capacity
  for FX, metals, crypto and energy instead of allowing one category to dominate;
  XAUUSD is pinned whenever it has a fresh quote within the hard spread cap, while
  remaining category slots rotate so quieter supported symbols are eventually scanned.
  M1/M5 candle history remains asynchronous and cached. Stocks and indices remain
  excluded because the current public trading/market-data API path does not serve them.
  Metal, crypto and energy spread caps can be tuned independently, with a per-symbol
  rolling baseline and spike guard still in force.
- **Entry** validates the selected setup, confirmation candle, RSI exhaustion, signal-distance,
  spread cost versus TS VIRT distance, and the latest executable quote. The executor rechecks
  spread and executable price immediately before order submission.
- **Risk** sizes from current account balance/equity (converted to USD for
  sizing), validates actual account leverage, caps volume by available free
  margin while reserving a buffer, and enforces aggregate open-risk and
  daily-loss limits. If the target lot rounds below broker minimum, the executor
  can use the broker minimum only when its real stop-loss risk fits the remaining
  aggregate open-risk budget; otherwise it records the exact risk/minimum-lot reason.
  Valid setups can add repeated entries on the same symbol; no fixed total-position
  count is imposed. It opens a market order with a
  **broker emergency stop-loss**
  and never sends a take-profit.
- **Trader** starts TS VIRT from the actual fill and fast-ATR distance rather
  than copying the distant emergency SL. It locks profit as soon as the
  executable side clears entry by spread + the configured buffer, then follows
  the best executable price by a tight dynamic ATR/pip distance, ratchets only
  toward profit, and attempts to tighten the broker emergency SL.
- **Dynamic account management**: the broker snapshot is the source of truth.
  Any open position the bot does not track yet is adopted from broker data
  (entry, SL, volume, instrument conditions) regardless of who opened it.
  Positions without an SL get an ATR/spread-based emergency SL first. This
  means no manual entry or pre-existing bot history is required, and every
  position on the account is managed by TS.
- The broker SL is the crash safety net; the dashboard shows both the broker SL
  and the live `TS VIRT` level on every position row.

## Dashboard

```
open-trader · DEMO
  BALANCE / EQUITY / FREE MARGIN / POSITIONS
  SCREENER · ENTRY · TRADER        (side-by-side containers)
  AGENT LOG
  POSITIONS                        (SL broker + TS VIRT + distance)
  ACCOUNT · MARKET · RISK
  EQUITY / DRAWDOWN
  EVENTS · ORDERS
```

The board is scrollable and the footer stays pinned. The agent is interactive:
it only trades when `stdout` is a TTY. `--once` (or a non-TTY run) is a
read-only snapshot.

### Keys

| Key | Action |
| --- | --- |
| `q` / `Ctrl+C` | quit the dashboard and stop the agent |
| `p` | pause / resume account polling |
| `a` | show / hide agent containers + log |
| `c` | show / hide equity + drawdown charts |
| `o` | show / hide orders |
| `e` | show / hide events |
| `r` | force a fresh REST snapshot |
| `x`, then `y` | arm / confirm kill switch: block entries + close every position (`n` cancels) |
| `u` | remove the kill switch flag (`unkill`) |
| `↑` / `↓`, `j` / `k` | scroll one line |
| `PgUp` / `PgDn` | scroll ten lines |
| `g` / `G` | jump to top / bottom |

The kill switch is persisted in `.cache/KILL`. While it is on, the agent closes
every open position (including positions it did not open) and refuses new
entries. `u` removes the flag; `x`/`y` turns it on.

### Other invocations

```powershell
npm start -- --once        # one read-only frame, no agent, exits
npm start -- --for 30      # interactive, auto-exit after 30 s
```

There are no other application commands. `npm test` and `npm run typecheck`
exist for development.

## Configuration

`.env` must contain:

```ini
EXNESS_API_KEY=exnsk-...
EXNESS_PRIVATE_KEY=...            # 128-char hex key pair, 64-char hex seed, or PEM
EXNESS_ACCOUNT_ID=31000172947
EXNESS_DISCOVERY_URL=https://api.exness.com
```

`EXNESS_API_SECRET` is still accepted as a fallback name for the private key.
`EXNESS_ACCESS_POINT` can pin the access point and skip discovery.

### Strategy defaults

All values are environment-overridable; the defaults are tuned for the demo
account.

| Setting | Default | Env |
| --- | --- | --- |
| Screener / confirmation / trail timeframe | `M1` | `AGENT_SCREENER_TF`, `AGENT_CONFIRM_TF`, `AGENT_TRAIL_TF` |
| Trend timeframe | `M5` | `AGENT_TREND_TF` |
| Scan interval | 2 s; not candle-aligned by default | `AGENT_SCAN_INTERVAL_MS`, `AGENT_ALIGN_SCAN_TO_CANDLE` |
| Manage cadence | 1 s | `AGENT_MANAGE_INTERVAL_MS` |
| Shortlist / candidates | 20 / 20 | `AGENT_SHORTLIST`, `AGENT_MAX_CANDIDATES` |
| Minimum score | 10 | `AGENT_MIN_SCORE` |
| Pullback RSI band | 20–80 | `AGENT_RSI_MIN`, `AGENT_RSI_MAX` |
| Pullback to M1 EMA50 | ≤ 3.0×ATR | `AGENT_PULLBACK_ATR` |
| M5 trend separation | ≥ 0.003×ATR | `AGENT_MIN_TREND_ATR` |
| FX / generic non-FX spread cap | ≤ 5 pips / ≤ 0.08% | `AGENT_MAX_SPREAD_PIPS`, `AGENT_MAX_SPREAD_PCT` |
| Metal / crypto / energy spread caps | ≤ 0.12% / ≤ 0.20% / ≤ 0.12% | `AGENT_MAX_METAL_SPREAD_PCT`, `AGENT_MAX_CRYPTO_SPREAD_PCT`, `AGENT_MAX_ENERGY_SPREAD_PCT` |
| Per-symbol spread spike guard | ≤ 2.5× rolling median | `AGENT_MAX_SPREAD_SPIKE_RATIO` |
| Breakout range / candle body | 5 bars / ≥ 0.08×ATR | `AGENT_BREAKOUT_LOOKBACK`, `AGENT_BREAKOUT_BODY_ATR` |
| Breakout RSI exhaustion | BUY ≤ 82 / SELL ≥ 18 | `AGENT_BREAKOUT_RSI_CEILING`, `AGENT_BREAKOUT_RSI_FLOOR` |
| Spread cost | ≤ 40% of trail | `AGENT_MAX_SPREAD_TRAIL` |
| Initial virtual trail | max(1.2×M1 ATR, 4 pips) | `AGENT_TRAIL_ATR`, `AGENT_TRAIL_MIN_PIPS` |
| First profit lock | Triggered at spread + `AGENT_PROFIT_LOCK_MIN_PIPS`; stop placed at entry ± that cushion | `AGENT_PROFIT_LOCK_MIN_PIPS` |
| Post-lock trail | max(0.3×ATR, 0.5 pips, 1.1×spread), then never widens | `AGENT_PROFIT_TRAIL_ATR`, `AGENT_PROFIT_TRAIL_MIN_PIPS` |
| Broker emergency SL | 1.5×M1 ATR, min 6 pips / 3× spread | `AGENT_EMERGENCY_SL_ATR`, `AGENT_MIN_STOP_PIPS` |
| Broker SL update cadence / minimum move | 10 s / 2 pips | `AGENT_BROKER_STOP_UPDATE_MS`, `AGENT_BROKER_STOP_MOVE_MIN_PIPS` |
| Max chase | 1.5×ATR | `AGENT_MAX_CHASE_ATR` |
| Max quote age | 8 s | `AGENT_MAX_QUOTE_AGE_MS` |
| Sizing equity | min(actual balance, equity), converted to USD | account snapshot + market quotes |
| Risk per trade | 0.1% target; minimum broker lot may exceed the target only if its actual SL risk fits within remaining aggregate cap | `AGENT_RISK_PCT` |
| Max lots per trade | 0.5 | `AGENT_MAX_LOTS` |
| Re-entry trigger | new valid closed candle or favourable move ≥ max(0.2×ATR, 1 pip) | `AGENT_REENTRY_STEP_ATR`, `AGENT_REENTRY_MIN_PIPS` |
| Same-symbol entries | No fixed per-symbol or total-position count; aggregate risk/margin still cap exposure | executor |
| Aggregate open-risk cap | 2% of account equity, re-sized to remaining budget | `AGENT_MAX_OPEN_RISK_PCT` |
| Open risk calculation | Current confirmed broker SL and stored USD pip value; TS VIRT never reduces risk | executor |
| Daily-loss entry cutoff | 3% of day-start balance | `AGENT_MAX_DAILY_LOSS_PCT` |
| Free-margin reserve | 25% plus 3× margin buffer | `AGENT_MARGIN_RESERVE_PCT`, `AGENT_MARGIN_BUFFER` |

`minAtrPct` / `maxAtrPct` (`AGENT_MIN_ATR_PCT`, `AGENT_MAX_ATR_PCT`) reject
instruments whose M1 ATR is too quiet or too wild.

### Trailing behaviour

- **BUY** tracks the highest bid; the virtual stop ratchets only upward.
- **SELL** tracks the lowest ask; the virtual stop ratchets only downward.
- A new M1 ATR is read at each closed M1 candle. If ATR shrinks, the stop may
  tighten; if ATR grows, the stop does not loosen.
- TS VIRT consumes each live tick directly, rather than waiting only for
  the account-management timer. BUY tracks the highest executable bid and the
  stop ratchets only upward; SELL tracks the lowest executable ask and the stop
  ratchets only downward.
- The first published TS VIRT update happens as soon as the executable side
  clears entry by the current spread plus the configured buffer. The stop is
  placed at entry ± that cushion immediately; it does not wait for the wider
  initial trail distance to be exceeded.
- After the first profit lock, the trail distance switches to the tighter
  `max(0.3×ATR, 0.5 pips, 1.1×spread)` target by default and keeps chasing each
  favorable tick. The distance and stop level never move backwards. When ATR
  refreshes or volatility expands, the active distance is never widened.
- No fixed USD activation threshold is used. BUY profit lock requires a stop
  above entry; SELL profit lock requires a stop below entry.
- A BUY closes when a fresh quote has `bid ≤ TS VIRT`; a SELL closes when a
  fresh quote has `ask ≥ TS VIRT`. The quote is revalidated after ATR/API awaits,
  and stale quotes cannot trigger a TS close.
- After profit-lock activation, the agent periodically tries to move the broker
  emergency SL in the protective direction. Broker minimum-distance rules may
  reject stops that are too close; failures are written to the log.
- Realized P/L can still differ because of spread, commission, and slippage.

Example: a BUY entry at `1.0850` with an 8-pip virtual distance starts at
`1.0842`. As the best bid rises to `1.0900`, TS VIRT ratchets toward `1.0892`.
If price later falls, the stop stays at its latest ratcheted level; when bid
reaches TS VIRT, the position is closed.

## Agent state and audit

```
.cache/agent-state.json           managed positions, broker SL / virtual stop, stats, journal
.cache/trades/YYYY-MM-DD.jsonl    open / trail / close / protect / skip / error events
.cache/equity/YYYY-MM-DD.jsonl    equity samples for charts
.cache/events/YYYY-MM-DD.jsonl    raw runtime events
.cache/KILL                       persistent kill switch flag
.cache/tick-unsupported.json      symbols the broker refuses to stream
```

State is written after every manage tick and on clean shutdown. A restart
restores managed positions, the virtual stop, best price, trail distance and the
emergency SL, then reconciles them against the broker. Every open position on
the account is managed dynamically: unknown positions are adopted from broker
data (entry, SL, volume, instrument conditions) and positions without an SL
receive an ATR/spread-based emergency SL first. No manual entry or pre-existing
bot history is required.

## Rate limits and resilience

- Account-wide REST limits: global 10/s, candles 2/s, snapshot 2/s, order
  mutations 4/s.
- WebSocket tick subscriptions are token-bucketed at 20/s and sent one
  instrument per message. A rejected symbol (`4000`) is remembered in
  `.cache/tick-unsupported.json` and never retried, so one bad ticker cannot
  loop the whole feed.
- `400/3015 REQUEST_RATE_LIMIT` is retried with 1.5 s → 3 s → 6 s backoff (capped
  at 10 s). The manage loop also backs off for 15 s if the shared bucket is
  saturated. Run only one live agent per account.
- The watchdog logs feed stalls and restarts a closed/wedged tick socket after
  45 s, then resubscribes.
- Async execution subscribes to `/ws/events` before sending an order and
  correlates the ACK / `transaction_event` by `client_request_id`, with polling
  as a fallback. Orders send only `stop_loss_price` (no take-profit).

## How it works

```
src/
├─ config.ts              .env loading (no dotenv) + validation
├─ exness/
│  ├─ signing.ts          hex/PEM → Ed25519 key, EXN-DATA + EXN-SIGN headers
│  ├─ client.ts           access-point discovery + cache, signed REST, retry, rate limit
│  ├─ ws.ts               signed WebSocket handshake, heartbeat, reconnect + resubscribe
│  ├─ catalog.ts          instrument catalog + per-instrument conditions (cached)
│  └─ types.ts            subset of trading.public.yaml v1.0.2
├─ market/
│  ├─ candles.ts          candle normalisation + pip/point helpers
│  ├─ indicators.ts       EMA/SMA/RSI/ATR
│  └─ store.ts            last tick per symbol, quotes, formatting
├─ runtime/
│  ├─ hubs.ts             TickHub / EventHub, one-instrument subscriptions, token bucket
│  ├─ snapshot.ts         account snapshot cache (1200 ms TTL, invalidate)
│  └─ execution.ts        ACK/event correlation, operation polling, order gateway
├─ tools/
│  ├─ index.ts            read-only candle history
│  └─ trading.ts          open / patch-or-create SLTP / close
├─ monitor/equity.ts      daily equity samples + start balance
├─ agents/
│  ├─ config.ts           thresholds and sizing
│  ├─ screener.ts         M15 trend + M1 pullback/breakout ranking
│  ├─ entry.ts            Setup-aware confirmation, spread cost, fast-ATR emergency stop
│  ├─ spread.ts           Hard caps + per-symbol rolling spread-spike detection
│  ├─ risk-and-executor.ts sizing, gating, virtual trailing, adoption, kill close
│  ├─ engine.ts           M1 scan loop, manage loop, watchdog, state writer
│  ├─ runtime.ts          wires the live agent to the dashboard context
│  ├─ journal.ts          per-agent activity feed for the dashboard
│  └─ trailing.ts         pure virtual stop / best-price / hit math
└─ cli/                   args, ANSI rendering, charts, dashboard
```

## Development

```powershell
npm test
npm run typecheck
```

Regression tests cover entry-anchored BUY/SELL virtual stops, monotonic
ratcheting, executable-side stop-hit logic, FX/non-FX adaptive spread guards,
closed-candle breakout scoring, setup-aware entry validation, stale quotes and
rolling 60-second tick activity. Live broker/account behavior still needs
integration and demo testing.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `401/1001` | Signature mismatch — key format, payload bytes, body hash or base64url padding. |
| `401/1000` | API key missing/expired, or `EXN-DATA.api_key` ≠ `EXN-API-KEY`. |
| `403/1002` | API key has no access to this account/IP/scope. |
| `404/2000` | Account not found for this key. |
| `400/3005` | `REQUEST_INVALID_COUNT` — candles need `count` or `to`, not just `from`. |
| `400/3015` | Request rate limit. Wait for the built-in backoff and run one agent only. |
| `400/4000` | `MARKET_INSTRUMENT_NOT_FOUND` — a symbol is not subscribable; remembered and never retried. |
| `400/4001` | `MARKET_TRADE_DISABLED` — instrument is visible but not tradable; skipped. |
| `400/5005` | Stop/take-profit is on the wrong side or too tight for the broker. |
| Repeated `503` | Service unavailable; retry later. |

## Security

- `.env` holds a live signing key: it is gitignored, never bundled and only read
  locally. Do not paste it into chats, issues or screenshots.
- The CLI prints only a key prefix (`exnsk-…`).
- Rotate the key in Exness Key Management if it was ever exposed, then update
  `.env`. Iterate on a demo account.
