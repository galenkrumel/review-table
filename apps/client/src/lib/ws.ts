// Typed WebSocket client. Sends ClientMessage, receives ServerMessage (JSON) or
// binary audio frames (handled in M2). Keys never reach the browser — the server
// proxies all provider traffic (NFR-3).

import type { ClientMessage, ServerMessage } from "@review-table/contracts";
import { useEffect, useRef, useState } from "react";

// Same-origin: in dev, Vite proxies /ws to the API server (whatever port it picked);
// in prod the server serves the client directly. No host:port hardcoded here.
// VITE_WS_URL can override for non-proxied setups.
const WS_URL =
  import.meta.env.VITE_WS_URL ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export type ConnStatus = "connecting" | "open" | "closed";

export interface ReviewSocket {
  status: ConnStatus;
  send: (msg: ClientMessage) => void;
  sendBinary: (data: ArrayBuffer | Blob) => void;
  lastMessage: ServerMessage | null;
}

export function useReviewSocket(
  onMessage?: (msg: ServerMessage) => void,
  onBinary?: (data: ArrayBuffer) => void,
): ReviewSocket {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  const binaryRef = useRef(onBinary);
  binaryRef.current = onBinary;

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => setStatus("open");
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => setStatus("closed");
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        binaryRef.current?.(ev.data as ArrayBuffer); // streamed audio frame
        return;
      }
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        setLastMessage(msg);
        handlerRef.current?.(msg);
      } catch {
        // ignore malformed frame
      }
    };

    return () => ws.close();
  }, []);

  const send = (msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // Binary path: the PTT audio clip (server batch-transcribes it). Keys never reach
  // the browser — the server owns all provider traffic (NFR-3).
  const sendBinary = (data: ArrayBuffer | Blob) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  return { status, send, sendBinary, lastMessage };
}
