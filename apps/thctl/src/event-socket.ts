import WebSocket from "ws";

/**
 * 事件流 socket 的最小契约。命令层只依赖这几个回调，测试可以注入脚本化实现，
 * 不需要真的起 WebSocket 服务。
 */
export type CliEventSocketHandlers = {
  opened: () => void;
  message: (data: string) => void;
  closed: (info: { code: number; reason: string }) => void;
  failed: (error: Error) => void;
  /** WebSocket upgrade 被 HTTP 拒绝（非 101）；只有状态码是权威信息。 */
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

function decodeFrame(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

/** Node 内置 WebSocket 不能设置 Authorization 头，因此事件流固定使用 `ws`。 */
export const createControlPlaneEventSocket: CliEventSocketFactory = ({ url, authorization, handlers }) => {
  const socket = new WebSocket(url, { headers: { authorization } });
  socket.on("open", () => handlers.opened());
  socket.on("message", (data) => handlers.message(decodeFrame(data)));
  socket.on("close", (code, reason) => handlers.closed({ code, reason: reason?.toString("utf8") ?? "" }));
  socket.on("error", (error) => handlers.failed(error instanceof Error ? error : new Error(String(error))));
  socket.on("unexpected-response", (_request, response) => {
    const statusCode = response.statusCode ?? 0;
    response.resume();
    handlers.rejected(statusCode);
  });
  return {
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
