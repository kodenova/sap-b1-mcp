/**
 * Credential redaction. Everything that leaves this process (errors returned
 * to the MCP client, log lines on stderr) goes through redact().
 */

const secrets = new Set<string>();

/** Register a runtime secret (password, session id) so it is scrubbed from any output. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 3) secrets.add(value);
}

/** Forget all registered secrets (used by tests). */
export function clearSecrets(): void {
  secrets.clear();
}

const PATTERNS: Array<[RegExp, string]> = [
  // JSON bodies: "Password":"..." / "UserName":"..."
  [/("(?:Password|password|UserName|username)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, '$1"[REDACTED]"'],
  // Cookies and headers
  [/(B1SESSION=)[^;,\s]+/gi, "$1[REDACTED]"],
  [/(ROUTEID=)[^;,\s]+/gi, "$1[REDACTED]"],
  [/("?SessionId"?\s*[:=]\s*"?)[A-Za-z0-9\-_.]+/gi, "$1[REDACTED]"],
  [/(Authorization:\s*)\S+(?:\s+\S+)?/gi, "$1[REDACTED]"],
  // env-style assignments
  [/(SAPB1_PASSWORD\s*=\s*)\S+/g, "$1[REDACTED]"],
];

export function redact(input: unknown): string {
  let text =
    typeof input === "string" ? input : input instanceof Error ? input.message : safeStringify(input);
  for (const [re, repl] of PATTERNS) text = text.replace(re, repl);
  for (const s of secrets) text = text.split(s).join("[REDACTED]");
  return text;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
