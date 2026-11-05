import { registerSecret } from "./redact.js";

export interface AppConfig {
  mock: boolean;
  serviceLayerUrl: string;
  companyDb: string;
  username: string;
  password: string;
  allowSelfSigned: boolean;
  maxRows: number;
  timeoutMs: number;
  savedQueriesFile?: string;
}

/** Hard ceiling regardless of SAPB1_MAX_ROWS. */
export const ABSOLUTE_MAX_ROWS = 500;
export const DEFAULT_MAX_ROWS = 50;

function flag(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mock = flag(env.SAPB1_MOCK);
  const cfg: AppConfig = {
    mock,
    serviceLayerUrl: (env.SAPB1_SERVICE_LAYER_URL ?? "").replace(/\/+$/, ""),
    companyDb: env.SAPB1_COMPANY_DB ?? "",
    username: env.SAPB1_USERNAME ?? "",
    password: env.SAPB1_PASSWORD ?? "",
    allowSelfSigned: flag(env.SAPB1_ALLOW_SELF_SIGNED),
    maxRows: Math.min(int(env.SAPB1_MAX_ROWS, DEFAULT_MAX_ROWS), ABSOLUTE_MAX_ROWS),
    timeoutMs: int(env.SAPB1_TIMEOUT_MS, 30_000),
    savedQueriesFile: env.SAPB1_SAVED_QUERIES_FILE || undefined,
  };
  registerSecret(cfg.password);

  if (!mock) {
    const missing = (
      [
        ["SAPB1_SERVICE_LAYER_URL", cfg.serviceLayerUrl],
        ["SAPB1_COMPANY_DB", cfg.companyDb],
        ["SAPB1_USERNAME", cfg.username],
        ["SAPB1_PASSWORD", cfg.password],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      throw new Error(
        `Missing required env vars: ${missing.join(", ")} (or set SAPB1_MOCK=1 to use fixture data)`,
      );
    }
    if (!/^https?:\/\//i.test(cfg.serviceLayerUrl)) {
      throw new Error("SAPB1_SERVICE_LAYER_URL must look like https://host:50000/b1s/v1");
    }
    if (/^http:\/\//i.test(cfg.serviceLayerUrl) && !flag(env.SAPB1_ALLOW_HTTP)) {
      throw new Error(
        "Plain http:// would send credentials unencrypted. Use https://, or set SAPB1_ALLOW_HTTP=1 for a local test only.",
      );
    }
  }
  return cfg;
}
