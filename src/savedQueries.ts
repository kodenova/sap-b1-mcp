import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packageRoot } from "./paths.js";
import type { CompareOp, Filter, Scalar } from "./types.js";

/**
 * Saved queries are the ONLY way to run anything beyond the built-in tools.
 * They are defined by an administrator in a JSON file; the model can pick one
 * by name and pass typed parameters, but can never send SQL or a raw filter.
 *
 * Two kinds:
 *  - "odata":    a fixed Service Layer entity set + $select + structured filter
 *                whose values may reference {"param": "name"}.
 *  - "sqlquery": a SQLQueries entry already created in B1 (SELECT-only, SL 10.0 FP 2011+).
 */

const paramSpec = z.object({
  type: z.enum(["string", "number", "integer", "date", "boolean"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  maxLength: z.number().int().positive().max(254).optional(),
});

type ParamRef = { param: string };
type FilterSpec =
  | { field: string; op: CompareOp; value: Scalar | ParamRef }
  | { and: FilterSpec[] }
  | { or: FilterSpec[] };

const opEnum = z.enum(["eq", "ne", "gt", "ge", "lt", "le", "contains", "startswith"]);
const filterSpec: z.ZodType<FilterSpec> = z.lazy(() =>
  z.union([
    z.object({
      field: z.string(),
      op: opEnum,
      value: z.union([z.string(), z.number(), z.boolean(), z.object({ param: z.string() })]),
    }),
    z.object({ and: z.array(filterSpec) }),
    z.object({ or: z.array(filterSpec) }),
  ]),
);

const querySpec = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("odata"),
    description: z.string(),
    resource: z.string(),
    select: z.array(z.string()).min(1),
    filter: filterSpec.optional(),
    orderBy: z.string().optional(),
    maxRows: z.number().int().positive().optional(),
    params: z.record(z.string(), paramSpec).default({}),
  }),
  z.object({
    kind: z.literal("sqlquery"),
    description: z.string(),
    sqlCode: z.string().regex(/^[A-Za-z0-9_\-]{1,100}$/),
    maxRows: z.number().int().positive().optional(),
    params: z.record(z.string(), paramSpec).default({}),
  }),
]);

const fileSpec = z.object({ queries: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), querySpec) });

export type SavedQuery = z.infer<typeof querySpec>;
export type SavedQueries = Record<string, SavedQuery>;

export function loadSavedQueries(file: string | undefined, mock: boolean): SavedQueries {
  const resolved = file
    ? path.resolve(file)
    : mock
      ? path.join(packageRoot(), "config", "saved-queries.example.json")
      : undefined;
  if (!resolved || !existsSync(resolved)) return {};
  const parsed = fileSpec.safeParse(JSON.parse(readFileSync(resolved, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid saved queries file ${resolved}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data.queries;
}

/** Validate and coerce caller-supplied params against the query's declared params. */
export function resolveParams(q: SavedQuery, input: Record<string, unknown>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const k of Object.keys(input)) {
    if (!(k in q.params)) throw new Error(`Unknown parameter "${k}". Allowed: ${Object.keys(q.params).join(", ") || "(none)"}`);
  }
  for (const [name, spec] of Object.entries(q.params)) {
    const raw = input[name] ?? spec.default;
    if (raw === undefined) {
      if (spec.required) throw new Error(`Missing required parameter "${name}"`);
      continue;
    }
    out[name] = coerce(name, spec, raw);
  }
  return out;
}

function coerce(name: string, spec: z.infer<typeof paramSpec>, raw: unknown): Scalar {
  switch (spec.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`Parameter "${name}" must be a number`);
      return n;
    }
    case "integer": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isInteger(n)) throw new Error(`Parameter "${name}" must be an integer`);
      return n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      throw new Error(`Parameter "${name}" must be true/false`);
    case "date":
      if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      throw new Error(`Parameter "${name}" must be a date YYYY-MM-DD`);
    case "string": {
      if (typeof raw !== "string") throw new Error(`Parameter "${name}" must be a string`);
      const max = spec.maxLength ?? 100;
      if (raw.length > max) throw new Error(`Parameter "${name}" exceeds ${max} characters`);
      return raw;
    }
  }
}

/** Replace {"param": "x"} references with resolved values. */
export function bindFilter(spec: FilterSpec, params: Record<string, Scalar>): Filter | undefined {
  if ("and" in spec) {
    const parts = spec.and.map((s) => bindFilter(s, params)).filter((x): x is Filter => !!x);
    return parts.length ? { and: parts } : undefined;
  }
  if ("or" in spec) {
    const parts = spec.or.map((s) => bindFilter(s, params)).filter((x): x is Filter => !!x);
    return parts.length ? { or: parts } : undefined;
  }
  const v = spec.value;
  if (typeof v === "object" && v !== null) {
    if (!(v.param in params)) return undefined; // optional param not supplied: drop the clause
    return { field: spec.field, op: spec.op, value: params[v.param]! };
  }
  return { field: spec.field, op: spec.op, value: v };
}
