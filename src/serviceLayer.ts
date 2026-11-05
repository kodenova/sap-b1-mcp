import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import { assertOrderBy, assertField, assertResource, compileFilter, keySegment } from "./odata.js";
import { redact, registerSecret } from "./redact.js";
import type { DataSource, ListRequest, Row, Scalar } from "./types.js";

type Method = "GET" | "POST";

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Read-only guard. The only non-GET calls this client can make are Login,
 * Logout and executing a pre-created SQLQueries entry. PATCH/PUT/DELETE and
 * POST to any business object are refused before a request is ever sent.
 */
export function assertReadOnly(method: string, path: string): void {
  const p = path.replace(/^\/+/, "").split("?")[0] ?? "";
  if (method === "GET") return;
  if (method === "POST") {
    if (p === "Login" || p === "Logout") return;
    if (/^SQLQueries\('[^'()/]+'\)\/List$/.test(decodeURIComponent(p))) return;
  }
  throw new Error(`Blocked by read-only guard: ${method} ${p}`);
}

export class ServiceLayerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(redact(message));
    this.name = "ServiceLayerError";
  }
}

export class ServiceLayerClient implements DataSource {
  private cookie: string | null = null;
  private loginPromise: Promise<void> | null = null;
  private readonly base: URL;
  private readonly agent: http.Agent | https.Agent;

  constructor(private readonly cfg: AppConfig) {
    this.base = new URL(cfg.serviceLayerUrl.replace(/\/+$/, "") + "/");
    this.agent =
      this.base.protocol === "https:"
        ? new https.Agent({ keepAlive: true, rejectUnauthorized: !cfg.allowSelfSigned })
        : new http.Agent({ keepAlive: true });
    if (cfg.allowSelfSigned) {
      log.warn("SAPB1_ALLOW_SELF_SIGNED=1: TLS certificate verification is OFF for the Service Layer host.");
    }
  }

  // ---------- session ----------

  async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const res = await this.raw("POST", "Login", {
        CompanyDB: this.cfg.companyDb,
        UserName: this.cfg.username,
        Password: this.cfg.password,
      });
      if (res.status >= 300) throw new ServiceLayerError(res.status, `Login failed: ${errorText(res)}`);
      const setCookie = res.headers["set-cookie"] ?? [];
      const pairs = setCookie
        .map((c) => c.split(";")[0]?.trim() ?? "")
        .filter((c) => /^(B1SESSION|ROUTEID)=/i.test(c));
      if (!pairs.some((c) => /^B1SESSION=/i.test(c))) {
        // Some proxies strip Set-Cookie; fall back to the SessionId in the body.
        const sid = safeJson(res.body)?.SessionId;
        if (typeof sid !== "string") throw new ServiceLayerError(res.status, "Login returned no session");
        pairs.push(`B1SESSION=${sid}`);
      }
      for (const p of pairs) registerSecret(p.split("=")[1]);
      this.cookie = pairs.join("; ");
      log.info(`Logged in to Service Layer as configured read-only user (company ${this.cfg.companyDb}).`);
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async close(): Promise<void> {
    if (!this.cookie) return;
    try {
      await this.raw("POST", "Logout");
    } catch (e) {
      log.warn(`Logout failed: ${redact(e)}`);
    } finally {
      this.cookie = null;
      this.agent.destroy();
    }
  }

  // ---------- DataSource ----------

  async list(req: ListRequest): Promise<Row[]> {
    const parts: string[] = [];
    if (req.select.length) parts.push(`$select=${req.select.map(assertField).join(",")}`);
    if (req.filter) {
      const f = compileFilter(req.filter);
      if (f) parts.push(`$filter=${encodeURIComponent(f)}`);
    }
    if (req.orderBy) parts.push(`$orderby=${encodeURIComponent(assertOrderBy(req.orderBy))}`);
    parts.push(`$top=${req.top}`);
    return this.paged(`${assertResource(req.resource)}?${parts.join("&")}`, req.top);
  }

  async getByKey(resource: string, key: string | number, select: string[]): Promise<Row | null> {
    const q = select.length ? `?$select=${select.map(assertField).join(",")}` : "";
    const res = await this.request("GET", `${keySegment(resource, key)}${q}`);
    if (res.status === 404) return null;
    if (res.status >= 300) throw new ServiceLayerError(res.status, errorText(res));
    const json = safeJson(res.body);
    if (!json) throw new ServiceLayerError(res.status, "Unexpected non-JSON response");
    delete json["odata.metadata"];
    delete json["@odata.context"];
    delete json["odata.etag"];
    delete json["@odata.etag"];
    return json;
  }

  async runSqlQuery(code: string, params: Record<string, Scalar>, top: number): Promise<Row[]> {
    if (!/^[A-Za-z0-9_\-]{1,100}$/.test(code)) throw new Error(`Invalid SQL query code: ${code}`);
    // ParamList format: name=value&name2='text'  (strings quoted, as in the SL user manual)
    const paramList = Object.entries(params)
      .map(([k, v]) => `${assertField(k)}=${typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v)}`)
      .join("&");
    const path = `SQLQueries('${code}')/List`;
    const body = paramList ? { ParamList: paramList } : {};
    const rows: Row[] = [];
    let res = await this.request("POST", path, body, top);
    for (;;) {
      if (res.status >= 300) throw new ServiceLayerError(res.status, errorText(res));
      const json = safeJson(res.body) ?? {};
      rows.push(...((json.value as Row[] | undefined) ?? []));
      const next = nextLink(json);
      if (!next || rows.length >= top) break;
      res = await this.request("GET", this.relative(next), undefined, top);
    }
    return rows.slice(0, top);
  }

  // ---------- internals ----------

  private async paged(path: string, top: number): Promise<Row[]> {
    const rows: Row[] = [];
    let current: string | null = path;
    let pages = 0;
    while (current && rows.length < top && pages < 50) {
      const res = await this.request("GET", current, undefined, top);
      if (res.status >= 300) throw new ServiceLayerError(res.status, errorText(res));
      const json = safeJson(res.body) ?? {};
      rows.push(...((json.value as Row[] | undefined) ?? []));
      const next = nextLink(json);
      current = next ? this.relative(next) : null;
      pages++;
    }
    return rows.slice(0, top);
  }

  /** nextLink may be absolute, root-relative (/b1s/v1/...) or relative to the base. */
  private relative(link: string): string {
    const abs = new URL(link, link.startsWith("/") ? this.base.origin : this.base);
    const basePath = this.base.pathname;
    return abs.pathname.startsWith(basePath)
      ? abs.pathname.slice(basePath.length) + abs.search
      : abs.pathname.replace(/^\/+/, "") + abs.search;
  }

  private async request(method: Method, path: string, body?: unknown, pageSize?: number): Promise<HttpResult> {
    if (!this.cookie) await this.login();
    let res = await this.raw(method, path, body, pageSize);
    if (res.status === 401) {
      log.info("Service Layer session expired; logging in again.");
      this.cookie = null;
      await this.login();
      res = await this.raw(method, path, body, pageSize);
    }
    return res;
  }

  private raw(method: Method, path: string, body?: unknown, pageSize?: number): Promise<HttpResult> {
    assertReadOnly(method, path);
    const url = new URL(path, this.base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    if (this.cookie && path !== "Login") headers.Cookie = this.cookie;
    if (pageSize) headers.Prefer = `odata.maxpagesize=${Math.min(pageSize, 500)}`;
    const lib = url.protocol === "https:" ? https : http;

    return new Promise<HttpResult>((resolve, reject) => {
      const req = lib.request(
        url,
        { method, headers, agent: this.agent, timeout: this.cfg.timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", (e) => reject(new Error(redact(e))));
        },
      );
      req.on("timeout", () => req.destroy(new Error(`Service Layer request timed out after ${this.cfg.timeoutMs} ms`)));
      req.on("error", (e) => reject(new Error(redact(`Service Layer connection error: ${e.message}`))));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nextLink(json: Record<string, unknown>): string | null {
  const v = json["odata.nextLink"] ?? json["@odata.nextLink"];
  return typeof v === "string" && v ? v : null;
}

/** Service Layer v1: {error:{code,message:{lang,value}}}; v2: {error:{code,message}}. */
function errorText(res: HttpResult): string {
  const err = safeJson(res.body)?.error as { code?: unknown; message?: unknown } | undefined;
  if (err) {
    const m = err.message;
    const text = typeof m === "string" ? m : (m as { value?: string } | undefined)?.value ?? "";
    return redact(`HTTP ${res.status} (code ${String(err.code)}): ${text}`);
  }
  return redact(`HTTP ${res.status}: ${res.body.slice(0, 300)}`);
}
