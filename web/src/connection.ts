import type { ClientMessage, ServerEvent } from "@shadow-run/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { initialState, reduce } from "./state";

const RETRY_MS = [500, 1000, 2000, 4000];

/** The table's state, kept current from the server's WebSocket, which is reopened whenever it drops. */
export function useTable(url: string) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        dispatch({ type: "connection", connected: true, attempt: 0 });
      };
      ws.onmessage = (message) => dispatch({ type: "server", event: JSON.parse(String(message.data)) as ServerEvent });
      ws.onclose = () => {
        if (closed) return;
        attempt += 1;
        dispatch({ type: "connection", connected: false, attempt });
        timer = setTimeout(open, RETRY_MS[Math.min(attempt - 1, RETRY_MS.length - 1)]);
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, [url]);

  const send = useCallback((message: ClientMessage) => {
    dispatch({ type: "acted" });
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  return { state, send };
}
