import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as viteBuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
await viteBuild({ configFile: path.join(root, "vite.config.ts") });
const common = {
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  packages: "external",
  sourcemap: true,
  logLevel: "info",
  alias: { "@shared": path.join(root, "src/shared") },
};
await build({ ...common, entryPoints: [path.join(root, "src/server/index.ts")], outfile: path.join(dist, "server.mjs") });
await build({ ...common, entryPoints: [path.join(root, "src/cli/index.ts")], outfile: path.join(dist, "cli.mjs") });
