# sap-b1-mcp: read-only SAP Business One MCP server

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants (Claude, ChatGPT via a bridge, Cursor, VS Code and other MCP clients) **read** data from one SAP Business One company through the **Service Layer** REST API.

It is a deliberately small, auditable starter:

- **Read-only by design.** There are no tools that create, change or delete anything, and the HTTP client refuses any request other than `GET`, `Login`, `Logout` and running a pre-created `SQLQueries` entry.
- **No free SQL and no free filters.** Every tool has a typed input schema, a row limit and a field whitelist. Custom reports go through `run_saved_query`, which only runs queries an administrator registered in a config file.
- **Credentials stay private.** They come from environment variables, are never logged, and are redacted from every error message.
- **Runs without SAP.** `SAPB1_MOCK=1` serves bundled demo fixtures, so you can try it and run the tests on any machine.

> SAP and SAP Business One are trademarks or registered trademarks of SAP SE in Germany and other countries. This project is independent and is not affiliated with, sponsored by or endorsed by SAP SE.

## Tools

| Tool | What it returns | Key inputs | Row limit |
|---|---|---|---|
| `get_business_partner` | One customer, supplier or lead by exact `CardCode` | `cardCode`, optional `fields` | 1 |
| `search_business_partners` | Partners whose code or name contains text | `query`, `type` (customer / supplier / lead), `limit`, `fields` | `limit` (≤ `SAPB1_MAX_ROWS`) |
| `get_item` | One item master record by exact `ItemCode` | `itemCode`, optional `fields` | 1 |
| `search_items` | Items whose code or name contains text | `query`, `inStockOnly`, `limit`, `fields` | `limit` |
| `get_open_sales_orders` | Open sales orders, newest first | optional `cardCode`, `limit`, `fields` | `limit` |
| `get_customer_balance` | Account balance, open orders, open deliveries, credit limit and available credit | `cardCode` | 1 |
| `get_open_invoices` | Open A/R invoices with unpaid amount and days overdue, plus a total | optional `cardCode`, `overdueOnly`, `limit` | `limit` |
| `get_stock_by_warehouse` | In stock, committed, ordered and available per warehouse for one item | `itemCode`, optional `warehouseCode`, `includeEmpty` | all warehouses of one item |
| `run_saved_query` | Result of a query pre-registered by an administrator | `name`, `params`, `limit` | `min(limit, query maxRows)` |

Every tool is annotated `readOnlyHint: true`, `destructiveHint: false`.

### Field whitelists

The `fields` input only accepts names from these lists, so the model cannot pull other columns:

- **Business partners:** CardCode, CardName, CardType, GroupCode, Phone1, EmailAddress, City, Country, Currency, FederalTaxID, Valid, Frozen
- **Balance:** CardCode, CardName, Currency, CurrentAccountBalance, OpenOrdersBalance, OpenDeliveryNotesBalance, CreditLimit
- **Items:** ItemCode, ItemName, ItemsGroupCode, BarCode, InventoryItem, SalesItem, PurchaseItem, InventoryUOM, QuantityOnStock, QuantityOrderedFromVendors, QuantityOrderedByCustomers, Valid, Frozen
- **Documents (orders, invoices):** DocEntry, DocNum, CardCode, CardName, NumAtCard, DocDate, DocDueDate, DocTotal, DocCurrency, PaidToDate, DocumentStatus

Edit the lists in `src/server.ts` to fit your company.

## Quick start (no SAP needed)

```bash
npx -y @kodenova/sap-b1-mcp        # with SAPB1_MOCK=1 in the environment
```

Or from source:

```bash
git clone https://github.com/kodenova/sap-b1-mcp.git
cd sap-b1-mcp
npm install
npm run build
npm test                           # runs in mock mode, no SAP needed
SAPB1_MOCK=1 node dist/index.js    # stdio MCP server on demo data
```

Requires Node.js 18.17 or later.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SAPB1_SERVICE_LAYER_URL` | yes | Service Layer base URL, e.g. `https://b1server:50000/b1s/v1` |
| `SAPB1_COMPANY_DB` | yes | Company database / schema name |
| `SAPB1_USERNAME` | yes | Dedicated read-only B1 user (see Security) |
| `SAPB1_PASSWORD` | yes | Password of that user. Never logged, redacted from errors |
| `SAPB1_ALLOW_SELF_SIGNED` | no | `true` to accept a self-signed TLS certificate. Off by default |
| `SAPB1_ALLOW_HTTP` | no | `true` to allow a plain `http://` URL. Only for a local test system |
| `SAPB1_MAX_ROWS` | no | Maximum rows any tool may return. Default 50, hard cap 500 |
| `SAPB1_TIMEOUT_MS` | no | Per-request timeout. Default 30000 |
| `SAPB1_SAVED_QUERIES_FILE` | no | Path to your saved-queries JSON (see below) |
| `SAPB1_LOG_LEVEL` | no | `debug`, `info` (default), `warn`, `error`, `silent`. Logs go to stderr |
| `SAPB1_MOCK` | no | `true` / `1` to use the bundled fixtures instead of SAP |

See `.env.example`.

## Client setup

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "sap-b1": {
      "command": "npx",
      "args": ["-y", "@kodenova/sap-b1-mcp"],
      "env": {
        "SAPB1_SERVICE_LAYER_URL": "https://b1server:50000/b1s/v1",
        "SAPB1_COMPANY_DB": "SBODEMOUS",
        "SAPB1_USERNAME": "mcp_readonly",
        "SAPB1_PASSWORD": "your-password",
        "SAPB1_MAX_ROWS": "50"
      }
    }
  }
}
```

To try it without SAP, replace the `env` block with `{ "SAPB1_MOCK": "1" }`. On Windows, if `npx` is not found, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@kodenova/sap-b1-mcp"]`.

### Claude Code

```bash
claude mcp add sap-b1 \
  -e SAPB1_SERVICE_LAYER_URL=https://b1server:50000/b1s/v1 \
  -e SAPB1_COMPANY_DB=SBODEMOUS \
  -e SAPB1_USERNAME=mcp_readonly \
  -e SAPB1_PASSWORD=your-password \
  -- npx -y @kodenova/sap-b1-mcp
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`, with the password prompted instead of stored:

```json
{
  "inputs": [
    { "type": "promptString", "id": "sapb1-password", "description": "SAP B1 password", "password": true }
  ],
  "servers": {
    "sap-b1": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kodenova/sap-b1-mcp"],
      "env": {
        "SAPB1_SERVICE_LAYER_URL": "https://b1server:50000/b1s/v1",
        "SAPB1_COMPANY_DB": "SBODEMOUS",
        "SAPB1_USERNAME": "mcp_readonly",
        "SAPB1_PASSWORD": "${input:sapb1-password}"
      }
    }
  }
}
```

### Cursor, Windsurf and other stdio clients

Use the same `command`, `args` and `env` as the Claude Desktop example in the client's MCP config file (for Cursor: `~/.cursor/mcp.json` or `.cursor/mcp.json`).

### ChatGPT and other remote-only clients

ChatGPT connects to **remote** MCP servers over HTTPS; it does not launch local stdio processes. This package is a stdio server, so for ChatGPT you need to host it behind an MCP stdio-to-HTTP bridge on a server you control, with HTTPS and authentication in front of it. Do not expose an unauthenticated endpoint that holds your SAP credentials. If you want a hosted, authenticated HTTP version, see the footer.

## Saved queries (`run_saved_query`)

The model cannot send SQL or OData filters. It can only pick a query by name from a JSON file you control and pass the typed parameters that query declares. Copy `config/saved-queries.example.json` to `config/saved-queries.json` and point `SAPB1_SAVED_QUERIES_FILE` at it.

Two kinds are supported:

```json
{
  "queries": {
    "customers_over_balance": {
      "kind": "odata",
      "description": "Customers whose account balance is above a threshold",
      "resource": "BusinessPartners",
      "select": ["CardCode", "CardName", "CurrentAccountBalance"],
      "filter": { "and": [
        { "field": "CardType", "op": "eq", "value": "cCustomer" },
        { "field": "CurrentAccountBalance", "op": "gt", "value": { "param": "minBalance" } }
      ]},
      "orderBy": "CurrentAccountBalance desc",
      "maxRows": 100,
      "params": { "minBalance": { "type": "number", "default": 0 } }
    },
    "sales_by_month": {
      "kind": "sqlquery",
      "description": "Net A/R sales per month for a year",
      "sqlCode": "KN_SALES_BY_MONTH",
      "params": { "year": { "type": "integer", "required": true } }
    }
  }
}
```

- `odata` queries run against a Service Layer entity set with a fixed `$select` and a structured filter. Parameter values are type-checked (`string`, `number`, `integer`, `date`, `boolean`) and escaped; field names are validated.
- `sqlquery` queries run a `SQLQueries` entry that your administrator already created in Service Layer (`POST SQLQueries('code')/List` with a `ParamList`). Service Layer only accepts `SELECT` statements there. This server cannot create or change `SQLQueries` entries.

## Security

- **No write path.** The client-side guard (`assertReadOnly` in `src/serviceLayer.ts`) blocks `PATCH`, `PUT`, `DELETE` and every `POST` except `Login`, `Logout` and `SQLQueries('…')/List`, before any request is sent. Tests cover this.
- **Use a dedicated least-privilege B1 user.** Create a separate user (for example `mcp_readonly`) for this server. Do not use `manager` or a superuser. In *Administration → System Initialization → Authorizations → General Authorizations*, set:
  - *Read Only* for Business Partner Master Data, Item Master Data, Sales A/R (Orders, A/R Invoices) and Inventory reports you want exposed
  - *No Authorization* for everything else, including Administration, Banking, Financials and all purchasing or posting screens you do not need

  The server is read-only on its own; the B1 authorizations are your second, independent layer. Service Layer logins need a suitable B1 user license, so check the licensing with your SAP partner.
- **Credentials.** Read only from environment variables. Never written to logs. Password, `B1SESSION` and `ROUTEID` values are redacted from every error and log line. Prefer your client's secret prompt (as in the VS Code example) over storing the password in a config file.
- **TLS.** Certificate verification is on by default. `SAPB1_ALLOW_SELF_SIGNED=true` turns it off for the Service Layer host only and logs a warning. Plain `http://` is refused unless `SAPB1_ALLOW_HTTP=true`.
- **Bounded output.** Every list tool has a row limit (default 20, max `SAPB1_MAX_ROWS`, hard cap 500) and a field whitelist, so a prompt cannot dump whole tables.
- **Prompt injection.** Data returned from SAP (names, remarks) is passed to the model as data. Because the tools cannot write, a malicious record cannot make the model change your ERP through this server. Still, review what other tools you connect alongside it.
- **Logs** go to stderr, never stdout (stdout is the MCP protocol channel).

## Service Layer version notes

- Built for the Service Layer **v1 endpoint** (`/b1s/v1`), which uses OData v3-style JSON (`odata.nextLink`, `{"error":{"message":{"value":…}}}`). The client also reads the v2 (`/b1s/v2`, OData v4) `@odata.nextLink` and error format, but filters with dates are written in v1 syntax, so **v1 is the supported endpoint** for 0.1.0.
- Paging: Service Layer returns 20 rows per page by default. The server sends `Prefer: odata.maxpagesize=N` and follows `odata.nextLink` until the row limit is reached.
- Sessions: login is `POST /Login` with `CompanyDB`, `UserName` and `Password`; the `B1SESSION` (and `ROUTEID` when load-balanced) cookies are reused. When the session times out (30 minutes by default), the server logs in again once and retries. It logs out on shutdown.
- `contains()` and `startswith()` are used for search. On SAP HANA, string comparison is case-sensitive, so `search_items` with `widget` will not match `Widget`.
- `SQLQueries` (used by `sqlquery` saved queries) exists only in newer Service Layer releases. Check that `SQLQueries` appears in your `$metadata` before using that kind.
- Field names follow the standard Service Layer metadata (`BusinessPartners`, `Items`, `Orders`, `Invoices`). If your release or localization differs, adjust the whitelists in `src/server.ts`.

## Limitations

- Read-only. No document creation, approvals, payments or master-data changes.
- One company database per server process. Run several processes for several companies.
- Service Layer only. The DI API (COM) and direct database access are not used.
- No user-defined fields (UDFs) in the default whitelists. Add `U_…` fields yourself if needed.
- Search uses `contains()`, which can be slow on very large tables without suitable indexes; keep limits small.
- stdio transport only in this release. Remote clients such as ChatGPT need a bridge you host and secure.
- Tested with unit tests, the bundled fixtures and a fake Service Layer HTTP server. Validate against a test company before you point it at production.

## Development

```bash
npm install
npm run build
npm test
```

Project layout:

```
src/index.ts         stdio entry point (bin)
src/server.ts        the 9 MCP tools, schemas, whitelists
src/serviceLayer.ts  Service Layer client: login, cookies, paging, read-only guard
src/mock.ts          fixture-backed data source for SAPB1_MOCK=1
src/savedQueries.ts  saved-query config loader and parameter binding
src/odata.ts         structured filter → OData, escaping
src/redact.ts        credential redaction
fixtures/            demo data (fictional)
config/              saved-queries example
test/                vitest suites (mock mode + fake Service Layer)
```

Contributions are welcome. Please keep the server read-only: pull requests that add write endpoints will not be merged into this package.

## License

MIT © 2026 Kodenova / Zain Abbas. See [LICENSE](LICENSE).

SAP and SAP Business One are trademarks or registered trademarks of SAP SE in Germany and other countries. This project is not affiliated with, sponsored by or endorsed by SAP SE. All demo data in `fixtures/` is fictional.

---

**Built by [Kodenova](https://kodenova.com)**, an independent SAP Business One development studio that works alongside your SAP partner. Need write access, custom tools or DI API? [kodenova.com/services/mcp-server-development/](https://kodenova.com/services/mcp-server-development/)
