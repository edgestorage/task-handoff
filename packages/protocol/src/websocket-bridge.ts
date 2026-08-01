export type WebSocketLike = {
  readyState: number;
  OPEN?: number;
  bufferedAmount?: number;
  send: (data: unknown, options?: { binary?: boolean }) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
};

type WebSocketFrame = {
  data: unknown;
  isBinary: boolean;
  bytes: number;
};

export type WebSocketBridgeOptions = {
  pendingFrameLimit?: number;
  maxFrameBytes?: number;
  maxTotalBytes?: number;
  maxBufferedBytes?: number;
  upstreamOpenTimeoutMs?: number;
  onUpstreamOpen?: () => void;
  onUpstreamCloseBeforeOpen?: () => boolean;
  onUpstreamErrorBeforeOpen?: (error: unknown) => boolean;
  onClientClose?: (code?: unknown, reason?: unknown) => void;
  onClientError?: (error: unknown) => void;
  onUpstreamClose?: (code?: unknown, reason?: unknown) => void;
  onUpstreamError?: (error: unknown) => void;
  onFrame?: (direction: "client-to-upstream" | "upstream-to-client", bytes: number) => void;
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

function flush(socket: WebSocketLike, frames: WebSocketFrame[], send: (frame: WebSocketFrame) => boolean, dequeued: (frame: WebSocketFrame) => void) {
  if (!isOpen(socket)) {
    return;
  }
  for (const frame of frames.splice(0)) {
    dequeued(frame);
    if (!send(frame)) return;
  }
}

export function bridgeWebSockets(client: WebSocketLike, upstream: WebSocketLike, options: WebSocketBridgeOptions = {}) {
  const pendingFrameLimit = options.pendingFrameLimit ?? 256;
  const maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;
  const maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024;
  let clientClosed = false;
  let upstreamOpened = isOpen(upstream);
  const pendingToUpstream: WebSocketFrame[] = [];
  const pendingToClient: WebSocketFrame[] = [];
  let pendingToUpstreamBytes = 0;
  let pendingToClientBytes = 0;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let totalBytes = 0;

  const frameBytes = (value: unknown) => {
    if (Buffer.isBuffer(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return Buffer.byteLength(typeof value === "string" ? value : String(value), "utf8");
  };
  const acceptFrame = (direction: "client-to-upstream" | "upstream-to-client", value: unknown) => {
    const bytes = frameBytes(value);
    totalBytes += bytes;
    options.onFrame?.(direction, bytes);
    if (bytes > maxFrameBytes || totalBytes > maxTotalBytes) {
      closeWebSocket(client, 1009, "WebSocket bridge traffic limit exceeded.");
      closeWebSocket(upstream, 1009, "WebSocket bridge traffic limit exceeded.");
      return false;
    }
    return true;
  };

  const clearOpenTimer = () => {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = undefined;
    }
  };
  const forward = (socket: WebSocketLike, frame: WebSocketFrame) => {
    const bytes = frame.bytes;
    if ((socket.bufferedAmount ?? 0) + bytes > maxBufferedBytes) {
      closeWebSocket(client, 1013, "WebSocket bridge consumer is too slow.");
      closeWebSocket(upstream, 1013, "WebSocket bridge consumer is too slow.");
      return false;
    }
    try {
      sendFrame(socket, frame);
      return true;
    } catch {
      closeWebSocket(client, 1011, "WebSocket bridge send failed.");
      closeWebSocket(upstream, 1011, "WebSocket bridge send failed.");
      return false;
    }
  };
  const queue = (direction: "upstream" | "client", frames: WebSocketFrame[], frame: WebSocketFrame) => {
    if (frames.length >= pendingFrameLimit) {
      closeWebSocket(client, 1011, "WebSocket bridge pending frame limit exceeded.");
      closeWebSocket(upstream, 1011, "WebSocket bridge pending frame limit exceeded.");
      return;
    }
    const pendingBytes = direction === "upstream" ? pendingToUpstreamBytes : pendingToClientBytes;
    const destination = direction === "upstream" ? upstream : client;
    if ((destination.bufferedAmount ?? 0) + pendingBytes + frame.bytes > maxBufferedBytes) {
      closeWebSocket(client, 1013, "WebSocket bridge consumer is too slow.");
      closeWebSocket(upstream, 1013, "WebSocket bridge consumer is too slow.");
      return;
    }
    frames.push(frame);
    if (direction === "upstream") pendingToUpstreamBytes += frame.bytes;
    else pendingToClientBytes += frame.bytes;
  };

  if (options.upstreamOpenTimeoutMs && !upstreamOpened) {
    openTimer = setTimeout(() => {
      if (!upstreamOpened && !clientClosed) {
        closeWebSocket(client, 1011, "Upstream websocket did not open.");
        closeWebSocket(upstream);
      }
    }, options.upstreamOpenTimeoutMs);
  }

  client.on("open", () => flush(client, pendingToClient, (frame) => forward(client, frame), (frame) => { pendingToClientBytes -= frame.bytes; }));
  upstream.on("open", () => {
    clearOpenTimer();
    upstreamOpened = true;
    options.onUpstreamOpen?.();
    flush(upstream, pendingToUpstream, (frame) => forward(upstream, frame), (frame) => { pendingToUpstreamBytes -= frame.bytes; });
  });
  client.on("message", (message, isBinary = false) => {
    if (!acceptFrame("client-to-upstream", message)) return;
    const frame = { data: message, isBinary: Boolean(isBinary), bytes: frameBytes(message) };
    if (isOpen(upstream)) {
      forward(upstream, frame);
      return;
    }
    queue("upstream", pendingToUpstream, frame);
  });
  upstream.on("message", (message, isBinary = false) => {
    if (!acceptFrame("upstream-to-client", message)) return;
    const frame = { data: message, isBinary: Boolean(isBinary), bytes: frameBytes(message) };
    if (isOpen(client)) {
      forward(client, frame);
      return;
    }
    queue("client", pendingToClient, frame);
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
