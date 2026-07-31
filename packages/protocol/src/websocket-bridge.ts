export type WebSocketLike = {
  readyState: number;
  OPEN?: number;
  send: (data: unknown, options?: { binary?: boolean }) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
};

type WebSocketFrame = {
  data: unknown;
  isBinary: boolean;
};

export type WebSocketBridgeOptions = {
  pendingFrameLimit?: number;
  upstreamOpenTimeoutMs?: number;
  onUpstreamOpen?: () => void;
  onUpstreamCloseBeforeOpen?: () => boolean;
  onUpstreamErrorBeforeOpen?: (error: unknown) => boolean;
  onClientClose?: (code?: unknown, reason?: unknown) => void;
  onClientError?: (error: unknown) => void;
  onUpstreamClose?: (code?: unknown, reason?: unknown) => void;
  onUpstreamError?: (error: unknown) => void;
};

function isOpen(socket: WebSocketLike) {
  return socket.readyState === (socket.OPEN ?? 1);
}

export function normalizeWebSocketCloseReason(reason?: unknown) {
  const value = Buffer.isBuffer(reason) ? reason.toString("utf8") : typeof reason === "string" ? reason : "";
  if (Buffer.byteLength(value, "utf8") <= 123) {
    return value;
  }
  let truncated = "";
  for (const char of value) {
    const next = `${truncated}${char}`;
    if (Buffer.byteLength(next, "utf8") > 123) {
      break;
    }
    truncated = next;
  }
  return truncated;
}

export function normalizeWebSocketCloseCode(code?: unknown) {
  if (typeof code !== "number" || !Number.isInteger(code)) {
    return undefined;
  }
  if (code >= 3000 && code <= 4999) {
    return code;
  }
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) {
    return code;
  }
  return undefined;
}

export function closeWebSocket(socket: WebSocketLike, code?: unknown, reason?: unknown) {
  socket.close(normalizeWebSocketCloseCode(code), normalizeWebSocketCloseReason(reason) || undefined);
}

function sendFrame(socket: WebSocketLike, frame: WebSocketFrame) {
  socket.send(frame.data, { binary: frame.isBinary });
}

function flush(socket: WebSocketLike, frames: WebSocketFrame[]) {
  if (!isOpen(socket)) {
    return;
  }
  for (const frame of frames.splice(0)) {
    sendFrame(socket, frame);
  }
}

export function bridgeWebSockets(client: WebSocketLike, upstream: WebSocketLike, options: WebSocketBridgeOptions = {}) {
  const pendingFrameLimit = options.pendingFrameLimit ?? 256;
  let clientClosed = false;
  let upstreamOpened = isOpen(upstream);
  const pendingToUpstream: WebSocketFrame[] = [];
  const pendingToClient: WebSocketFrame[] = [];
  let openTimer: ReturnType<typeof setTimeout> | undefined;

  const clearOpenTimer = () => {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = undefined;
    }
  };
  const queue = (frames: WebSocketFrame[], frame: WebSocketFrame) => {
    if (frames.length >= pendingFrameLimit) {
      closeWebSocket(client, 1011, "WebSocket bridge pending frame limit exceeded.");
      closeWebSocket(upstream, 1011, "WebSocket bridge pending frame limit exceeded.");
      return;
    }
    frames.push(frame);
  };

  if (options.upstreamOpenTimeoutMs && !upstreamOpened) {
    openTimer = setTimeout(() => {
      if (!upstreamOpened && !clientClosed) {
        closeWebSocket(client, 1011, "Upstream websocket did not open.");
        closeWebSocket(upstream);
      }
    }, options.upstreamOpenTimeoutMs);
  }

  client.on("open", () => flush(client, pendingToClient));
  upstream.on("open", () => {
    clearOpenTimer();
    upstreamOpened = true;
    options.onUpstreamOpen?.();
    flush(upstream, pendingToUpstream);
  });
  client.on("message", (message, isBinary = false) => {
    const frame = { data: message, isBinary: Boolean(isBinary) };
    if (isOpen(upstream)) {
      sendFrame(upstream, frame);
      return;
    }
    queue(pendingToUpstream, frame);
  });
  upstream.on("message", (message, isBinary = false) => {
    const frame = { data: message, isBinary: Boolean(isBinary) };
    if (isOpen(client)) {
      sendFrame(client, frame);
      return;
    }
    queue(pendingToClient, frame);
  });
  upstream.on("close", (code, reason) => {
    clearOpenTimer();
    options.onUpstreamClose?.(code, reason);
    if (!upstreamOpened && !clientClosed && options.onUpstreamCloseBeforeOpen?.()) {
      return;
    }
    closeWebSocket(client, code, reason);
  });
  upstream.on("error", (error) => {
    options.onUpstreamError?.(error);
    if (!upstreamOpened && !clientClosed && options.onUpstreamErrorBeforeOpen?.(error)) {
      return;
    }
    closeWebSocket(client);
  });
  client.on("close", (code, reason) => {
    clearOpenTimer();
    clientClosed = true;
    options.onClientClose?.(code, reason);
    closeWebSocket(upstream, code, reason);
  });
  client.on("error", (error) => {
    clearOpenTimer();
    clientClosed = true;
    options.onClientError?.(error);
    closeWebSocket(upstream, 1011, "WebSocket bridge client failed.");
  });

  return {
    close: (code?: number, reason?: string) => {
      clearOpenTimer();
      closeWebSocket(upstream, code, reason);
      closeWebSocket(client, code, reason);
    },
  };
}
