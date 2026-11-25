import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import Fastify from "fastify";
import { NodeSchema } from "@task-handoff/protocol/control-plane";
import { ControlPlaneService } from "../src/control-plane/application/service.ts";
import { registerStoryRoutes } from "../src/control-plane/http/story-routes.ts";
import type { NodeAgentWebSocket } from "../src/control-plane/nodes/client.ts";
import { NodeConnectionRuntime } from "../src/control-plane/nodes/connection-runtime.ts";
import { ControlPlaneNodeAgentTunnelTransport, ControlPlaneNodeEventSubscriber } from "../src/control-plane/nodes/tunnel.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

test("a local Story transport failure and signal from the recovered node produce an offline-to-online projection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-story-recovery-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const runtime = new NodeConnectionRuntime();
  const app = Fastify();
  const timestamp = "2026-11-25T00:00:00.000Z";
  const endpoint = "http://127.0.0.1:18080";
  const node = NodeSchema.parse({ id: "node_local_story", name: "Local", connectionMode: "local-loopback", endpoint, status: "online", health: "ok", createdAt: timestamp, updatedAt: timestamp });
  const story = { id: "story_local", ownerNodeId: node.id, title: "Local Story", documents: [], actions: [], createdAt: timestamp, updatedAt: timestamp };
  let httpOnline = true;
  const requests: string[] = [];
  const fetchImpl = (async (input: string) => {
    const { pathname } = new URL(input);
    requests.push(pathname);
    if (!httpOnline) throw new Error("Node agent listener is down");
    return Response.json({ data: pathname.endsWith("/stories") ? { stories: [story] } : { ok: true } });
  }) as typeof fetch;
  const service = new ControlPlaneService(paths, { database, secrets, fetchImpl, nodeConnectionRuntime: runtime });
  const subscriber = new ControlPlaneNodeEventSubscriber(service, new ControlPlaneNodeAgentTunnelTransport(), { connectionRuntime: runtime });
  t.after(async () => {
    subscriber.stop();
    await app.close();
    service.dispose();
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.init();
  await service.nodes.put(node);
  runtime.observedReachable(node);
  const projected: string[] = [];
  runtime.onChange(({ nodeId }) => {
    if (nodeId === node.id) projected.push(service.requirePublicNode(nodeId).status);
  });
  registerStoryRoutes(app, service);
  const list = () => app.inject({ method: "GET", url: `/api/stories?nodeId=${node.id}` });
  const sockets: NodeAgentWebSocket[] = [];
  const reconnected = Promise.withResolvers<NodeAgentWebSocket>();
  service.resolveNodeAgentTransport(node).proxyWebSocket = (_node, socket) => {
    sockets.push(socket);
    if (sockets.length === 2) reconnected.resolve(socket);
  };
  const hello = JSON.stringify({ type: "node-agent.events.connected" });
  subscriber.start();
  assert.equal(sockets.length, 1);
  sockets[0].send(hello);
  assert.deepEqual(requests, [], "a healthy HTTP path does not need a redundant probe");

  httpOnline = false;
  projected.length = 0;
  sockets[0].close(1001, "Local node stopped");
  const failed = await list();
  assert.deepEqual(failed.json().data, { stories: [], unavailableNodeIds: [node.id] });

  httpOnline = true;
  const socket = await reconnected.promise;
  socket.send(hello);
  socket.send(hello);
  await setImmediate();

  assert.deepEqual(projected.filter((status, index) => status !== projected[index - 1]), ["online", "offline", "online"]);
  assert.deepEqual(requests, ["/api/node-agent/stories", "/api/node-agent/health"]);
  const recovered = await list();
  assert.deepEqual(recovered.json().data, { stories: [story], unavailableNodeIds: [] });
});
