import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRemoteDesktopWebRTCReceiveSample,
  parseRemoteDesktopWebRTCStats,
} from "../src/remote-desktop-stats.ts";

function stats(values: Record<string, Record<string, unknown>>) {
  return new Map(Object.entries(values));
}

test("selected candidate pair exposes route, candidates, protocol, and current RTT", () => {
  const report = stats({
    transport: { type: "transport", selectedCandidatePairId: "pair" },
    pair: {
      type: "candidate-pair",
      localCandidateId: "local",
      remoteCandidateId: "remote",
      protocol: "udp",
      currentRoundTripTime: 0.0426,
    },
    local: { type: "local-candidate", candidateType: "srflx" },
    remote: { type: "remote-candidate", candidateType: "host" },
  });
  assert.deepEqual(parseRemoteDesktopWebRTCStats(report), {
    path: "p2p",
    protocol: "udp",
    localCandidateType: "srflx",
    remoteCandidateType: "host",
    latencyMs: 43,
  });
});

test("relay candidates select TURN and average RTT is the fallback", () => {
  const report = stats({
    pair: {
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "local",
      remoteCandidateId: "remote",
      totalRoundTripTime: 0.12,
      responsesReceived: 3,
    },
    local: { candidateType: "relay", protocol: "tcp" },
    remote: { candidateType: "host" },
  });
  assert.deepEqual(parseRemoteDesktopWebRTCStats(report), {
    path: "turn",
    protocol: "tcp",
    localCandidateType: "relay",
    remoteCandidateType: "host",
    latencyMs: 40,
  });
});

test("invalid RTT and missing selected pair stay absent", () => {
  assert.equal(parseRemoteDesktopWebRTCStats(stats({})), undefined);
  assert.deepEqual(parseRemoteDesktopWebRTCStats(stats({
    pair: {
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "local",
      currentRoundTripTime: -1,
      totalRoundTripTime: 1,
      responsesReceived: 0,
    },
    local: { candidateType: "host" },
  })), {
    path: "p2p",
    localCandidateType: "host",
  });
});

test("inbound video counters derive receive bandwidth between polls", () => {
  const first = stats({
    transport: { type: "transport", selectedCandidatePairId: "pair" },
    pair: { type: "candidate-pair" },
    video: { type: "inbound-rtp", kind: "video", bytesReceived: 1_000_000, timestamp: 10_000 },
    audio: { type: "inbound-rtp", kind: "audio", bytesReceived: 900_000, timestamp: 10_000 },
  });
  const second = stats({
    transport: { type: "transport", selectedCandidatePairId: "pair" },
    pair: { type: "candidate-pair", currentRoundTripTime: 0.02 },
    video: { type: "inbound-rtp", kind: "video", bytesReceived: 2_500_000, timestamp: 12_000 },
    audio: { type: "inbound-rtp", kind: "audio", bytesReceived: 1_000_000, timestamp: 12_000 },
  });

  assert.deepEqual(parseRemoteDesktopWebRTCReceiveSample(first), { bytes: 1_000_000, timestampMs: 10_000 });
  assert.deepEqual(parseRemoteDesktopWebRTCStats(second, parseRemoteDesktopWebRTCReceiveSample(first)), {
    latencyMs: 20,
    bandwidthMbps: 6,
  });
});

test("bandwidth sums all inbound video RTP streams and ignores reset or invalid samples", () => {
  const first = parseRemoteDesktopWebRTCReceiveSample(stats({
    primary: { type: "inbound-rtp", kind: "video", bytesReceived: 4_000_000, timestamp: 20_000 },
    retransmit: { type: "inbound-rtp", kind: "video", bytesReceived: 1_000_000, timestamp: 20_000 },
    audio: { type: "inbound-rtp", kind: "audio", bytesReceived: 2_000_000, timestamp: 20_000 },
  }));
  const second = parseRemoteDesktopWebRTCReceiveSample(stats({
    primary: { type: "inbound-rtp", kind: "video", bytesReceived: 6_000_000, timestamp: 21_000 },
    retransmit: { type: "inbound-rtp", kind: "video", bytesReceived: 1_500_000, timestamp: 21_000 },
    audio: { type: "inbound-rtp", kind: "audio", bytesReceived: 4_000_000, timestamp: 21_000 },
  }));
  assert.deepEqual(first, { bytes: 5_000_000, timestampMs: 20_000 });
  assert.deepEqual(second, { bytes: 7_500_000, timestampMs: 21_000 });

  const selected = {
    transport: { type: "transport", selectedCandidatePairId: "pair" },
    pair: { type: "candidate-pair" },
  };
  const reset = stats({
    ...selected,
    video: { type: "inbound-rtp", kind: "video", bytesReceived: 4_000_000, timestamp: 22_000 },
  });
  assert.equal(parseRemoteDesktopWebRTCStats(reset, { bytes: 5_000_000, timestampMs: 20_000 })?.bandwidthMbps, undefined);
  assert.equal(parseRemoteDesktopWebRTCStats(reset, { bytes: 1_000_000, timestampMs: 22_000 })?.bandwidthMbps, undefined);
});

test("inbound video exposes the negotiated codec and decoded frame rate", () => {
  const report = stats({
    transport: { type: "transport", selectedCandidatePairId: "pair" },
    pair: { type: "candidate-pair", currentRoundTripTime: 0.02 },
    video: {
      type: "inbound-rtp",
      kind: "video",
      bytesReceived: 2_500_000,
      timestamp: 12_000,
      codecId: "codec",
      framesPerSecond: 29.97,
    },
    codec: { type: "codec", mimeType: "video/H265" },
  });

  assert.deepEqual(parseRemoteDesktopWebRTCStats(report), {
    latencyMs: 20,
    codec: "video/H265",
    frameRate: 30,
  });
});
