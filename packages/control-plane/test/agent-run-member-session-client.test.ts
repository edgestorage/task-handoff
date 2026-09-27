import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunMemberSessionClient } from "../src/node-agent/agents/member-session-client.ts";

const instance = {
  id: "instance_one",
  registrationToken: "instance-secret",
} as never;

test("member session client uses the private instance credential and parses results", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new AgentRunMemberSessionClient(async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: {
      disposition: "created",
      aiSessionId: "session_member",
      providerSessionId: "thread_member",
    } }), { status: 200, headers: { "content-type": "application/json" } });
  }, async () => "http://127.0.0.1:8080");
  const result = await client.create(instance, {
    runId: "run_12345678",
    memberId: "member_12345678",
    clientRequestId: "request_12345678",
    providerId: "codex",
    cwd: { type: "runtime-path", path: "/workspace" },
    writableRoots: {
      workspace: { type: "runtime-path", path: "/workspace" },
      shared: { type: "runtime-path", path: "/shared/run_12345678" },
    },
    prompt: "Review",
    appendedPrompt: "",
    enabledTools: [],
  });
  assert.equal(result.aiSessionId, "session_member");
  assert.equal(requests[0]?.url, "http://127.0.0.1:8080/api/internal/node-agent/agent-runs/members");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, "Bearer instance-secret");
});

test("member session client preserves structured instance failures", async () => {
  const client = new AgentRunMemberSessionClient(async () => new Response(JSON.stringify({
    error: { code: "AGENT_RUN_MEMBER_SESSION_CLOSED", message: "closed" },
  }), { status: 409, headers: { "content-type": "application/json" } }), async () => "http://127.0.0.1:8080");
  await assert.rejects(
    () => client.status(instance, "run_12345678", "member_12345678"),
    (error: any) => error.code === "AGENT_RUN_MEMBER_SESSION_CLOSED" && error.statusCode === 409,
  );
});

test("member session client reads the ordinary-session probe boundary and rejects malformed provider status", async () => {
  const probeClient = new AgentRunMemberSessionClient(async () => new Response(JSON.stringify({
    data: { ordinaryAiSessionIds: ["session_one"] },
  }), { status: 200, headers: { "content-type": "application/json" } }), async () => "http://127.0.0.1:8080");
  assert.deepEqual(await probeClient.probeState(instance), { ordinaryAiSessionIds: ["session_one"] });

  const malformedClient = new AgentRunMemberSessionClient(async () => new Response(JSON.stringify({
    data: { runId: "run_12345678", memberId: "member_12345678", aiSessionId: "session_member", status: "completed" },
  }), { status: 200, headers: { "content-type": "application/json" } }), async () => "http://127.0.0.1:8080");
  await assert.rejects(() => malformedClient.status(instance, "run_12345678", "member_12345678"), /Completed member status requires a result/);
});
