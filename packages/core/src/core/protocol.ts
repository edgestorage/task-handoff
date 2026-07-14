import type { Socket } from "node:net";
import { z } from "zod";

export const ResultMessageSchema = z.object({
  type: z.literal("result"),
  result: z.unknown(),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["image", "file"]),
        path: z.string(),
        name: z.string(),
        mime: z.string().optional(),
        size: z.number().nonnegative().optional(),
      }),
    )
    .optional(),
  conversationId: z.number().int().positive().optional(),
  timeoutMs: z.number().positive().optional(),
  source: z.enum(["cli", "mcp"]).optional(),
  kind: z.enum(["task", "approval"]).optional(),
  cwd: z.string().optional(),
  sessionIds: z.record(z.string(), z.string()).optional(),
});

export const ControlMessageSchema = z.discriminatedUnion("action", [
  z.object({
    type: z.literal("control"),
    action: z.literal("pending.list"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("control"),
    action: z.literal("pending.reply"),
    requestId: z.string().optional(),
    id: z.number().int().positive(),
    markdown: z.string(),
  }),
  z.object({
    type: z.literal("control"),
    action: z.literal("pending.drop"),
    requestId: z.string().optional(),
    id: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("control"),
    action: z.literal("pending.approval"),
    requestId: z.string().optional(),
    id: z.number().int().positive(),
    decision: z.enum(["allow", "deny", "skip"]),
  }),
  z.object({
    type: z.literal("control"),
    action: z.literal("receiver.message"),
    requestId: z.string().optional(),
    channel: z.string().trim().min(1).max(80),
    chatSessionId: z.string().trim().min(1).max(240),
    userId: z.string().trim().max(240).optional(),
    text: z.string().trim().min(1).max(20000),
    attachments: z.array(z.record(z.string(), z.unknown())).default([]),
    conversationId: z.number().int().positive().optional(),
  }),
]);

export const SocketMessageSchema = z.union([ResultMessageSchema, ControlMessageSchema]);

export const ReplyMessageSchema = z.object({
  type: z.literal("reply"),
  value: z.string(),
});

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const ControlResponseMessageSchema = z.object({
  type: z.literal("control.response"),
  requestId: z.string().optional(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export const ReceiverMessageSchema = z.union([ReplyMessageSchema, ErrorMessageSchema, ControlResponseMessageSchema]);

export type ControlMessage = z.infer<typeof ControlMessageSchema>;
export type ControlResponseMessage = z.infer<typeof ControlResponseMessageSchema>;

type MessageSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export function encodeMessage(message: unknown) {
  return `${JSON.stringify(message)}\n`;
}

export function decodeLines<T>(socket: Socket, schema: MessageSchema<T>, onMessage: (message: T) => void) {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = schema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          socket.write(encodeMessage({ type: "error", message: "Invalid message shape." }));
          continue;
        }
        onMessage(parsed.data);
      } catch (error) {
        socket.write(encodeMessage({ type: "error", message: "Invalid JSON message." }));
      }
    }
  });
}
