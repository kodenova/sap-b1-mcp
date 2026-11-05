import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { MockDataSource } from "../src/mock.js";
import { loadSavedQueries } from "../src/savedQueries.js";
import { createServer } from "../src/server.js";

const EXPECTED_TOOLS = [
  "get_business_partner",
  "search_business_partners",
  "get_item",
  "search_items",
  "get_open_sales_orders",
  "get_customer_balance",
  "get_open_invoices",
  "get_stock_by_warehouse",
  "run_saved_query",
];

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content[0]?.text ?? "";
  return { isError: !!res.isError, text, data: res.isError ? null : JSON.parse(text) };
}

beforeAll(async () => {
  const config = loadConfig({ SAPB1_MOCK: "1", SAPB1_MAX_ROWS: "25" });
  const server = createServer({
    config,
    data: new MockDataSource(),
    savedQueries: loadSavedQueries(undefined, true),
    today: () => "2026-11-06",
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
});

afterAll(async () => {
  await client?.close();
});

describe("tool catalogue", () => {
  it("exposes exactly the 9 read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("has no tool that sounds like a write", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.name).not.toMatch(/create|update|delete|post|add|cancel|close|patch/i);
  });
});

describe("business partners", () => {
  it("get_business_partner returns whitelisted fields only", async () => {
    const r = await call("get_business_partner", { cardCode: "C10000" });
    expect(r.isError).toBe(false);
    expect(r.data.CardName).toBe("Demo Customer Alpha");
    expect(r.data).not.toHaveProperty("CurrentAccountBalance");
  });

  it("get_business_partner honours a field subset", async () => {
    const r = await call("get_business_partner", { cardCode: "C10000", fields: ["CardCode", "City"] });
    expect(Object.keys(r.data).sort()).toEqual(["CardCode", "City"]);
  });

  it("rejects fields outside the whitelist", async () => {
    const r = await call("get_business_partner", { cardCode: "C10000", fields: ["Password"] });
    expect(r.isError).toBe(true);
  });

  it("returns a clean error for unknown codes", async () => {
    const r = await call("get_business_partner", { cardCode: "NOPE" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });

  it("search_business_partners filters by text and type", async () => {
    const r = await call("search_business_partners", { query: "Demo", type: "customer" });
    expect(r.data.count).toBe(3);
    expect(r.data.rows.every((x: { CardType: string }) => x.CardType === "cCustomer")).toBe(true);
  });

  it("enforces the row limit ceiling (SAPB1_MAX_ROWS)", async () => {
    const ok = await call("search_business_partners", { limit: 2 });
    expect(ok.data.count).toBe(2);
    const tooMany = await call("search_business_partners", { limit: 26 });
    expect(tooMany.isError).toBe(true);
  });

  it("get_customer_balance computes available credit", async () => {
    const r = await call("get_customer_balance", { cardCode: "C10000" });
    expect(r.data.CurrentAccountBalance).toBe(12500.5);
    expect(r.data.CreditAvailable).toBe(7499.5);
    const noLimit = await call("get_customer_balance", { cardCode: "C20000" });
    expect(noLimit.data.CreditAvailable).toBeNull();
  });
});

describe("items and stock", () => {
  it("get_item", async () => {
    const r = await call("get_item", { itemCode: "A00001" });
    expect(r.data.ItemName).toBe("Demo Widget Small");
    expect(r.data).not.toHaveProperty("ItemWarehouseInfoCollection");
  });

  it("search_items with inStockOnly", async () => {
    const r = await call("search_items", { query: "Widget", inStockOnly: true });
    expect(r.data.rows.map((x: { ItemCode: string }) => x.ItemCode)).toEqual(["A00001"]);
  });

  it("get_stock_by_warehouse computes availability and hides empty warehouses", async () => {
    const r = await call("get_stock_by_warehouse", { itemCode: "A00001" });
    expect(r.data.TotalInStock).toBe(340);
    expect(r.data.warehouses).toHaveLength(2);
    expect(r.data.warehouses[0]).toMatchObject({ WarehouseCode: "01", Available: 350 });
    const one = await call("get_stock_by_warehouse", { itemCode: "A00001", warehouseCode: "02" });
    expect(one.data.warehouses).toEqual([
      { WarehouseCode: "02", InStock: 40, Committed: 10, Ordered: 0, Available: 30 },
    ]);
  });
});

describe("documents", () => {
  it("get_open_sales_orders excludes closed orders, newest first", async () => {
    const r = await call("get_open_sales_orders", {});
    expect(r.data.count).toBe(3);
    expect(r.data.rows[0].DocNum).toBe(5003);
    const alpha = await call("get_open_sales_orders", { cardCode: "C10000" });
    expect(alpha.data.count).toBe(2);
  });

  it("get_open_invoices returns open amounts and overdue days", async () => {
    const r = await call("get_open_invoices", { cardCode: "C10000" });
    expect(r.data.count).toBe(2);
    expect(r.data.totalOpen).toBe(12500.5);
    expect(r.data.rows[0]).toMatchObject({ DocNum: 7001, OpenAmount: 8000, DaysOverdue: 36 });
    const overdue = await call("get_open_invoices", { overdueOnly: true });
    expect(overdue.data.rows.map((x: { DocNum: number }) => x.DocNum)).toEqual([7001, 7003]);
  });
});

describe("run_saved_query", () => {
  it("runs a registered odata query with typed params", async () => {
    const r = await call("run_saved_query", { name: "customers_over_balance", params: { minBalance: 1000 } });
    expect(r.data.rows.map((x: { CardCode: string }) => x.CardCode)).toEqual(["C10000"]);
  });

  it("runs a registered SQLQueries entry", async () => {
    const r = await call("run_saved_query", { name: "sales_by_month", params: { year: 2026 } });
    expect(r.data.count).toBe(3);
  });

  it("refuses unknown query names (no free SQL)", async () => {
    const r = await call("run_saved_query", { name: "SELECT * FROM OUSR" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Unknown saved query/);
  });

  it("refuses undeclared params and bad types", async () => {
    const extra = await call("run_saved_query", { name: "customers_over_balance", params: { hack: "1 or 1=1" } });
    expect(extra.isError).toBe(true);
    const badDate = await call("run_saved_query", { name: "invoices_due_before", params: { dueBefore: "yesterday" } });
    expect(badDate.isError).toBe(true);
    const missing = await call("run_saved_query", { name: "sales_by_month" });
    expect(missing.isError).toBe(true);
  });

  it("ignores prototype keys as query names", async () => {
    const r = await call("run_saved_query", { name: "constructor" });
    expect(r.isError).toBe(true);
  });
});
