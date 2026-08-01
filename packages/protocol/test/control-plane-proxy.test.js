import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
  ClaimProxyInviteInputSchema,
  ControlPlaneProxyOriginSchema,
  NodeAgentProxyRouteSchema,
  ProxyBindingSchema,
  ProxyTargetEventSchema,
  PublicPendingProxyClaimSchema,
  PublicProxyBindingSchema,
} from "../src/control-plane-proxy.ts";

const timestamp = "2026-08-01T00:00:00.000Z";

test("proxy protocol uses an independent date-only version", () => {
  assert.match(CONTROL_PLANE_PROXY_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test("proxy origins normalize only canonical HTTPS origins", () => {
  assert.equal(ControlPlaneProxyOriginSchema.parse("https://proxy.example/"), "https://proxy.example");
  for (const value of [
    "http://proxy.example",
    "wss://proxy.example",
    "https://user:pass@proxy.example",
    "https://proxy.example/path",
    "https://proxy.example?target=other",
    "https://proxy.example#fragment",
  ]) assert.equal(ControlPlaneProxyOriginSchema.safeParse(value).success, false, value);
});

test("node proxy routes reject upstream selection and traversal", () => {
  assert.equal(NodeAgentProxyRouteSchema.parse("/health?verbose=1"), "/health?verbose=1");
  for (const value of ["https://other/health", "//other/health", "/../health", "/%2e%2e/health", "/%252e%252e/health", "/foo\\bar"])
    assert.equal(NodeAgentProxyRouteSchema.safeParse(value).success, false, value);
});

test("binding and public projections never expose credential material", () => {
  const binding = ProxyBindingSchema.parse({
    id: "binding_1", claimId: "claim_1", sourceControlPlaneId: "cp_a", targetNodeId: "node_b",
    bindingKeyId: "key_1", credentialHash: "a".repeat(64), status: "active", revision: 1,
    createdAt: timestamp, updatedAt: timestamp,
  });
  assert.equal(PublicProxyBindingSchema.safeParse(binding).success, false);
  const { credentialHash: _hash, ...publicBinding } = binding;
  assert.equal(PublicProxyBindingSchema.parse(publicBinding).id, "binding_1");

  const claim = ClaimProxyInviteInputSchema.parse({
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    inviteToken: "i".repeat(32), claimId: "claim_1", sourceControlPlaneId: "cp_a",
    bindingKeyId: "key_1", credential: "c".repeat(32),
  });
  const pending = { id: "claim_1", ...claim, proxyOrigin: "https://proxy.example", status: "pending", createdAt: timestamp, updatedAt: timestamp, expiresAt: timestamp };
  assert.equal(PublicPendingProxyClaimSchema.safeParse(pending).success, false);
  const { credential: _credential, inviteToken: _token, protocolVersion: _version, ...receipt } = pending;
  assert.equal(PublicPendingProxyClaimSchema.parse(receipt).claimId, "claim_1");
});

test("proxy target events expose correlation metadata without forwarding source payload or scope", () => {
  const event = {
    type: "control-plane-proxy.event",
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    streamId: "stream_1",
    bindingId: "binding_1",
    sourceControlPlaneId: "cp_a",
    targetNodeId: "node_b",
    revision: 1,
    source: { id: "event_1", seq: 7 },
    target: { id: "node_b", name: "Node B", status: "online", health: "ok", capabilities: {} },
    event: { type: "node.checked", topic: "node.state", createdAt: timestamp },
  };
  assert.equal(ProxyTargetEventSchema.parse(event).source.id, "event_1");
  assert.equal(ProxyTargetEventSchema.safeParse({
    ...event,
    event: { ...event.event, payload: { credential: "secret" } },
  }).success, false);
});
