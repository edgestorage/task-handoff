import assert from "node:assert/strict";
import test from "node:test";

import { parseRemoteDesktopWebRTCStats } from "../src/remote-desktop-stats.ts";

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
