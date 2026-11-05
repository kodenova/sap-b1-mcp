import { redact } from "./redact.js";

/**
 * Logs go to stderr only: stdout is reserved for the MCP stdio protocol.
 * Every line is passed through redact().
 */
type Level = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function current(): Level {
  const l = (process.env.SAPB1_LOG_LEVEL ?? "info").toLowerCase() as Level;
  return l in ORDER ? l : "info";
}

function write(level: Level, msg: string): void {
  if (ORDER[level] < ORDER[current()]) return;
  process.stderr.write(`[sap-b1-mcp] ${level.toUpperCase()} ${redact(msg)}\n`);
}

export const log = {
  debug: (m: string) => write("debug", m),
  info: (m: string) => write("info", m),
  warn: (m: string) => write("warn", m),
  error: (m: string) => write("error", m),
};
