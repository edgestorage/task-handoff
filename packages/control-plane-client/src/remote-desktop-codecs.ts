export type RemoteDesktopRtpCodecCapability = {
  mimeType: string;
  sdpFmtpLine?: string;
};

/** User-facing codec name shared by Web and mobile diagnostics. Accepts RTP
 * MIME types, negotiated capability ids, and WebCodecs codec strings. */
export function remoteDesktopVideoCodecLabel(value: string | undefined): string | undefined {
  const codec = value?.trim();
  if (!codec) return undefined;
  const normalized = codec.toLowerCase();
  if (normalized === "h265" || normalized.includes("h265") || normalized.startsWith("video/h265") || /^(?:hvc1|hev1)\./.test(normalized)) return "H.265";
  if (normalized === "h264" || normalized.includes("h264") || normalized.startsWith("video/h264") || /^(?:avc1|avc3)\./.test(normalized)) return "H.264";
  if (normalized.includes("vp9") || normalized.startsWith("video/vp9")) return "VP9";
  if (normalized.includes("vp8") || normalized.startsWith("video/vp8")) return "VP8";
  if (normalized.includes("av01") || normalized.includes("av1")) return "AV1";
  const mimeValue = /^video\/(.+)$/.exec(normalized)?.[1];
  return mimeValue ? mimeValue.toUpperCase() : codec;
}

function isHevcMainProfile(codec: RemoteDesktopRtpCodecCapability) {
  if (codec.mimeType.toLowerCase() !== "video/h265") return false;
  const profile = (codec.sdpFmtpLine ?? "")
    .split(";")
    .map((field) => field.trim().toLowerCase())
    .find((field) => field.startsWith("profile-id="));
  return profile === "profile-id=1";
}

/**
 * Prefer HEVC Main when both ends can use it. H.264 remains in the list, so a
 * missing server HEVC sender or a receiver without a Main-profile decoder
 * keeps the browser's original negotiation order.
 */
export function preferredRemoteDesktopVideoCodecs<T extends RemoteDesktopRtpCodecCapability>(
  codecs: readonly T[],
  senderCodecs: readonly string[],
): T[] {
  const senderSupportsHevc = senderCodecs.some((codec) => codec.trim().toLowerCase() === "h265");
  if (!senderSupportsHevc) return [...codecs];
  const hevc = codecs.filter(isHevcMainProfile);
  if (!hevc.length) return [...codecs];
  const preferred = new Set<T>(hevc);
  return [...hevc, ...codecs.filter((codec) => !preferred.has(codec))];
}
