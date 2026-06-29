// Server bootstrap: HTTP server + WebSocket endpoint. Owns provider keys (read from
// env only, NFR-3) and all orchestration. M0 wires the live link and a stub session.

import { createServer } from "node:http";
import type { ClientMessage } from "@review-table/contracts";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { ANTHROPIC_MODEL, DIRECTOR_MODEL, providerStatus } from "./env";
import { Session } from "./session";

const PORT = Number(process.env.PORT ?? 8787);

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  console.log("[ws] client connected");
  const session = new Session(ws);

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      session.handleBinary(data as Buffer);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      console.warn("[ws] dropped non-JSON text frame");
      return;
    }
    session.handleMessage(msg);
  });

  ws.on("close", () => {
    console.log("[ws] client disconnected");
    session.close(); // stop any running review loop cleanly (don't orphan it)
  });
  ws.on("error", (err) => console.error("[ws] socket error", err));
});

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[server] port ${PORT} is already in use. Set PORT to a free port, or start via ` +
        `\`pnpm dev\` which picks a free port automatically.`,
    );
    process.exit(1);
  }
  throw err;
});

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}  (ws: /ws)`);
  console.log(`[server] providers: ${providerStatus()}`);
  console.log(
    `[server] models: dogs=${ANTHROPIC_MODEL}, director=${DIRECTOR_MODEL}` +
      (DIRECTOR_MODEL !== ANTHROPIC_MODEL ? " (faster director)" : ""),
  );
});
