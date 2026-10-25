import type WebSocket from "ws";

/**
 * `ws` emits an `error` event when a socket is closed before its connection is
 * established. Waiters remove their temporary listeners on timeout, so keep a
 * lifecycle listener attached until the socket is collected; otherwise that
 * expected transport failure becomes an uncaught EventEmitter error.
 */
export function observeRelaySocketErrors(socket: WebSocket) {
  socket.on("error", () => undefined);
}
