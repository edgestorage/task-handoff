import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { z } from "zod";
import { createThctlTransport } from "../src/control-plane.ts";
import { guardApprovalProtocol, waitForOperationApproval } from "../src/operation-approvals.ts";

const expiresAt = new Date(Date.now() + 60_000).toISOString();

test("every protected CLI command probes the approval protocol without reading operation policy", () => {
  for (const [file, methods] of Object.entries({
    instance: ["deleteInstance"],
    "node-admin": ["removeNode", "applyUpdate", "updateExternalListener"],
    user: ["setAccess", "updateRole", "archiveRole", "updateProvider", "removeProvider"],
    credentials: ["assignToInstance"],
  })) {
    const source = fs.readFileSync(new URL(`../src/commands/${file}.ts`, import.meta.url), "utf8");
    for (const method of methods) assert.match(source, new RegExp(`guardApprovalProtocol\\(connection, \\(\\) => connection\\.client\\.[^\\n]*\\.${method}\\(`), `${file}: ${method}`);
  }
});

test("destructive legacy-server guard probes the protocol, not an operation policy", async () => {
  const calls = [];
  const connection = { client: { approvals: { async support() { calls.push("support"); } } } };
  assert.deepEqual(await guardApprovalProtocol(connection, async () => { calls.push("execute"); return { deleted: true }; }), { deleted: true });
  assert.deepEqual(calls, ["support", "execute"]);
});

test("missing protocol fails closed before sending a destructive request", async () => {
  let executed = false;
  const connection = { client: { approvals: { async support() { throw new Error("Not found"); } } } };
  await assert.rejects(guardApprovalProtocol(connection, async () => { executed = true; }), { code: "CLI_APPROVAL_UNAVAILABLE" });
  assert.equal(executed, false);
});

test("any CLI write transparently waits and resubmits the same request after approval", async () => {
  const calls = [];
  const transport = createThctlTransport({ origin: "http://control-plane.test", approvalWait: {
    signal: new AbortController().signal,
    async sleep() { calls.push("sleep"); },
  }, fetchImpl: async (url, init) => {
    const address = new URL(url);
    const headers = new Headers(init.headers);
    calls.push(`${init.method ?? "GET"} ${address.pathname} ${headers.get("x-task-handoff-approval-id") ?? ""} ${init.body ?? ""}`);
    if (address.pathname.endsWith("/status")) return Response.json({ data: { id: "approval-a", status: "approved", expiresAt } });
    if (!headers.has("x-task-handoff-approval-id")) return Response.json({ data: { kind: "operation-approval", id: "approval-a", status: "pending", expiresAt } }, { status: 202 });
    return Response.json({ data: { updated: true } });
  } });
  const result = await transport.request("/api/unrelated-write", z.object({ data: z.object({ updated: z.boolean() }) }), { method: "PATCH", body: '{"value":1}' });
  assert.deepEqual(result, { data: { updated: true } });
  assert.deepEqual(calls, [
    'PATCH /api/unrelated-write  {"value":1}',
    "GET /api/operation-approvals/approval-a/status  ",
    'PATCH /api/unrelated-write approval-a {"value":1}',
  ]);
});

test("an unrelated accepted write response is not treated as an approval", async () => {
  const transport = createThctlTransport({ origin: "http://control-plane.test", fetchImpl: async () => Response.json({ data: { queued: true } }, { status: 202 }) });
  assert.deepEqual(await transport.request("/api/jobs", z.object({ data: z.object({ queued: z.boolean() }) }), { method: "POST" }), { data: { queued: true } });
});

test("a second approval response does not repeat the business request", async () => {
  let requests = 0;
  const transport = createThctlTransport({ origin: "http://control-plane.test", approvalWait: {
    signal: new AbortController().signal, async sleep() {},
  }, fetchImpl: async (url) => {
    if (new URL(url).pathname.endsWith("/status")) return Response.json({ data: { id: "approval-a", status: "approved", expiresAt } });
    requests += 1;
    return Response.json({ data: { kind: "operation-approval", id: "approval-a", status: "pending", expiresAt } }, { status: 202 });
  } });
  await assert.rejects(transport.request("/api/jobs", z.object({ data: z.object({ queued: z.boolean() }) }), { method: "POST" }), { code: "CLI_PROTOCOL_ERROR" });
  assert.equal(requests, 2);
});

test("cancellation during a status poll cannot execute a freshly approved operation", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(waitForOperationApproval({ id: "approval-a", status: "pending", expiresAt }, {
    signal: controller.signal, async sleep() {},
  }, async () => { controller.abort(); return { status: "approved" }; }, async () => { calls.push("cancel"); }), { code: "CLI_CANCELLED" });
  assert.deepEqual(calls, ["cancel"]);
});

test("denial stops polling without granting execution", async () => {
  await assert.rejects(waitForOperationApproval({ id: "approval-a", status: "pending", expiresAt }, {
    signal: new AbortController().signal, async sleep() {},
  }, async () => ({ status: "denied" }), async () => {}), { code: "CLI_APPROVAL_DENIED" });
});

test("CLI stops at the five-minute deadline even when the server still reports pending", async (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  let polls = 0;
  const deadline = new Date(Date.now() + 6 * 60_000).toISOString();
  await assert.rejects(waitForOperationApproval({ id: "approval-a", status: "pending", expiresAt: deadline }, {
    signal: new AbortController().signal, async sleep(milliseconds) { context.mock.timers.tick(milliseconds); },
  }, async () => { polls += 1; return { status: "pending" }; }, async () => {}), { code: "CLI_APPROVAL_EXPIRED" });
  assert.equal(polls, 300);
});
