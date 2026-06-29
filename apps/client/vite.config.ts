import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API server port is chosen at launch by scripts/dev.mjs and passed in as
// API_PORT (falls back to PORT, then 8787 for a standalone `vite` run). The browser
// talks to the server through these same-origin proxies, so no host:port is ever
// hardcoded in browser code. `strictPort: false` lets Vite walk to the next free UI
// port instead of failing when 5173 is taken.
const apiPort = process.env.API_PORT ?? process.env.PORT ?? "8787";
const apiTarget = `http://localhost:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/ws": { target: apiTarget, ws: true },
      "/health": { target: apiTarget },
    },
  },
});
