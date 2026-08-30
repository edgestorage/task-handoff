import { z } from "zod";
export { BrowserAccessHandshakeSchema, type BrowserAccessHandshake } from "./browser-access.ts";

export const BROWSER_TUNNEL_PROTOCOL_VERSION = "2026-08-29";
export const BROWSER_TUNNEL_FRAME_HEADER_BYTES = 9;
export const BROWSER_TUNNEL_INITIAL_WINDOW_BYTES = 256 * 1024;
export const BROWSER_TUNNEL_MAX_DATA_BYTES = 64 * 1024;
export const BROWSER_TUNNEL_MAX_CONTROL_BYTES = 4 * 1024;
export const BROWSER_TUNNEL_MAX_WINDOW_BYTES = 16 * 1024 * 1024;

export const BrowserTunnelFrameType = {
  Open: 1,
  OpenOk: 2,
  Data: 3,
  HalfClose: 4,
  Close: 5,
  Error: 6,
  WindowUpdate: 7,
} as const;

export type BrowserTunnelFrameTypeValue = typeof BrowserTunnelFrameType[keyof typeof BrowserTunnelFrameType];

const BrowserTunnelHostSchema = z.string().trim().min(1).max(255).refine(
  (value) => !/[\s/?#@\\\[\]]/.test(value) && !value.includes("\0"),
  "Browser tunnel host must be a hostname or unbracketed IP literal.",
);

export const BrowserTunnelHelloSchema = z.object({
  type: z.literal("browser-tunnel.hello"),
  protocolVersion: z.literal(BROWSER_TUNNEL_PROTOCOL_VERSION),
  initialWindowBytes: z.number().int().positive().max(BROWSER_TUNNEL_MAX_WINDOW_BYTES),
}).strict();

export const BrowserTunnelReadySchema = z.object({
  type: z.literal("browser-tunnel.ready"),
  protocolVersion: z.literal(BROWSER_TUNNEL_PROTOCOL_VERSION),
  initialWindowBytes: z.number().int().positive().max(BROWSER_TUNNEL_MAX_WINDOW_BYTES),
}).strict();

export const BrowserTunnelOpenPayloadSchema = z.object({
  host: BrowserTunnelHostSchema,
  port: z.number().int().min(1).max(65535),
}).strict();

export const BrowserTunnelErrorCodeSchema = z.enum([
  "BROWSER_TUNNEL_PROTOCOL_ERROR",
  "BROWSER_TUNNEL_STREAM_LIMIT",
  "BROWSER_TUNNEL_CONNECT_FAILED",
  "BROWSER_TUNNEL_CONNECT_TIMEOUT",
  "BROWSER_TUNNEL_FLOW_CONTROL",
  "BROWSER_TUNNEL_IDLE_TIMEOUT",
  "BROWSER_TUNNEL_CLOSED",
]);

export const BrowserTunnelErrorPayloadSchema = z.object({
  code: BrowserTunnelErrorCodeSchema,
  message: z.string().trim().min(1).max(2048),
}).strict();

export type BrowserTunnelHello = z.infer<typeof BrowserTunnelHelloSchema>;
export type BrowserTunnelReady = z.infer<typeof BrowserTunnelReadySchema>;
export type BrowserTunnelOpenPayload = z.infer<typeof BrowserTunnelOpenPayloadSchema>;
export type BrowserTunnelErrorPayload = z.infer<typeof BrowserTunnelErrorPayloadSchema>;

export type BrowserTunnelFrame = {
  type: BrowserTunnelFrameTypeValue;
  streamId: number;
  payload: Buffer;
};

const FRAME_TYPES = new Set<number>(Object.values(BrowserTunnelFrameType));

export function encodeBrowserTunnelHello(initialWindowBytes = BROWSER_TUNNEL_INITIAL_WINDOW_BYTES) {
  return JSON.stringify(BrowserTunnelHelloSchema.parse({
    type: "browser-tunnel.hello",
    protocolVersion: BROWSER_TUNNEL_PROTOCOL_VERSION,
    initialWindowBytes,
  }));
}

export function encodeBrowserTunnelReady(initialWindowBytes = BROWSER_TUNNEL_INITIAL_WINDOW_BYTES) {
  return JSON.stringify(BrowserTunnelReadySchema.parse({
    type: "browser-tunnel.ready",
    protocolVersion: BROWSER_TUNNEL_PROTOCOL_VERSION,
    initialWindowBytes,
  }));
}

export function encodeBrowserTunnelFrame(frame: BrowserTunnelFrame) {
  assertFrame(frame);
  const output = Buffer.allocUnsafe(BROWSER_TUNNEL_FRAME_HEADER_BYTES + frame.payload.byteLength);
  output.writeUInt8(frame.type, 0);
  output.writeUInt32BE(frame.streamId, 1);
  output.writeUInt32BE(frame.payload.byteLength, 5);
  frame.payload.copy(output, BROWSER_TUNNEL_FRAME_HEADER_BYTES);
  return output;
}

export function decodeBrowserTunnelFrame(value: Buffer | ArrayBuffer | ArrayBufferView): BrowserTunnelFrame {
  const input = Buffer.isBuffer(value)
    ? value
    : value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (input.byteLength < BROWSER_TUNNEL_FRAME_HEADER_BYTES) throw protocolError("Browser tunnel frame header is truncated.");
  const type = input.readUInt8(0);
  const streamId = input.readUInt32BE(1);
  const payloadLength = input.readUInt32BE(5);
  if (!FRAME_TYPES.has(type)) throw protocolError("Browser tunnel frame type is unknown.");
  if (streamId === 0) throw protocolError("Browser tunnel stream id must be positive.");
  if (payloadLength !== input.byteLength - BROWSER_TUNNEL_FRAME_HEADER_BYTES) throw protocolError("Browser tunnel frame length is invalid.");
  const frame = { type: type as BrowserTunnelFrameTypeValue, streamId, payload: input.subarray(BROWSER_TUNNEL_FRAME_HEADER_BYTES) };
  assertFrame(frame);
  return frame;
}

export function encodeBrowserTunnelOpen(streamId: number, input: BrowserTunnelOpenPayload) {
  return encodeBrowserTunnelFrame({
    type: BrowserTunnelFrameType.Open,
    streamId,
    payload: Buffer.from(JSON.stringify(BrowserTunnelOpenPayloadSchema.parse(input))),
  });
}

export function decodeBrowserTunnelOpen(frame: BrowserTunnelFrame) {
  requireFrameType(frame, BrowserTunnelFrameType.Open);
  return BrowserTunnelOpenPayloadSchema.parse(parseJsonPayload(frame.payload));
}

export function encodeBrowserTunnelError(streamId: number, input: BrowserTunnelErrorPayload) {
  return encodeBrowserTunnelFrame({
    type: BrowserTunnelFrameType.Error,
    streamId,
    payload: Buffer.from(JSON.stringify(BrowserTunnelErrorPayloadSchema.parse(input))),
  });
}

export function decodeBrowserTunnelError(frame: BrowserTunnelFrame) {
  requireFrameType(frame, BrowserTunnelFrameType.Error);
  return BrowserTunnelErrorPayloadSchema.parse(parseJsonPayload(frame.payload));
}

export function encodeBrowserTunnelWindowUpdate(streamId: number, bytes: number) {
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > BROWSER_TUNNEL_MAX_WINDOW_BYTES) throw protocolError("Browser tunnel window update is invalid.");
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt32BE(bytes);
  return encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.WindowUpdate, streamId, payload });
}

export function decodeBrowserTunnelWindowUpdate(frame: BrowserTunnelFrame) {
  requireFrameType(frame, BrowserTunnelFrameType.WindowUpdate);
  if (frame.payload.byteLength !== 4) throw protocolError("Browser tunnel window update payload is invalid.");
  const bytes = frame.payload.readUInt32BE(0);
  if (bytes <= 0 || bytes > BROWSER_TUNNEL_MAX_WINDOW_BYTES) throw protocolError("Browser tunnel window update is outside the allowed range.");
  return bytes;
}

function assertFrame(frame: BrowserTunnelFrame) {
  if (!FRAME_TYPES.has(frame.type)) throw protocolError("Browser tunnel frame type is unknown.");
  if (!Number.isInteger(frame.streamId) || frame.streamId <= 0 || frame.streamId > 0xffffffff) throw protocolError("Browser tunnel stream id is invalid.");
  if (!Buffer.isBuffer(frame.payload)) throw protocolError("Browser tunnel frame payload must be binary.");
  const control = frame.type !== BrowserTunnelFrameType.Data;
  const maxBytes = control ? BROWSER_TUNNEL_MAX_CONTROL_BYTES : BROWSER_TUNNEL_MAX_DATA_BYTES;
  if (frame.payload.byteLength > maxBytes) throw protocolError("Browser tunnel frame payload exceeds the allowed size.");
  if ([BrowserTunnelFrameType.OpenOk, BrowserTunnelFrameType.HalfClose, BrowserTunnelFrameType.Close].includes(frame.type as 2 | 4 | 5) && frame.payload.byteLength !== 0) {
    throw protocolError("Browser tunnel control frame payload must be empty.");
  }
}

function requireFrameType(frame: BrowserTunnelFrame, expected: BrowserTunnelFrameTypeValue) {
  if (frame.type !== expected) throw protocolError("Browser tunnel frame has an unexpected type.");
}

function parseJsonPayload(payload: Buffer) {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    throw protocolError("Browser tunnel control payload is not valid JSON.");
  }
}

function protocolError(message: string) {
  return Object.assign(new Error(message), { code: "BROWSER_TUNNEL_PROTOCOL_ERROR" });
}
