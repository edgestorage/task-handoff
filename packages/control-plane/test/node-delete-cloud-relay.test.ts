import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerNodeRoutes } from "../src/control-plane/http/node-routes.ts";

async function testApp(input: { node: any; calls: string[]; deleteError?: Error }) {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerNodeRoutes({
    app,
    service: {
      requireNode: (id: string) => ({ ...input.node, id }),
      deleteNodeWithProxyLifecycle: async (id: string, force: boolean, beforeLocalDelete?: (node: any) => void | Promise<void>) => {
        if (input.deleteError) throw input.deleteError;
        await beforeLocalDelete?.(input.node);
        input.calls.push(`delete:${id}:${force}`);
        return { deleted: true, revoke: { mode: "not-proxied", orphanRisk: false } };
      },
    } as any,
    events: { publish: () => undefined } as any,
    operationApprovals: {} as any,
    auth: { enabled: () => false } as any,
    nodeAgentTunnel: {} as any,
    nodeEventSubscriber: { syncNow: () => undefined } as any,
    errorPayload: (error: any) => ({ statusCode: 500, code: error?.code ?? "ERROR", message: error?.message ?? "error" }),
    releaseCloudRelayNode: async (nodeHandle: string) => {
      input.calls.push(`release:${nodeHandle}`);
    },
  });
  return app;
}

test("deleting a cloud-relay node releases its claim before removing the local record", async (t) => {
  const calls: string[] = [];
  const app = await testApp({
    calls,
    node: { connectionPath: { kind: "cloud-relay", nodeHandle: "nrh_macmini" } },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "DELETE", url: "/api/nodes/node_macmini" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ["release:nrh_macmini", "delete:node_macmini:false"]);
});

test("deleting a direct node keeps the local-only deletion path", async (t) => {
  const calls: string[] = [];
  const app = await testApp({
    calls,
    node: { connectionPath: { kind: "direct" } },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "DELETE", url: "/api/nodes/node_direct" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ["delete:node_direct:false"]);
});

test("deleting a direct node published to the cloud account releases its claim", async (t) => {
  const calls: string[] = [];
  const app = await testApp({
    calls,
    node: {
      connectionPath: { kind: "direct" },
      labels: { cloudAccountNodeHandle: "nrh_linked" },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "DELETE", url: "/api/nodes/node_linked" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ["release:nrh_linked", "delete:node_linked:false"]);
});

test("a failed delete does not release the cloud claim", async (t) => {
  const calls: string[] = [];
  const app = await testApp({
    calls,
    node: { connectionPath: { kind: "cloud-relay", nodeHandle: "nrh_macmini" } },
    deleteError: new Error("proxy revoke failed"),
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "DELETE", url: "/api/nodes/node_macmini" });

  assert.notEqual(response.statusCode, 200);
  assert.deepEqual(calls, []);
});
