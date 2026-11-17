import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = "http://127.0.0.1:8090";

export default defineConfig({
  plugins: [react()],
  base: "/web/",
  build: { outDir: "../web", emptyOutDir: true },
  server: { proxy: { "/api": backend, "/run_sse": backend } },
});
