/**
 * Exercises the real Service Layer client against a tiny local fake of the
 * Service Layer HTTP API: login cookie, $select/$filter/$top, odata.nextLink
 * paging, session expiry re-login, error redaction and logout.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { registerSecret } from "../src/redact.js";
import { ServiceLayerClient } from "../src/serviceLayer.js";

const PASSWORD = "FakePassw0rd!";
const calls: Array<{ method: string; url: string; cookie?: string; body: string }> = [];
let sessions = 0;
let expireNext = false;
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, cookie: req.headers.cookie, body });
      const url = new URL(req.url!, "http://x");
      const send = (status: number, payload: unknown, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/b1s/v1/Login") {
        const b = JSON.parse(body);
        if (b.Password !== PASSWORD) {
          return send(401, { error: { code: -304, message: { lang: "en-us", value: `Fail to get DB Credentials for ${b.Password}` } } });
        }
        sessions++;
        return send(200, { SessionId: `sess-${sessions}`, Version: "1000190", SessionTimeout: 30 }, {
          "Set-Cookie": [`B1SESSION=sess-${sessions}; path=/b1s/v1; Secure; HttpOnly`, "ROUTEID=.node1; path=/b1s"],
        });
      }
      if (!req.headers.cookie?.includes("B1SESSION=sess-")) return send(401, { error: { code: 301, message: { value: "Invalid session." } } });
      if (expireNext) {
        expireNext = false;
        return send(401, { error: { code: 301, message: { value: "Invalid session or session already timeout." } } });
      }
      if (url.pathname === "/b1s/v1/Logout") return res.writeHead(204).end();
      if (url.pathname === "/b1s/v1/BusinessPartners") {
        const skip = Number(url.searchParams.get("$skip") ?? 0);
        const all = [{ CardCode: "C1" }, { CardCode: "C2" }, { CardCode: "C3" }];
        const page = all.slice(skip, skip + 2);
        const payload: Record<string, unknown> = { "odata.metadata": "$metadata#BusinessPartners", value: page };
        if (skip + 2 < all.length) payload["odata.nextLink"] = `BusinessPartners?$select=CardCode&$skip=${skip + 2}`;
        return send(200, payload);
      }
      if (url.pathname === "/b1s/v1/Items('A1')") return send(200, { "odata.metadata": "x", ItemCode: "A1", ItemName: "Thing" });
      if (url.pathname.startsWith("/b1s/v1/Items(")) return send(404, { error: { code: -2028, message: { value: "No matching records found (ODBC -2028)" } } });
      if (url.pathname === "/b1s/v1/SQLQueries('KN_TEST')/List" && req.method === "POST") return send(200, { value: [{ n: 1 }] });
      return send(400, { error: { code: -1, message: { value: "unexpected" } } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/b1s/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function cfg(password = PASSWORD): AppConfig {
  registerSecret(password);
  return { mock: false, serviceLayerUrl: base, companyDb: "SBODEMO", username: "mcp_ro", password, allowSelfSigned: false, maxRows: 50, timeoutMs: 5000 };
}

describe("ServiceLayerClient", () => {
  it("logs in, sends $select/$filter/$top with the session cookie and follows nextLink", async () => {
    calls.length = 0;
    const c = new ServiceLayerClient(cfg());
    const rows = await c.list({
      resource: "BusinessPartners",
      select: ["CardCode"],
      filter: { field: "CardType", op: "eq", value: "cCustomer" },
      orderBy: "CardCode",
      top: 10,
    });
    expect(rows.map((r) => r.CardCode)).toEqual(["C1", "C2", "C3"]);
    expect(calls[0]!.url).toBe("/b1s/v1/Login");
    const first = decodeURIComponent(calls[1]!.url);
    expect(first).toContain("$select=CardCode");
    expect(first).toContain("$filter=CardType eq 'cCustomer'");
    expect(first).toContain("$top=10");
    expect(calls[1]!.cookie).toContain("B1SESSION=sess-");
    expect(calls[1]!.cookie).toContain("ROUTEID=.node1");
    expect(calls[2]!.url).toContain("$skip=2");
    await c.close();
    expect(calls.at(-1)!.url).toBe("/b1s/v1/Logout");
  });

  it("stops at the row limit even if more pages exist", async () => {
    const c = new ServiceLayerClient(cfg());
    const rows = await c.list({ resource: "BusinessPartners", select: ["CardCode"], top: 2 });
    expect(rows).toHaveLength(2);
    await c.close();
  });

  it("re-logs in once when the session expires", async () => {
    const c = new ServiceLayerClient(cfg());
    await c.getByKey("Items", "A1", ["ItemCode"]);
    const before = sessions;
    expireNext = true;
    const row = await c.getByKey("Items", "A1", ["ItemCode", "ItemName"]);
    expect(row).toEqual({ ItemCode: "A1", ItemName: "Thing" });
    expect(sessions).toBe(before + 1);
    await c.close();
  });

  it("maps 404 to null", async () => {
    const c = new ServiceLayerClient(cfg());
    expect(await c.getByKey("Items", "MISSING", ["ItemCode"])).toBeNull();
    await c.close();
  });

  it("runs a SQLQueries entry via POST .../List", async () => {
    const c = new ServiceLayerClient(cfg());
    expect(await c.runSqlQuery("KN_TEST", { year: 2026 }, 10)).toEqual([{ n: 1 }]);
    const last = calls.filter((x) => x.url.includes("SQLQueries")).at(-1)!;
    expect(JSON.parse(last.body)).toEqual({ ParamList: "year=2026" });
    await c.close();
  });

  it("redacts the password from login errors", async () => {
    const c = new ServiceLayerClient(cfg("WrongPassw0rd!"));
    await expect(c.list({ resource: "BusinessPartners", select: [], top: 1 })).rejects.toThrow(/Login failed/);
    try {
      await c.list({ resource: "BusinessPartners", select: [], top: 1 });
    } catch (e) {
      expect(String(e)).not.toContain("WrongPassw0rd!");
    }
  });
});
