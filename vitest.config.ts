import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: { SAPB1_MOCK: "1", SAPB1_LOG_LEVEL: "silent" },
  },
});
