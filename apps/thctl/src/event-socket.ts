import WebSocket from "ws";

export type CliWebSocketData = string | Uint8Array;

export type CliWebSocketHandlers = {
  opened: () => void;
  message: (data: CliWebSocketData, isBinary: boolean) => void;
  closed: (info: { code: number; reason: string }) => void;
  failed: (error: Error) => void;
  /** WebSocket upgrade 被 HTTP 拒绝（非 101）；只有状态码是权威信息。 */
  rejected: (statusCode: number) => void;
};

export type CliWebSocket = {
  readonly bufferedAmount: number;
  send: (data: CliWebSocketData) => void;
  close: (code?: number, reason?: string) => void;
};

export type CliWebSocketFactory = (options: {
  url: string;
  authorization: string;
  subprotocols?: readonly string[];
  handlers: CliWebSocketHandlers;
}) => CliWebSocket;

/**
 * 事件流 socket 的兼容契约。事件命令只需要文本帧，因此新 binary socket
 * 在这里适配回原有单回调签名，避免事件流的重连与去重逻辑理解二进制协议。
 */
export type CliEventSocketHandlers = {
  opened: () => void;
  message: (data: string) => void;
  closed: (info: { code: number; reason: string }) => void;
  failed: (error: Error) => void;
  rejected: (statusCode: number) => void;
};

export type CliEventSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type CliEventSocketFactory = (options: {
  url: string;
  authorization: string;
  handlers: CliEventSocketHandlers;
}) => CliEventSocket;

function dataBytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.from(String(data), "utf8");
}

/** Node 内置 WebSocket 不能设置 Authorization 头，因此 CLI socket 固定使用 `ws`。 */
export const createControlPlaneWebSocket: CliWebSocketFactory = ({ url, authorization, subprotocols, handlers }) => {
  const socket = new WebSocket(url, subprotocols ? [...subprotocols] : undefined, {
    headers: { authorization },
    perMessageDeflate: false,
  });
  socket.on("open", () => handlers.opened());
  socket.on("message", (data, isBinary) => {
    handlers.message(isBinary ? dataBytes(data) : data.toString(), isBinary);
  });
  socket.on("close", (code, reason) => handlers.closed({ code, reason: reason?.toString("utf8") ?? "" }));
  socket.on("error", (error) => handlers.failed(error instanceof Error ? error : new Error(String(error))));
  socket.on("unexpected-response", (_request, response) => {
    const statusCode = response.statusCode ?? 0;
    response.resume();
    handlers.rejected(statusCode);
  });
  return {
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => {
      try {
        socket.close(code, reason);
      } catch {
        // 连接已经关闭或握手未完成；关闭失败不改变命令结果。
      }
    },
  };
};

export const createControlPlaneEventSocket: CliEventSocketFactory = ({ url, authorization, handlers }) => {
  const socket = createControlPlaneWebSocket({
    url,
    authorization,
    handlers: {
      opened: handlers.opened,
      message: (data, isBinary) => {
        handlers.message(isBinary && data instanceof Uint8Array
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
          : String(data));
      },
      closed: handlers.closed,
      failed: handlers.failed,
      rejected: handlers.rejected,
    },
  });
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
};
