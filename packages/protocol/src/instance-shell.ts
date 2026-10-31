import { z } from "zod";

export const INSTANCE_SHELL_PROTOCOL_VERSION = "2026-10-31";
export const INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL = `task-handoff.instance-shell.${INSTANCE_SHELL_PROTOCOL_VERSION}`;

export const INSTANCE_SHELL_CONTROL_FRAME_MAX_BYTES = 16 * 1024;
export const INSTANCE_SHELL_DATA_FRAME_MAX_BYTES = 1024 * 1024;
export const INSTANCE_SHELL_ARGV_MAX_ITEMS = 1_024;
export const INSTANCE_SHELL_ARGV_ITEM_MAX_BYTES = 64 * 1024;
export const INSTANCE_SHELL_ARGV_TOTAL_MAX_BYTES = 256 * 1024;
export const INSTANCE_SHELL_ACTIVITY_LIMIT = 8;
export const INSTANCE_SHELL_SOCKET_BACKLOG_MAX_BYTES = 16 * 1024 * 1024;
export const INSTANCE_SHELL_TERMINAL_DIMENSION_MAX = 10_000;

export const InstanceShellDataChannel = {
  Input: 0x01,
  Output: 0x02,
  Stderr: 0x03,
} as const;
export type InstanceShellDataChannel = typeof InstanceShellDataChannel[keyof typeof InstanceShellDataChannel];
export type InstanceShellDataDirection = "client-to-instance" | "instance-to-client";
export type InstanceShellMode = "interactive" | "exec";

const TerminalDimensionSchema = z.number().int().positive().max(INSTANCE_SHELL_TERMINAL_DIMENSION_MAX);
const SignalSchema = z.enum(["SIGINT", "SIGTERM"]);
const ProcessSignalSchema = z.string().regex(/^SIG[A-Z0-9]+$/);
const ErrorCodeSchema = z.string().trim().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/);

function boundedArgvSchema() {
  return z.array(z.string().max(INSTANCE_SHELL_ARGV_ITEM_MAX_BYTES)).min(1).max(INSTANCE_SHELL_ARGV_MAX_ITEMS)
    .refine((argv) => argv.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0) <= INSTANCE_SHELL_ARGV_TOTAL_MAX_BYTES, {
      message: `argv must be ${INSTANCE_SHELL_ARGV_TOTAL_MAX_BYTES} bytes or less in total.`,
    });
}

export const InstanceShellStartFrameSchema = z.object({
  type: z.literal("start"),
  mode: z.enum(["interactive", "exec"]),
  command: boundedArgvSchema().optional(),
  tty: z.boolean(),
  cols: TerminalDimensionSchema.optional(),
  rows: TerminalDimensionSchema.optional(),
}).superRefine((frame, context) => {
  if (frame.mode === "interactive") {
    if (frame.tty !== true) context.addIssue({ code: "custom", path: ["tty"], message: "Interactive shell requires a PTY." });
    if (frame.command !== undefined) context.addIssue({ code: "custom", path: ["command"], message: "Interactive shell does not accept a command." });
  } else if (!frame.command) {
    context.addIssue({ code: "custom", path: ["command"], message: "Exec requires at least one argv item." });
  }
  if ((frame.cols === undefined) !== (frame.rows === undefined)) {
    context.addIssue({ code: "custom", path: ["cols"], message: "Terminal dimensions require both cols and rows." });
  }
});

export const InstanceShellStdinCloseFrameSchema = z.object({
  type: z.literal("stdin-close"),
}).strict();

export const InstanceShellResizeFrameSchema = z.object({
  type: z.literal("resize"),
  cols: TerminalDimensionSchema,
  rows: TerminalDimensionSchema,
}).strict();

export const InstanceShellSignalFrameSchema = z.object({
  type: z.literal("signal"),
  signal: SignalSchema,
}).strict();

export const InstanceShellClientControlFrameSchema = z.discriminatedUnion("type", [
  InstanceShellStartFrameSchema,
  InstanceShellStdinCloseFrameSchema,
  InstanceShellResizeFrameSchema,
  InstanceShellSignalFrameSchema,
]);

export const InstanceShellStartedFrameSchema = z.object({
  type: z.literal("started"),
  protocolVersion: z.literal(INSTANCE_SHELL_PROTOCOL_VERSION),
  mode: z.enum(["interactive", "exec"]),
  tty: z.boolean(),
}).strict();

export const InstanceShellExitFrameSchema = z.object({
  type: z.literal("exit"),
  code: z.number().int().min(0).max(2_147_483_647).optional(),
  signal: ProcessSignalSchema.optional(),
}).superRefine((frame, context) => {
  if ((frame.code === undefined) === (frame.signal === undefined)) {
    context.addIssue({ code: "custom", message: "Exit must contain exactly one of code or signal." });
  }
});

export const InstanceShellErrorFrameSchema = z.object({
  type: z.literal("error"),
  code: ErrorCodeSchema,
  message: z.string().trim().min(1).max(500),
}).strict();

export const InstanceShellServerControlFrameSchema = z.discriminatedUnion("type", [
  InstanceShellStartedFrameSchema,
  InstanceShellExitFrameSchema,
  InstanceShellErrorFrameSchema,
]);

export const InstanceShellCapabilitiesSchema = z.object({
  protocolVersion: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  interactive: z.boolean(),
  exec: z.boolean(),
  execTty: z.boolean(),
});

export type InstanceShellStartFrame = z.infer<typeof InstanceShellStartFrameSchema>;
export type InstanceShellStdinCloseFrame = z.infer<typeof InstanceShellStdinCloseFrameSchema>;
export type InstanceShellResizeFrame = z.infer<typeof InstanceShellResizeFrameSchema>;
export type InstanceShellSignalFrame = z.infer<typeof InstanceShellSignalFrameSchema>;
export type InstanceShellClientControlFrame = z.infer<typeof InstanceShellClientControlFrameSchema>;
export type InstanceShellStartedFrame = z.infer<typeof InstanceShellStartedFrameSchema>;
export type InstanceShellExitFrame = z.infer<typeof InstanceShellExitFrameSchema>;
export type InstanceShellErrorFrame = z.infer<typeof InstanceShellErrorFrameSchema>;
export type InstanceShellServerControlFrame = z.infer<typeof InstanceShellServerControlFrameSchema>;
export type InstanceShellCapabilities = z.infer<typeof InstanceShellCapabilitiesSchema>;

export function unsupportedInstanceShellCapabilities(): InstanceShellCapabilities {
  return {
    protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
    interactive: false,
    exec: false,
    execTty: false,
  };
}

export class InstanceShellProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstanceShellProtocolError";
    this.code = code;
  }
}

function parseControlJson(text: string, errorCode: string) {
  if (Buffer.byteLength(text, "utf8") > INSTANCE_SHELL_CONTROL_FRAME_MAX_BYTES) {
    throw new InstanceShellProtocolError(errorCode, "Instance shell control frame is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InstanceShellProtocolError(errorCode, "Instance shell control frame is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InstanceShellProtocolError(errorCode, "Instance shell control frame must be a JSON object.");
  }
  return value;
}

export function parseInstanceShellClientControlFrame(text: string): InstanceShellClientControlFrame {
  const result = InstanceShellClientControlFrameSchema.safeParse(parseControlJson(text, "INSTANCE_SHELL_PROTOCOL_ERROR"));
  if (!result.success) {
    throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell client control frame is invalid.");
  }
  return result.data;
}

export function parseInstanceShellServerControlFrame(text: string): InstanceShellServerControlFrame {
  const result = InstanceShellServerControlFrameSchema.safeParse(parseControlJson(text, "INSTANCE_SHELL_PROTOCOL_ERROR"));
  if (!result.success) {
    throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell server control frame is invalid.");
  }
  return result.data;
}

function asBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function encodeInstanceShellBinaryFrame(channel: InstanceShellDataChannel, payload: Uint8Array): Uint8Array {
  if (payload.byteLength === 0) {
    throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell data payload must not be empty.");
  }
  if (payload.byteLength > INSTANCE_SHELL_DATA_FRAME_MAX_BYTES) {
    throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell data payload is too large.");
  }
  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = channel;
  frame.set(payload, 1);
  return frame;
}

export function decodeInstanceShellBinaryFrame(
  value: ArrayBuffer | ArrayBufferView,
  direction: InstanceShellDataDirection,
): { channel: InstanceShellDataChannel; payload: Uint8Array } {
  const bytes = asBytes(value);
  if (bytes.byteLength <= 1) {
    throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell data payload must not be empty.");
  }
  if (bytes.byteLength - 1 > INSTANCE_SHELL_DATA_FRAME_MAX_BYTES) {
    throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell data payload is too large.");
  }
  const channel = bytes[0];
  const allowed = direction === "client-to-instance"
    ? channel === InstanceShellDataChannel.Input
    : channel === InstanceShellDataChannel.Output || channel === InstanceShellDataChannel.Stderr;
  if (!allowed) {
    throw new InstanceShellProtocolError("INSTANCE_SHELL_PROTOCOL_ERROR", "Instance shell binary frame uses an invalid channel for its direction.");
  }
  return {
    channel: channel as InstanceShellDataChannel,
    payload: bytes.subarray(1),
  };
}
