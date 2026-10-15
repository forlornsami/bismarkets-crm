import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@shared": path.resolve(import.meta.dirname, "src/shared") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Integration suites share one MySQL database, so they run one file at a time.
    fileParallelism: false,
  },
});
