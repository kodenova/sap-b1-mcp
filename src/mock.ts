import { readFileSync } from "node:fs";
import path from "node:path";
import { matches, assertResource } from "./odata.js";
import type { DataSource, ListRequest, Row, Scalar } from "./types.js";
import { packageRoot } from "./paths.js";

/** Resource name -> fixture file. Keys mirror Service Layer entity sets. */
const FILES: Record<string, string> = {
  BusinessPartners: "business-partners.json",
  Items: "items.json",
  Orders: "orders.json",
  Invoices: "invoices.json",
};

const KEYS: Record<string, string> = {
  BusinessPartners: "CardCode",
  Items: "ItemCode",
  Orders: "DocEntry",
  Invoices: "DocEntry",
};

/**
 * Mock data source for SAPB1_MOCK=1. Reads fixture JSON and applies the same
 * structured filters, $select, $orderby and row limits the real client sends.
 */
export class MockDataSource implements DataSource {
  private cache = new Map<string, Row[]>();
  constructor(private readonly dir = path.join(packageRoot(), "fixtures")) {}

  private load(resource: string): Row[] {
    assertResource(resource);
    const file = FILES[resource];
    if (!file) throw new Error(`Mock mode has no fixture for resource ${resource}`);
    let rows = this.cache.get(resource);
    if (!rows) {
      rows = JSON.parse(readFileSync(path.join(this.dir, file), "utf8")) as Row[];
      this.cache.set(resource, rows);
    }
    return rows;
  }

  async list(req: ListRequest): Promise<Row[]> {
    let rows = this.load(req.resource).filter((r) => (req.filter ? matches(r, req.filter) : true));
    if (req.orderBy) {
      const [field, dir] = req.orderBy.split(" ");
      const sign = dir === "desc" ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const x = a[field!] as string | number;
        const y = b[field!] as string | number;
        return (x < y ? -1 : x > y ? 1 : 0) * sign;
      });
    }
    return rows.slice(0, req.top).map((r) => pick(r, req.select));
  }

  async getByKey(resource: string, key: string | number, select: string[]): Promise<Row | null> {
    const keyField = KEYS[resource];
    if (!keyField) throw new Error(`Mock mode has no key for resource ${resource}`);
    const row = this.load(resource).find((r) => r[keyField] === key);
    return row ? pick(row, select) : null;
  }

  async runSqlQuery(code: string, _params: Record<string, Scalar>, top: number): Promise<Row[]> {
    const all = JSON.parse(readFileSync(path.join(this.dir, "sql-queries.json"), "utf8")) as Record<string, Row[]>;
    const rows = all[code];
    if (!rows) throw new Error(`Mock mode has no fixture for SQL query ${code}`);
    return rows.slice(0, top);
  }

  async close(): Promise<void> {}
}

function pick(row: Row, select: string[]): Row {
  if (!select.length) return { ...row };
  const out: Row = {};
  for (const f of select) if (f in row) out[f] = row[f];
  return out;
}
