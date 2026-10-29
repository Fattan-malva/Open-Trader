export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["help", "verbose", "once"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;

    if (token === "--") {
      positionals.push(...rest.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }

      const next = rest[index + 1];
      if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const body = token.slice(1);
      const next = rest[index + 1];
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
      } else if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return { command, positionals, flags };
}

export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true || parsed.flags[name] === "true";
}

export function numberFlag(parsed: ParsedArgs, name: string, fallback: number): number {
  const value = parsed.flags[name];
  if (typeof value !== "string") return fallback;
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}
