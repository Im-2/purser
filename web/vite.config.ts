import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig(({ mode }) => {
  // Only PORT is read from the repo .env, to find the backend. Nothing from .env is exposed to the browser bundle.
  const port = loadEnv(mode, repoRoot, "").PORT || "8799";
  const backend = `http://127.0.0.1:${port}`;
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        // /api includes the SSE stream at /api/events
        "/api": { target: backend, changeOrigin: false },
        "/health": { target: backend, changeOrigin: false },
      },
    },
    preview: { host: "127.0.0.1", port: 4173 },
    build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
  };
});
