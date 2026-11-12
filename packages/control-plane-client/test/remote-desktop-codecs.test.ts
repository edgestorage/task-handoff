import assert from "node:assert/strict";
import test from "node:test";

import { preferredRemoteDesktopVideoCodecs, remoteDesktopVideoCodecLabel } from "../src/remote-desktop-codecs.ts";

const h264 = { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f" };
const hevcMain = { mimeType: "video/H265", sdpFmtpLine: "level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST" };
const hevcMain10 = { mimeType: "video/H265", sdpFmtpLine: "level-id=180;profile-id=2;tier-flag=0;tx-mode=SRST" };
const vp8 = { mimeType: "video/VP8", sdpFmtpLine: undefined };

test("moves HEVC Main ahead of H264 when the sender advertises H265", () => {
  assert.deepEqual(
    preferredRemoteDesktopVideoCodecs([vp8, h264, hevcMain10, hevcMain], ["h264", "h265"]),
    [hevcMain, vp8, h264, hevcMain10],
  );
});

test("keeps browser order when the sender has no HEVC encoder", () => {
  assert.deepEqual(
    preferredRemoteDesktopVideoCodecs([vp8, h264, hevcMain], ["h264"]),
    [vp8, h264, hevcMain],
  );
});

test("does not select an HEVC profile the sender cannot produce", () => {
  assert.deepEqual(
    preferredRemoteDesktopVideoCodecs([hevcMain10, h264], ["h265", "h264"]),
    [hevcMain10, h264],
  );
});

test("diagnostics normalize negotiated and WebCodecs codec names", () => {
  assert.equal(remoteDesktopVideoCodecLabel("video/H265"), "H.265");
  assert.equal(remoteDesktopVideoCodecLabel("hvc1.1.6.L120.90"), "H.265");
  assert.equal(remoteDesktopVideoCodecLabel("avc1.42E028"), "H.264");
  assert.equal(remoteDesktopVideoCodecLabel("video/VP9"), "VP9");
  assert.equal(remoteDesktopVideoCodecLabel(undefined), undefined);
});
