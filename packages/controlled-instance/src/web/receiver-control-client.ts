import net from "node:net";
import { randomUUID } from "node:crypto";
import { ControlResponseMessageSchema, decodeLines, encodeMessage } from "@task-handoff/core/core/protocol";

type PendingTaskAction =
  | { type: "control"; action: "pending.list" }
  | { type: "control"; action: "pending.reply"; id: number; markdown: string }
  | { type: "control"; action: "pending.drop"; id: number }
  | { type: "control"; action: "pending.approval"; id: number; decision: "allow" | "deny" | "skip" }
  | {
      type: "control";
      action: "receiver.message";
      channel: string;
      chatSessionId: string;
      userId?: string;
      text: string;
      attachments?: Array<Record<string, unknown>>;
      conversationId?: number;
    };

export class ReceiverControlClient {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  pendingList() {
    return this.request({ type: "control", action: "pending.list" });
  }

  reply(id: number, markdown: string) {
    return this.request({ type: "control", action: "pending.reply", id, markdown });
  }

  drop(id: number) {
    return this.request({ type: "control", action: "pending.drop", id });
  }

  approval(id: number, decision: "allow" | "deny" | "skip") {
    return this.request({ type: "control", action: "pending.approval", id, decision });
  }

  message(input: {
    channel: string;
    chatSessionId: string;
    userId?: string;
    text: string;
    attachments?: Array<Record<string, unknown>>;
    conversationId?: number;
  }) {
    return this.request({
      type: "control",
      action: "receiver.message",
      channel: input.channel,
      chatSessionId: input.chatSessionId,
      userId: input.userId,
      text: input.text,
      attachments: input.attachments || [],
      conversationId: input.conversationId,
    });
  }

  private request(message: PendingTaskAction) {
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error("Receiver control request timed out."), { code: "RECEIVER_CONTROL_TIMEOUT" }));
      }, 5_000);

      const finish = (callback: () => void) => {
        clearTimeout(timer);
        socket.end();
        callback();
      };

      socket.once("connect", () => {
        socket.write(encodeMessage({ ...message, requestId }));
      });

      decodeLines(socket, ControlResponseMessageSchema, (response) => {
        if (response.requestId !== requestId) {
          return;
        }
        finish(() => {
          if (response.ok) {
            resolve(response.data);
          } else {
            const error = Object.assign(new Error(response.error?.message || "Receiver control request failed."), {
              code: response.error?.code || "RECEIVER_CONTROL_FAILED",
            });
            reject(error);
          }
        });
      });

      socket.once("error", (error: NodeJS.ErrnoException) => {
        finish(() => {
          reject(Object.assign(new Error(`Receiver is not available at ${this.socketPath}: ${error.message}`), { code: "RECEIVER_UNAVAILABLE" }));
        });
      });

      socket.once("close", () => {
        clearTimeout(timer);
      });
    });
  }
}
