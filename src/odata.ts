import type { Filter, Scalar } from "./types.js";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ORDERBY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}( (asc|desc))?$/;

export function assertField(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid field name: ${name}`);
  return name;
}

export function assertResource(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid resource name: ${name}`);
  return name;
}

export function assertOrderBy(v: string): string {
  if (!ORDERBY_RE.test(v)) throw new Error(`Invalid orderBy: ${v}`);
  return v;
}

/** OData literal. Strings are single-quoted with embedded quotes doubled. */
export function literal(v: Scalar): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Non-finite number in filter");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${v.replace(/'/g, "''")}'`;
}

export function compileFilter(f: Filter): string {
  if ("and" in f) return f.and.map(wrap).filter(Boolean).join(" and ");
  if ("or" in f) return f.or.map(wrap).filter(Boolean).join(" or ");
  const field = assertField(f.field);
  switch (f.op) {
    case "contains":
      return `contains(${field},${literal(String(f.value))})`;
    case "startswith":
      return `startswith(${field},${literal(String(f.value))})`;
    case "eq":
    case "ne":
    case "gt":
    case "ge":
    case "lt":
    case "le":
      return `${field} ${f.op} ${literal(f.value)}`;
    default:
      throw new Error(`Unsupported operator: ${String((f as { op: unknown }).op)}`);
  }
}

function wrap(f: Filter): string {
  const s = compileFilter(f);
  return ("and" in f || "or" in f) && s ? `(${s})` : s;
}

/** Entity key segment, e.g. BusinessPartners('C001') or Orders(12). */
export function keySegment(resource: string, key: string | number): string {
  assertResource(resource);
  const k = typeof key === "number" ? String(key) : literal(key);
  return `${resource}(${encodeURIComponent(k).replace(/%27/g, "'")})`;
}

/** In-memory evaluation of the same filter, used by mock mode. */
export function matches(row: Record<string, unknown>, f: Filter): boolean {
  if ("and" in f) return f.and.every((x) => matches(row, x));
  if ("or" in f) return f.or.some((x) => matches(row, x));
  const actual = row[f.field];
  const v = f.value;
  switch (f.op) {
    case "eq":
      return actual === v;
    case "ne":
      return actual !== v;
    case "gt":
      return cmp(actual, v) > 0;
    case "ge":
      return cmp(actual, v) >= 0;
    case "lt":
      return cmp(actual, v) < 0;
    case "le":
      return cmp(actual, v) <= 0;
    case "contains":
      return typeof actual === "string" && actual.includes(String(v));
    case "startswith":
      return typeof actual === "string" && actual.startsWith(String(v));
    default:
      return false;
  }
}

function cmp(a: unknown, b: Scalar): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a ?? "");
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
