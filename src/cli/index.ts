#!/usr/bin/env node
import { boolFlag, parseArgs } from "./args.js";
import { reportError } from "./context.js";
import { runDashboard } from "./dashboard/index.js";

const HELP = `
open-trader — Exness Trader API terminal trading system

Usage
  npm start                 dashboard + live M1 agent in one process
  npm start -- --once       one dashboard snapshot (read-only)
  npm start -- --for 30     auto-exit after 30 seconds

The agent only trades when the dashboard is interactive. It scans on the M1
close, uses the M15 trend, places a broker emergency SL, and exits with a
program-side virtual trailing stop. There is no take-profit.
`;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === "help" || boolFlag(parsed, "help")) {
    console.log(HELP.trim());
    return 0;
  }
  if (parsed.command !== "dashboard") {
    console.error(`Unknown command "${parsed.command}". Use npm start.`);
    return 2;
  }
  return runDashboard(parsed);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    reportError(error, boolFlag(parseArgs(process.argv.slice(2)), "verbose"));
    process.exitCode = 1;
  });
