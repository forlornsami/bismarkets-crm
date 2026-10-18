import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// pdf.js loads a few helper files by name while it draws a PDF: JavaScript
// image decoders for scanned pages (JBIG2, JPEG 2000), CMaps for Asian fonts
// and the standard fonts. They are served by the CRM itself under /pdfjs/,
// never from a CDN, and only fetched when a document needs them.
const PDFJS = path.resolve(import.meta.dirname, "node_modules/pdfjs-dist");
function pdfjsFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"]) files.set(`pdfjs/decoders/${name}`, path.join(PDFJS, "wasm", name));
  for (const dir of ["cmaps", "standard_fonts"]) {
    for (const name of readdirSync(path.join(PDFJS, dir))) if (!name.startsWith("LICENSE")) files.set(`pdfjs/${dir}/${name}`, path.join(PDFJS, dir, name));
  }
  return files;
}

function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      const files = pdfjsFiles();
      server.middlewares.use((req, res, next) => {
        const file = files.get((req.url ?? "").split("?")[0]!.replace(/^\//, ""));
        if (!file) return next();
        res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [fileName, file] of pdfjsFiles()) this.emitFile({ type: "asset", fileName, source: readFileSync(file) });
    },
  };
}

export default defineConfig({
  base: "/",
  root: path.resolve(import.meta.dirname, "src/admin"),
  plugins: [react(), pdfjsAssets()],
  resolve: {
    alias: { "@shared": path.resolve(import.meta.dirname, "src/shared") },
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  build: { outDir: path.resolve(import.meta.dirname, "dist/admin"), emptyOutDir: true, sourcemap: false },
});
