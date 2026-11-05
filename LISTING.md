# Directory submission text

Ready-to-paste text for directory listings. Publish the GitHub repo and the npm package first; every directory below links to them.

Repo: https://github.com/kodenova/sap-b1-mcp
npm: https://www.npmjs.com/package/@kodenova/sap-b1-mcp
Registry name: `io.github.kodenova/sap-b1-mcp`

## Shared copy

**Name:** SAP Business One MCP (read-only)

**One-line description (under 100 characters):**
Read-only SAP Business One Service Layer tools: partners, items, orders, invoices, stock.

**Short description (about 50 words):**
Open-source MCP server that gives AI assistants read-only access to SAP Business One through the Service Layer. Nine typed tools cover business partners, items, open sales orders, open A/R invoices, customer balances, stock by warehouse and admin-registered saved queries. No write endpoints, field whitelists, row limits, credential redaction and a mock mode.

**Tags:** sap-business-one, sap-b1, erp, service-layer, odata, read-only, finance, inventory, accounting, typescript

**Language / transport:** TypeScript, Node.js 18.17+, stdio

**License:** MIT

**Trademark line (include where there is a free-text field):**
SAP and SAP Business One are trademarks of SAP SE; this project is independent and not affiliated with or endorsed by SAP SE.

## Glama (glama.ai/mcp/servers)

- Submit: use "Add Server" on glama.ai/mcp/servers with the GitHub URL.
- Category: Finance / ERP (if no ERP category, use "Developer Tools" or "Business").
- Description: use the short description above.
- Glama builds the repo with the included `Dockerfile`, which starts in mock mode, so tool introspection works without SAP credentials.
- To claim ownership after it is listed, add a `glama.json` to the repo root:
  ```json
  { "$schema": "https://glama.ai/mcp/schemas/server.json", "maintainers": ["<your-github-username>"] }
  ```

## mcp.so

- Submit: the "Submit" link on mcp.so (it opens a form or a GitHub issue on the mcp.so repo).
- Name: SAP Business One MCP (read-only)
- URL: https://github.com/kodenova/sap-b1-mcp
- Category: Finance (or "Other" / "Productivity" if Finance is not offered)
- Description: use the short description above.
- Tags: use the tag list above.
- Server config to paste if asked:
  ```json
  {
    "mcpServers": {
      "sap-b1": {
        "command": "npx",
        "args": ["-y", "@kodenova/sap-b1-mcp"],
        "env": {
          "SAPB1_SERVICE_LAYER_URL": "https://b1server:50000/b1s/v1",
          "SAPB1_COMPANY_DB": "YOUR_COMPANY_DB",
          "SAPB1_USERNAME": "mcp_readonly",
          "SAPB1_PASSWORD": "your-password"
        }
      }
    }
  }
  ```

## awesome-mcp-servers (github.com/punkpeye/awesome-mcp-servers)

- Fork, add one line in alphabetical order under the best-fitting existing section. Check the current README for section names: use "Finance & Fintech" if present; otherwise "Workplace & Productivity".
- Line to add (the emoji markers follow that list's legend: TypeScript, local service, Windows, macOS, Linux):
  ```markdown
  - [kodenova/sap-b1-mcp](https://github.com/kodenova/sap-b1-mcp) 📇 🏠 🪟 🍎 🐧 - Read-only SAP Business One Service Layer access: business partners, items, open orders and invoices, customer balances, stock by warehouse and admin-registered saved queries. No write endpoints.
  ```
- PR title: `Add kodenova/sap-b1-mcp (read-only SAP Business One server)`
- PR body:
  ```
  Adds sap-b1-mcp, an MIT-licensed, read-only MCP server for SAP Business One via the Service Layer.
  - 9 typed tools, field whitelists, row limits
  - no write endpoints (client-side guard + least-privilege user guidance)
  - mock mode with fixtures, vitest suite
  - published to npm as @kodenova/sap-b1-mcp and to the MCP Registry as io.github.kodenova/sap-b1-mcp
  ```

## Wording rules for every listing

- Do not write "SAP partner", "certified", "official" or "endorsed by SAP".
- Do not cite customer names or usage numbers.
- "Independent SAP Business One development studio" is the approved description of Kodenova.
