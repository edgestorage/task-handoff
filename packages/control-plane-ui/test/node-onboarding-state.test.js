import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReachabilityProbe,
  directEndpointIssue,
  initialReachabilityDecision,
  probeControlPlaneOrigin,
  reachabilityConflict,
  selectReachability,
} from "../src/apps/control-plane/settings/nodeOnboardingState.ts";

test("reachability probe chooses a default until the user overrides it", () => {
  const reachable = applyReachabilityProbe(initialReachabilityDecision(), { status: "reachable" });
  assert.deepEqual(reachable.selection, { value: "publicly-reachable", source: "probe" });

  const overridden = selectReachability(reachable, "not-publicly-reachable");
  const lateProbe = applyReachabilityProbe(overridden, { status: "reachable" });
  assert.deepEqual(lateProbe.selection, { value: "not-publicly-reachable", source: "user" });
  assert.equal(reachabilityConflict(lateProbe), true);
});

test("inconclusive probes recommend the safer non-public path", () => {
  const decision = applyReachabilityProbe(initialReachabilityDecision(), { status: "inconclusive" });
  assert.deepEqual(decision.selection, { value: "not-publicly-reachable", source: "probe" });
  assert.equal(reachabilityConflict(decision), false);
});

test("origin probe classifies private, insecure, reachable, and failed origins", async () => {
  const now = () => new Date("2026-08-22T00:00:00.000Z");
  assert.equal((await probeControlPlaneOrigin("http://192.168.1.4:8090", { now })).reason, "private-host");
  assert.equal((await probeControlPlaneOrigin("http://cp.example.com", { now })).reason, "insecure-http");
  assert.equal((await probeControlPlaneOrigin("bad", { now })).reason, "invalid-origin");
  assert.equal((await probeControlPlaneOrigin("https://cp.example.com", { now, fetchImpl: async () => new Response() })).status, "reachable");
  assert.equal((await probeControlPlaneOrigin("https://cp.example.com", { now, fetchImpl: async () => { throw new Error("offline"); } })).reason, "request-failed");
});

test("public direct endpoints require HTTPS while private endpoints may use HTTP", () => {
  assert.equal(directEndpointIssue("http://203.0.113.8:8091"), "public-http");
  assert.equal(directEndpointIssue("http://10.0.0.8:8091"), undefined);
  assert.equal(directEndpointIssue("https://node.example.com"), undefined);
  assert.equal(directEndpointIssue("not-a-url"), "invalid");
});
