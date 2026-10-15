import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  root: path.resolve(import.meta.dirname, "src/admin"),
  plugins: [react()],
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
