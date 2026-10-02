import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlaneChatGatewayApi } from "../src/chat-gateway.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

const TS = "2026-10-02T00:00:00.000Z";

function bridge(overrides: Record<string, unknown> = {}) {
  return {
    id: "brg_0000000000001",
    channel: "telegram",
    name: "Ops",
    tokenSet: true,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "chs_0000000000001",
    channel: "telegram",
    chatSessionId: "chat-1",
    lastUsedAt: TS,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function status() {
  return { running: true, bridges: [{ id: "brg_0000000000001", channel: "telegram", name: "Ops", running: true, tokenSet: true }] };
}

function fixture(respond: (path: string, init?: RequestInit) => unknown) {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const transport: ControlPlaneClientTransport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse(respond(path, init));
    },
  };
  return { api: createControlPlaneChatGatewayApi(transport), requests };
}

test("chat gateway bridge reads strip channel credentials", async () => {
  const { api, requests } = fixture((path, init) => {
    if (path.endsWith("/start") || path.endsWith("/stop")) return { data: status() };
    if (init?.method === "DELETE") return { data: { deleted: true } };
    if (init?.method === "POST" || init?.method === "PATCH") return { data: bridge({ name: "New" }) };
    if (path === "/api/chat-gateway/status") return { data: status() };
    return { data: [bridge({ token: "secret-token" })] };
  });

  const bridges = await api.listBridges();
  assert.equal("token" in bridges[0], false);
  await api.createBridge({ channel: "telegram", name: "New" });
  await api.updateBridge("brg/one", { name: "New" });
  await api.startBridge("brg_0000000000001");
  const gatewayStatus = await api.status();
  assert.equal(gatewayStatus.bridges[0].tokenSet, true);
  const removed = await api.removeBridge("brg_0000000000001");
  assert.deepEqual(removed, { deleted: true });

  assert.deepEqual(requests.map((entry) => [entry.path, entry.init?.method]), [
    ["/api/chat-gateway/bridges", undefined],
    ["/api/chat-gateway/bridges", "POST"],
    ["/api/chat-gateway/bridges/brg%2Fone", "PATCH"],
    ["/api/chat-gateway/bridges/brg_0000000000001/start", "POST"],
    ["/api/chat-gateway/status", undefined],
    ["/api/chat-gateway/bridges/brg_0000000000001", "DELETE"],
  ]);
});

test("chat session routes read authoritative bindings", async () => {
  const { api, requests } = fixture((path) => (
    path === "/api/chat/sessions" ? { data: [session()] } : { data: session({ id: "chs_single" }) }
  ));
  const sessions = await api.listSessions();
  assert.equal(sessions[0].chatSessionId, "chat-1");
  const detail = await api.getSession("chs/one");
  assert.equal(detail.id, "chs_single");
  assert.deepEqual(requests.map((entry) => entry.path), [
    "/api/chat/sessions",
    "/api/chat/sessions/chs%2Fone",
  ]);
});
