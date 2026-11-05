import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import { redact } from "./redact.js";
import { bindFilter, resolveParams, type SavedQueries } from "./savedQueries.js";
import type { DataSource, Filter, Row } from "./types.js";

export const SERVER_NAME = "sap-b1-mcp";
export const SERVER_VERSION = "0.1.0";

// ---------- field whitelists (the model can never select anything else) ----------

export const BP_FIELDS = [
  "CardCode", "CardName", "CardType", "GroupCode", "Phone1", "EmailAddress", "City", "Country",
  "Currency", "FederalTaxID", "Valid", "Frozen",
] as const;
export const BALANCE_FIELDS = [
  "CardCode", "CardName", "Currency", "CurrentAccountBalance", "OpenOrdersBalance",
  "OpenDeliveryNotesBalance", "CreditLimit",
] as const;
export const ITEM_FIELDS = [
  "ItemCode", "ItemName", "ItemsGroupCode", "BarCode", "InventoryItem", "SalesItem", "PurchaseItem",
  "InventoryUOM", "QuantityOnStock", "QuantityOrderedFromVendors", "QuantityOrderedByCustomers",
  "Valid", "Frozen",
] as const;
export const DOC_FIELDS = [
  "DocEntry", "DocNum", "CardCode", "CardName", "NumAtCard", "DocDate", "DocDueDate",
  "DocTotal", "DocCurrency", "PaidToDate", "DocumentStatus",
] as const;

const CARD_TYPES = { customer: "cCustomer", supplier: "cSupplier", lead: "cLid" } as const;

const code = (label: string, max: number) =>
  z.string().trim().min(1).max(max).describe(`${label} (exact code, case-sensitive on HANA)`);

function json(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(e: unknown): CallToolResult {
  const msg = redact(e instanceof Error ? e.message : e);
  log.warn(`Tool error: ${msg}`);
  return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
}

function wrap<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export interface ServerDeps {
  config: Pick<AppConfig, "maxRows" | "mock">;
  data: DataSource;
  savedQueries: SavedQueries;
  /** Injectable clock for tests (YYYY-MM-DD). */
  today?: () => string;
}

export function createServer(deps: ServerDeps): McpServer {
  const { data, savedQueries } = deps;
  const max = deps.config.maxRows;
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
  const limit = z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Max rows to return (1-${max}, default ${Math.min(20, max)})`);
  const rows = (n?: number) => Math.min(n ?? Math.min(20, max), max);
  const fieldsOf = <T extends readonly [string, ...string[]]>(list: T) =>
    z.array(z.enum(list)).min(1).optional().describe(`Subset of fields to return. Allowed: ${list.join(", ")}`);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Read-only access to one SAP Business One company via Service Layer. " +
        "All tools only read data; there are no tools that create, change or delete anything. " +
        "Codes (CardCode, ItemCode) are exact. Use the search_* tools to find codes first.",
    },
  );

  // ---------------- business partners ----------------

  server.registerTool(
    "get_business_partner",
    {
      title: "Get business partner",
      description: "Fetch one business partner (customer, supplier or lead) by its exact CardCode.",
      inputSchema: { cardCode: code("CardCode", 50), fields: fieldsOf(BP_FIELDS) },
      annotations: READ_ONLY,
    },
    wrap(async ({ cardCode, fields }) => {
      const row = await data.getByKey("BusinessPartners", cardCode, [...(fields ?? BP_FIELDS)]);
      return row ? json(row) : fail(`Business partner ${cardCode} not found`);
    }),
  );

  server.registerTool(
    "search_business_partners",
    {
      title: "Search business partners",
      description:
        "Search business partners whose CardCode or CardName contains the text. Optionally filter by type.",
      inputSchema: {
        query: z.string().trim().max(100).optional().describe("Text contained in CardCode or CardName"),
        type: z.enum(["customer", "supplier", "lead"]).optional(),
        limit,
        fields: fieldsOf(BP_FIELDS),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ query, type, limit: n, fields }) => {
      const clauses: Filter[] = [];
      if (query) {
        clauses.push({
          or: [
            { field: "CardCode", op: "contains", value: query },
            { field: "CardName", op: "contains", value: query },
          ],
        });
      }
      if (type) clauses.push({ field: "CardType", op: "eq", value: CARD_TYPES[type] });
      const result = await data.list({
        resource: "BusinessPartners",
        select: [...(fields ?? BP_FIELDS)],
        filter: clauses.length ? { and: clauses } : undefined,
        orderBy: "CardCode",
        top: rows(n),
      });
      return json({ count: result.length, rows: result });
    }),
  );

  server.registerTool(
    "get_customer_balance",
    {
      title: "Get customer balance",
      description:
        "Account balance, open orders balance, open deliveries balance and credit limit for one business partner.",
      inputSchema: { cardCode: code("CardCode", 50) },
      annotations: READ_ONLY,
    },
    wrap(async ({ cardCode }) => {
      const row = await data.getByKey("BusinessPartners", cardCode, [...BALANCE_FIELDS]);
      if (!row) return fail(`Business partner ${cardCode} not found`);
      const bal = Number(row.CurrentAccountBalance ?? 0);
      const credit = Number(row.CreditLimit ?? 0);
      return json({ ...row, CreditAvailable: credit > 0 ? round(credit - bal) : null });
    }),
  );

  // ---------------- items ----------------

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description: "Fetch one item master record by its exact ItemCode.",
      inputSchema: { itemCode: code("ItemCode", 50), fields: fieldsOf(ITEM_FIELDS) },
      annotations: READ_ONLY,
    },
    wrap(async ({ itemCode, fields }) => {
      const row = await data.getByKey("Items", itemCode, [...(fields ?? ITEM_FIELDS)]);
      return row ? json(row) : fail(`Item ${itemCode} not found`);
    }),
  );

  server.registerTool(
    "search_items",
    {
      title: "Search items",
      description: "Search items whose ItemCode or ItemName contains the text.",
      inputSchema: {
        query: z.string().trim().max(100).optional().describe("Text contained in ItemCode or ItemName"),
        inStockOnly: z.boolean().optional().describe("Only items with QuantityOnStock > 0"),
        limit,
        fields: fieldsOf(ITEM_FIELDS),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ query, inStockOnly, limit: n, fields }) => {
      const clauses: Filter[] = [];
      if (query) {
        clauses.push({
          or: [
            { field: "ItemCode", op: "contains", value: query },
            { field: "ItemName", op: "contains", value: query },
          ],
        });
      }
      if (inStockOnly) clauses.push({ field: "QuantityOnStock", op: "gt", value: 0 });
      const result = await data.list({
        resource: "Items",
        select: [...(fields ?? ITEM_FIELDS)],
        filter: clauses.length ? { and: clauses } : undefined,
        orderBy: "ItemCode",
        top: rows(n),
      });
      return json({ count: result.length, rows: result });
    }),
  );

  server.registerTool(
    "get_stock_by_warehouse",
    {
      title: "Get stock by warehouse",
      description:
        "In-stock, committed, ordered and available quantity per warehouse for one item (from ItemWarehouseInfoCollection).",
      inputSchema: {
        itemCode: code("ItemCode", 50),
        warehouseCode: z.string().trim().min(1).max(8).optional().describe("Only this warehouse (WhsCode)"),
        includeEmpty: z.boolean().optional().describe("Include warehouses with zero stock (default false)"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ itemCode, warehouseCode, includeEmpty }) => {
      const item = await data.getByKey("Items", itemCode, ["ItemCode", "ItemName", "InventoryUOM", "ItemWarehouseInfoCollection"]);
      if (!item) return fail(`Item ${itemCode} not found`);
      const lines = ((item.ItemWarehouseInfoCollection as Row[] | undefined) ?? [])
        .filter((w) => !warehouseCode || w.WarehouseCode === warehouseCode)
        .map((w) => {
          const inStock = Number(w.InStock ?? 0);
          const committed = Number(w.Committed ?? 0);
          const ordered = Number(w.Ordered ?? 0);
          return {
            WarehouseCode: w.WarehouseCode,
            InStock: inStock,
            Committed: committed,
            Ordered: ordered,
            Available: round(inStock - committed + ordered),
          };
        })
        .filter((w) => includeEmpty || w.InStock !== 0 || w.Committed !== 0 || w.Ordered !== 0);
      const total = lines.reduce((s, w) => s + w.InStock, 0);
      return json({
        ItemCode: item.ItemCode,
        ItemName: item.ItemName,
        InventoryUOM: item.InventoryUOM,
        TotalInStock: round(total),
        warehouses: lines,
      });
    }),
  );

  // ---------------- documents ----------------

  server.registerTool(
    "get_open_sales_orders",
    {
      title: "Get open sales orders",
      description: "Open (not closed, not cancelled) sales orders, optionally for one customer, newest first.",
      inputSchema: { cardCode: code("CardCode", 50).optional(), limit, fields: fieldsOf(DOC_FIELDS) },
      annotations: READ_ONLY,
    },
    wrap(async ({ cardCode, limit: n, fields }) => {
      const clauses: Filter[] = [{ field: "DocumentStatus", op: "eq", value: "bost_Open" }];
      if (cardCode) clauses.push({ field: "CardCode", op: "eq", value: cardCode });
      const result = await data.list({
        resource: "Orders",
        select: [...(fields ?? DOC_FIELDS)],
        filter: { and: clauses },
        orderBy: "DocDate desc",
        top: rows(n),
      });
      return json({ count: result.length, rows: result });
    }),
  );

  server.registerTool(
    "get_open_invoices",
    {
      title: "Get open A/R invoices",
      description:
        "Open A/R invoices with the unpaid balance (DocTotal - PaidToDate), optionally for one customer or only overdue ones.",
      inputSchema: {
        cardCode: code("CardCode", 50).optional(),
        overdueOnly: z.boolean().optional().describe("Only invoices with DocDueDate before today"),
        limit,
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ cardCode, overdueOnly, limit: n }) => {
      const clauses: Filter[] = [{ field: "DocumentStatus", op: "eq", value: "bost_Open" }];
      if (cardCode) clauses.push({ field: "CardCode", op: "eq", value: cardCode });
      const asOf = today();
      if (overdueOnly) clauses.push({ field: "DocDueDate", op: "lt", value: asOf });
      const result = await data.list({
        resource: "Invoices",
        select: [...DOC_FIELDS],
        filter: { and: clauses },
        orderBy: "DocDueDate",
        top: rows(n),
      });
      const enriched = result.map((r) => {
        const open = round(Number(r.DocTotal ?? 0) - Number(r.PaidToDate ?? 0));
        const due = String(r.DocDueDate ?? "").slice(0, 10);
        const daysOverdue = due && due < asOf ? daysBetween(due, asOf) : 0;
        return { ...r, OpenAmount: open, DaysOverdue: daysOverdue };
      });
      const totalOpen = round(enriched.reduce((s, r) => s + r.OpenAmount, 0));
      return json({ asOf, count: enriched.length, totalOpen, rows: enriched });
    }),
  );

  // ---------------- saved queries ----------------

  const names = Object.keys(savedQueries);
  const catalogue = names.length
    ? names.map((n) => `${n}: ${savedQueries[n]!.description}`).join("; ")
    : "none configured (set SAPB1_SAVED_QUERIES_FILE)";

  server.registerTool(
    "run_saved_query",
    {
      title: "Run saved query",
      description:
        "Run a query that an administrator pre-registered in the saved-queries config file. " +
        `No free SQL or free filters are accepted. Available: ${catalogue}`,
      inputSchema: {
        name: z.string().min(1).max(64).describe("Saved query name"),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Parameters declared by that saved query"),
        limit,
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ name, params, limit: n }) => {
      const q = Object.prototype.hasOwnProperty.call(savedQueries, name) ? savedQueries[name] : undefined;
      if (!q) return fail(`Unknown saved query "${name}". Available: ${names.join(", ") || "(none)"}`);
      const bound = resolveParams(q, params ?? {});
      const top = Math.min(rows(n), q.maxRows ?? max);
      const result =
        q.kind === "odata"
          ? await data.list({
              resource: q.resource,
              select: q.select,
              filter: q.filter ? bindFilter(q.filter, bound) : undefined,
              orderBy: q.orderBy,
              top,
            })
          : await data.runSqlQuery(q.sqlCode, bound, top);
      return json({ query: name, count: result.length, rows: result });
    }),
  );

  return server;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
