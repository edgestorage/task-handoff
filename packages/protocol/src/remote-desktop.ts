import { z } from "zod";

/** Controlled-instance capability boundary. These are connection diagnostics and
 * negotiated limits, owned by the instance/component; none is persisted on a
 * node/instance record. Package and enable intent retain their existing owners.
 * The independent desktop subprotocol does not change the instance protocol. */
export const REMOTE_DESKTOP_PROTOCOL_VERSION = "2026-11-11";
/** Browser DataChannel envelope version. Independent from signaling and IPC. */
export const REMOTE_DESKTOP_CHANNEL_VERSION = "2026-11-05";
/** WebSocket fallback date version. It does not upgrade the WebRTC or instance protocol. */
export const REMOTE_DESKTOP_FALLBACK_PROTOCOL_VERSION = "2026-11-09";
export const REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL = "taskhandoff.remote-desktop.fallback.media.v1";
export const REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL = "taskhandoff.remote-desktop.fallback.control.v1";
/** Control-plane WebSocket paths that the Cloud Relay byte-channel may carry. */
export type RemoteDesktopRelayTarget =
  | { kind: "signal"; instanceId: string; sessionId: string; ticket: string }
  | { kind: "fallback"; instanceId: string; sessionId: string; role: "media" | "control"; ticket: string };
export const REMOTE_DESKTOP_FALLBACK_MEDIA_CHUNK_BYTES = 16 * 1024;
export const REMOTE_DESKTOP_FALLBACK_HEADER_BYTES = 25;
export const REMOTE_DESKTOP_FALLBACK_MAX_CHUNKS = 1024;
export const REMOTE_DESKTOP_FALLBACK_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const REMOTE_DESKTOP_MAX_MESSAGE_BYTES = 16 * 1024;
export const REMOTE_DESKTOP_MAX_CLIPBOARD_TEXT_BYTES = 32 * 1024;
export const REMOTE_DESKTOP_MAX_CLIPBOARD_WIRE_BYTES = 64 * 1024;

export function remoteDesktopRelaySubprotocol(target: RemoteDesktopRelayTarget) {
  if (target.kind === "signal") return REMOTE_DESKTOP_SIGNAL_SUBPROTOCOL;
  return target.role === "media"
    ? REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL
    : REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL;
}

/** Parse only the two Control Plane WebSocket routes that own one-time desktop
 * tickets. This runs on both sides of the Relay so a compromised client cannot
 * turn the byte-channel into an arbitrary outbound socket. */
export function parseRemoteDesktopRelayPath(input: unknown): RemoteDesktopRelayTarget | undefined {
  if (typeof input !== "string" || input.length < 1 || input.length > 4_096 || !input.startsWith("/api/")) return undefined;
  let url: URL;
  try { url = new URL(input, "http://control-plane.invalid"); }
  catch { return undefined; }
  if (url.origin !== "http://control-plane.invalid" || url.username || url.password || url.hash) return undefined;
  const query = [...url.searchParams.entries()];
  if (query.length !== 1 || query[0][0] !== "ticket" || !query[0][1] || query[0][1].length > 128) return undefined;
  const ticket = query[0][1];
  const signal = url.pathname.match(/^\/api\/controlled-instances\/([^/]+)\/remote-desktop-sessions\/([^/]+)\/signal$/);
  if (signal) {
    const instanceId = decodePathSegment(signal[1]);
    const sessionId = decodePathSegment(signal[2]);
    return instanceId && sessionId ? { kind: "signal", instanceId, sessionId, ticket } : undefined;
  }
  const fallback = url.pathname.match(/^\/api\/controlled-instances\/([^/]+)\/remote-desktop-sessions\/([^/]+)\/fallback\/(media|control)$/);
  if (!fallback) return undefined;
  const instanceId = decodePathSegment(fallback[1]);
  const sessionId = decodePathSegment(fallback[2]);
  return instanceId && sessionId ? { kind: "fallback", instanceId, sessionId, role: fallback[3] as "media" | "control", ticket } : undefined;
}

function decodePathSegment(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("/") && !decoded.includes("\\") ? decoded : undefined;
  } catch { return undefined; }
}
const Name = z.string().min(1);
const Names = z.array(Name);
/** Additive fallback capability. Older peers omit it and keep WebRTC only. */
export const RemoteDesktopFallbackCapabilitiesSchema = z.object({
  available:z.boolean(),
  reason:z.string().nullable(),
  protocolVersion:Name,
  mediaSubprotocol:Name,
  controlSubprotocol:Name,
  maxWidth:z.number().int().nonnegative(),
  maxHeight:z.number().int().nonnegative(),
  maxFrameRate:z.number().int().nonnegative(),
  maxBitrate:z.number().int().nonnegative(),
}).strip();
export type RemoteDesktopFallbackCapabilities = z.infer<typeof RemoteDesktopFallbackCapabilitiesSchema>;
export function unsupportedRemoteDesktopFallback(reason = "REMOTE_DESKTOP_FALLBACK_UNSUPPORTED"): RemoteDesktopFallbackCapabilities {
  return {
    available:false,reason,protocolVersion:REMOTE_DESKTOP_FALLBACK_PROTOCOL_VERSION,
    mediaSubprotocol:REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL,
    controlSubprotocol:REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL,
    maxWidth:0,maxHeight:0,maxFrameRate:0,maxBitrate:0,
  };
}
export const RemoteDesktopCapabilitiesSchema = z.object({
  available: z.boolean(),
  // Extensible diagnostics: future statuses/backends must not break old readers.
  status: Name,
  reason: z.string().nullable(),
  protocolVersion: Name,
  runtimeKind: Name,
  platform: Name,
  desktopSource: Name,
  sourceProviders: z.array(z.object({ kind:Name, available:z.boolean(), reason:z.string().nullable() }).strip()).max(32),
  capture: z.object({ backends:Names, cursor:z.boolean(), precisionModes:Names.default([]) }).strip(),
  encoders: Names,
  input: z.object({ backends:Names, textCommit:z.boolean(), keyboardLayout:z.boolean() }).strip(),
  transport: Names,
  video: z.object({ codecs:Names, maxWidth:z.number().int().nonnegative(), maxHeight:z.number().int().nonnegative(), maxFrameRate:z.number().int().nonnegative() }).strip(),
  features: z.object({ clipboard:z.boolean(), keyboard:z.boolean(), mouse:z.boolean() }).strip(),
  viewerLimit:z.number().int().nonnegative(),
  fallback: RemoteDesktopFallbackCapabilitiesSchema.default(unsupportedRemoteDesktopFallback()),
}).strip();
export type RemoteDesktopCapabilities = z.infer<typeof RemoteDesktopCapabilitiesSchema>;

export function remoteDesktopSupportsCapturePrecision(
  capabilities: RemoteDesktopCapabilities | null | undefined,
) {
  return capabilities?.capture.precisionModes.includes("performance") === true;
}

/** Compatibility for v0.0.50: missing/invalid desktop disables only this domain.
 * No server policy default or current platform list becomes a reader limit. */
export function unsupportedRemoteDesktopCapabilities(reason = "REMOTE_DESKTOP_UNSUPPORTED"): RemoteDesktopCapabilities {
  return {
    available:false,status:"unavailable",reason,protocolVersion:REMOTE_DESKTOP_PROTOCOL_VERSION,
    runtimeKind:"unknown",platform:"unknown",desktopSource:"none",sourceProviders:[],
    capture:{backends:[],cursor:false,precisionModes:[]},encoders:[],
    input:{backends:[],textCommit:false,keyboardLayout:false},transport:[],
    video:{codecs:[],maxWidth:0,maxHeight:0,maxFrameRate:0},
    features:{clipboard:false,keyboard:false,mouse:false},viewerLimit:0,
    fallback:unsupportedRemoteDesktopFallback(reason),
  };
}
export function normalizeRemoteDesktopCapabilities(value: unknown): RemoteDesktopCapabilities {
  return RemoteDesktopCapabilitiesSchema.safeParse(value).data ?? unsupportedRemoteDesktopCapabilities();
}

export const INSTANCE_CAPABILITIES_CHANGED_EVENT_TYPE = "instance.capabilities.changed";
export const InstanceCapabilitiesChangedEventSchema = z.object({}).strip();

/** Browser/CP boundary. Snapshot fields are explicitly projected: input epoch,
 * boot IDs and attach credentials belong to other boundaries. Session revision
 * and deadlines are written only by the component; readers accept future phases. */
export const REMOTE_DESKTOP_SIGNAL_SUBPROTOCOL = "taskhandoff.remote-desktop.2026-11-11";
/** Deployment opt-in for private-LAN HTTP signaling. This is intentionally a
 * literal-IP check: hostnames are not resolved during a WebSocket handshake. */
export function isRemoteDesktopLocalNetworkAddress(value: string) {
  const normalized = value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.+$/, "");
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const octets = mapped.split(".").map(Number);
  if (octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return octets[0] === 10
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (!mapped.includes(":")) return false;
  const first = Number.parseInt(mapped.split(":")[0], 16);
  if (!Number.isFinite(first)) return false;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
export const DesktopRequestIdSchema = z.string().min(1).refine(value => utf8(value) <= 128);
export const DesktopNormalizedRectSchema = z.object({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1),
}).strict().refine(value => value.x + value.width <= 1 && value.y + value.height <= 1);
export const DesktopCaptureSelectionSchema = z.object({
  sourceRef: z.string().min(1).max(4096),
  streamRegion: DesktopNormalizedRectSchema.optional(),
  controlRegion: DesktopNormalizedRectSchema.optional(),
}).strict();
export const DesktopCreateSchema = z.object({ requestId: DesktopRequestIdSchema, selection: DesktopCaptureSelectionSchema }).strict();
export const DesktopSessionSnapshotSchema = z.object({
  viewerSessionId: z.string().min(1), sessionRevision: z.number().int().nonnegative(),
  // Compatibility for v0.0.50-V: older single-viewer components omit these.
  // A missing lease belongs to that viewer; viewerCount defaults to one.
  controlRevision: z.number().int().nonnegative().default(0),
  isController: z.boolean().default(true),
  hasController: z.boolean().default(true),
  // A terminal session has no live viewers; keep that authoritative state
  // readable instead of requiring every recovery snapshot to invent a viewer.
  viewerCount: z.number().int().nonnegative().default(1),
  // Component-owned transport state. Missing values keep the WebRTC baseline
  // for older components; readers accept future transport names.
  transport: z.string().min(1).default("webrtc"),
  phase: z.string().min(1), captureSelection: DesktopCaptureSelectionSchema,
  sessionExpiresAt: z.number().int().nonnegative(), idleExpiresAt: z.number().int().nonnegative().nullable(),
  mediaPaused: z.boolean(), reason: z.string().nullable(),
}).strip();
export const DesktopSourceSchema = z.object({
  sourceRef: z.string().min(1).max(4096), kind: Name.refine(value => utf8(value) <= 64),
  title: z.string().refine(value => utf8(value) <= 512), subtitle: z.string().refine(value => utf8(value) <= 256).nullable(),
  width: z.number().int().nonnegative(), height: z.number().int().nonnegative(),
  capturable: z.boolean(), reason: z.string().nullable(),
}).strip();
export const DesktopSourcesSchema = z.array(DesktopSourceSchema).max(256).refine(value => utf8(JSON.stringify(value)) <= 512 * 1024);
export const DesktopIceServerSchema = z.object({
  urls: z.array(z.string().min(1).max(2048)).min(1).max(16), username: z.string().max(1024).optional(), credential: z.string().max(1024).optional(),
}).strip();
export const DesktopIceConfigSchema = z.object({ iceServers: z.array(DesktopIceServerSchema).max(16), iceCredentialsExpiresAt: z.number().int().positive().nullable() }).strip();
export const DesktopCreatedSchema = DesktopIceConfigSchema.extend({
  snapshot: DesktopSessionSnapshotSchema, signalUrl: z.string(), ticketExpiresAt: z.number().int().positive(), protocolVersion: z.string(),
}).strip();
export const DesktopFallbackReasonSchema = z.enum(["ice-failed", "recovery-timeout"]);
export const DesktopFallbackRequestSchema = z.object({
  requestId: DesktopRequestIdSchema,
  reason: DesktopFallbackReasonSchema,
  diagnosticCode: z.string().min(1).max(128).optional(),
}).strict();
export const DesktopFallbackSessionSchema = z.object({
  protocolVersion: z.literal(REMOTE_DESKTOP_FALLBACK_PROTOCOL_VERSION),
  fallbackGeneration: z.string().min(1).max(128),
  mediaUrl: z.string().min(1),
  controlUrl: z.string().min(1),
  mediaSubprotocol: z.literal(REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL),
  controlSubprotocol: z.literal(REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL),
  ticketExpiresAt: z.number().int().positive(),
  limits: z.object({
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
    maxFps: z.number().int().positive(),
    maxBitrate: z.number().int().positive(),
  }).strict(),
}).strict();
export type DesktopFallbackSession = z.infer<typeof DesktopFallbackSessionSchema>;

/** Media WS binary frame: magic `RD`, version, type, flags, frame id,
 * timestamp, chunk index/count and payload length, followed by Annex B bytes.
 * The codec is declared by the preceding fallback.configure message. */
export const DESKTOP_FALLBACK_FRAME_VIDEO = 1;
export const DESKTOP_FALLBACK_FLAG_KEYFRAME = 1;
export type DesktopFallbackFrame = {
  frameId: number;
  timestampUs: bigint;
  keyframe: boolean;
  chunkIndex: number;
  chunkCount: number;
  payload: Uint8Array;
};
export function decodeDesktopFallbackFrame(buffer: ArrayBuffer | Uint8Array): DesktopFallbackFrame {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (view.byteLength < REMOTE_DESKTOP_FALLBACK_HEADER_BYTES) throw new Error("REMOTE_DESKTOP_FALLBACK_FRAME_INVALID");
  if (view[0] !== 0x52 || view[1] !== 0x44 || view[2] !== 1 || view[3] !== DESKTOP_FALLBACK_FRAME_VIDEO) throw new Error("REMOTE_DESKTOP_FALLBACK_FRAME_INVALID");
  const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const frameId = data.getUint32(5);
  const timestampUs = data.getBigUint64(9);
  const chunkIndex = data.getUint16(17);
  const chunkCount = data.getUint16(19);
  const payloadLength = data.getUint32(21);
  if (chunkCount < 1 || chunkCount > REMOTE_DESKTOP_FALLBACK_MAX_CHUNKS || chunkIndex >= chunkCount || payloadLength !== view.byteLength - REMOTE_DESKTOP_FALLBACK_HEADER_BYTES) throw new Error("REMOTE_DESKTOP_FALLBACK_FRAME_INVALID");
  return {
    frameId,
    timestampUs,
    keyframe: (view[4] & DESKTOP_FALLBACK_FLAG_KEYFRAME) === DESKTOP_FALLBACK_FLAG_KEYFRAME,
    chunkIndex,
    chunkCount,
    payload: view.subarray(REMOTE_DESKTOP_FALLBACK_HEADER_BYTES),
  };
}

export type DesktopFallbackAssembledFrame = {
  frameId: number;
  timestampUs: bigint;
  keyframe: boolean;
  payload: Uint8Array;
  /** A complete frame was missed since the previous complete frame. */
  skippedFrames: boolean;
};
export type DesktopFallbackAssemblyResult =
  | { type: "pending" }
  | { type: "stale" }
  | ({ type: "frame" } & DesktopFallbackAssembledFrame);

/** Browser-side reassembly for one fallback media generation. It keeps at most
 * one incomplete frame, accepts chunks out of order, ignores duplicates and
 * stale frames, and flags sequence gaps so the viewer can request an IDR. */
export class DesktopFallbackFrameAssembler {
  private pending?: {
    frameId: number;
    timestampUs: bigint;
    keyframe: boolean;
    chunkCount: number;
    chunks: Array<Uint8Array | undefined>;
    received: number;
    bytes: number;
  };
  private completedFrameId = 0;

  reset() {
    this.pending = undefined;
    this.completedFrameId = 0;
  }

  push(frame: DesktopFallbackFrame): DesktopFallbackAssemblyResult {
    if (frame.chunkCount < 1 || frame.chunkCount > REMOTE_DESKTOP_FALLBACK_MAX_CHUNKS) {
      throw new Error("REMOTE_DESKTOP_FALLBACK_FRAME_INVALID");
    }
    if (this.completedFrameId !== 0 && frame.frameId <= this.completedFrameId) return { type: "stale" };
    if (this.pending && frame.frameId < this.pending.frameId) return { type: "stale" };
    if (!this.pending || frame.frameId !== this.pending.frameId) {
      this.pending = {
        frameId: frame.frameId,
        timestampUs: frame.timestampUs,
        keyframe: frame.keyframe,
        chunkCount: frame.chunkCount,
        chunks: new Array(frame.chunkCount),
        received: 0,
        bytes: 0,
      };
    }
    const part = this.pending;
    if (part.timestampUs !== frame.timestampUs || part.keyframe !== frame.keyframe || part.chunkCount !== frame.chunkCount) {
      throw new Error("REMOTE_DESKTOP_FALLBACK_FRAME_INVALID");
    }
    if (part.chunks[frame.chunkIndex]) return { type: "pending" };
    if (part.bytes + frame.payload.byteLength > REMOTE_DESKTOP_FALLBACK_MAX_FRAME_BYTES) {
      throw new Error("REMOTE_DESKTOP_FALLBACK_FRAME_INVALID");
    }
    part.chunks[frame.chunkIndex] = frame.payload.slice();
    part.received += 1;
    part.bytes += frame.payload.byteLength;
    if (part.received !== part.chunkCount) return { type: "pending" };

    const payload = new Uint8Array(part.bytes);
    let offset = 0;
    for (const chunk of part.chunks) {
      if (!chunk) throw new Error("REMOTE_DESKTOP_FALLBACK_FRAME_INVALID");
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const skippedFrames = this.completedFrameId !== 0 && part.frameId > this.completedFrameId + 1;
    this.completedFrameId = part.frameId;
    this.pending = undefined;
    return {
      type: "frame",
      frameId: part.frameId,
      timestampUs: part.timestampUs,
      keyframe: part.keyframe,
      payload,
      skippedFrames,
    };
  }
}
/** Complete gathered SDP is supported as well as bounded trickle candidates.
 * Reject extra media before the SDP reaches the native WebRTC parser. */
export function desktopSdpAllowed(sdp: string) {
  if (!sdp || utf8(sdp) > 512 * 1024) return false;
  const lines = sdp.split(/\r?\n/).filter(line => line.startsWith("m="));
  return lines.length === 2 && lines.filter(line => /^m=video /.test(line)).length === 1
    && lines.filter(line => /^m=application /.test(line)).length === 1;
}
export const DesktopSignalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), requestId: DesktopRequestIdSchema, sdp: z.string().refine(desktopSdpAllowed) }).strict(),
  z.object({ type: z.literal("candidate"), requestId: DesktopRequestIdSchema, candidate: z.object({
    candidate: z.string().refine(value => utf8(value) <= 4096), sdpMid: z.string().max(256).nullable(), sdpMLineIndex: z.number().int().min(0).max(1).nullable(),
  }).strict() }).strict(),
  z.object({ type: z.literal("signalAlive"), requestId: DesktopRequestIdSchema }).strict(),
  z.object({ type: z.literal("stop"), requestId: DesktopRequestIdSchema }).strict(),
  z.object({ type: z.literal("iceRestarted"), requestId: DesktopRequestIdSchema }).strict(),
  z.object({ type: z.literal("acknowledged"), requestId: DesktopRequestIdSchema }).strict(),
]);
export type DesktopSessionSnapshot = z.infer<typeof DesktopSessionSnapshotSchema>;
export type DesktopCaptureSelection = z.infer<typeof DesktopCaptureSelectionSchema>;
export type DesktopSource = z.infer<typeof DesktopSourceSchema>;
export type DesktopIceServer = z.infer<typeof DesktopIceServerSchema>;
export type DesktopIceConfig = z.infer<typeof DesktopIceConfigSchema>;
export type DesktopCreated = z.infer<typeof DesktopCreatedSchema>;
