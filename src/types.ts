export type Row = Record<string, unknown>;
export type Scalar = string | number | boolean;

export type CompareOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "contains" | "startswith";

/** Structured filter. Compiled to OData for Service Layer, evaluated in memory for mock mode. */
export type Filter =
  | { field: string; op: CompareOp; value: Scalar }
  | { and: Filter[] }
  | { or: Filter[] };

export interface ListRequest {
  resource: string;
  select: string[];
  filter?: Filter;
  orderBy?: string;
  top: number;
}

/** The only operations the tools can perform. There is deliberately no create/update/delete. */
export interface DataSource {
  list(req: ListRequest): Promise<Row[]>;
  getByKey(resource: string, key: string | number, select: string[]): Promise<Row | null>;
  /** Execute a pre-created B1 SQLQueries entry (SELECT-only, created by an admin). */
  runSqlQuery(code: string, params: Record<string, Scalar>, top: number): Promise<Row[]>;
  close(): Promise<void>;
}
