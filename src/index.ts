#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { MockDataSource } from "./mock.js";
import { redact } from "./redact.js";
import { loadSavedQueries } from "./savedQueries.js";
import { createServer } from "./server.js";
import { ServiceLayerClient } from "./serviceLayer.js";
import type { DataSource } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const data: DataSource = config.mock ? new MockDataSource() : new ServiceLayerClient(config);
  const savedQueries = loadSavedQueries(config.savedQueriesFile, config.mock);
  const server = createServer({ config, data, savedQueries });

  log.info(
    config.mock
      ? "Starting in MOCK mode (fixture data, no SAP connection)."
      : `Starting against ${config.serviceLayerUrl} (read-only tools only).`,
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await data.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log.error(`Fatal: ${redact(e)}`);
  process.exit(1);
});
