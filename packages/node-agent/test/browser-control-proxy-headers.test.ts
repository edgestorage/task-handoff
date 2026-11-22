import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { browserControlIdentityHeaders } from "../src/instances/browser-control-proxy-headers.ts";
import { createInstanceProxyMetrics, registerInstanceProxyRoutes } from "../src/instances/proxy-routes.ts";

test("browser control identity headers preserve the verified Control Plane context", () => {
  assert.deepEqual(browserControlIdentityHeaders({
    "x-task-handoff-control-plane-id": " cpl_test ",
    "x-task-handoff-user-id": ["usr_test", "usr_ignored"],
  }), {
    "x-task-handoff-control-plane-id": "cpl_test",
    "x-task-handoff-user-id": "usr_test",
  });

  assert.throws(
    () => browserControlIdentityHeaders({ "x-task-handoff-user-id": "usr_test" }),
    (error: unknown) => (error as { code?: string }).code === "BROWSER_CHANNEL_IDENTITY_MISSING",
  );
});

test("instance websocket proxy forwards browser control identity headers upstream", async () => {
  const app = Fastify();
  await app.register(websocket);
  let upstreamHeaders: Record<string, string> | undefined;

  registerInstanceProxyRoutes(app, {
    fetchImpl: async () => new Response("{}"),
    metrics: createInstanceProxyMetrics(),
    instanceBase: async () => "http://127.0.0.1:9",
    syncModelEnvironment: async () => undefined,
    webSocketUpstreamHeaders: (_id, _path, headers) => ({
      authorization: "Bearer instance-token",
      ...browserControlIdentityHeaders(headers),
    }),
    webSocketFactory: (_url, _protocols, options) => {
      upstreamHeaders = options.headers;
      const upstream = new EventEmitter() as EventEmitter & {
        readyState: number;
        send: () => void;
        close: () => void;
      };
      upstream.readyState = 0;
      upstream.send = () => undefined;
      upstream.close = () => { upstream.readyState = 3; upstream.emit("close"); };
      setImmediate(() => { upstream.readyState = 1; upstream.emit("open"); });
      return upstream as unknown as WebSocket;
    },
    diagnostic: () => undefined,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const client = new WebSocket(
    `ws://127.0.0.1:${port}/api/node-agent/instances/inst_test/proxy/ws/api/browser-control/relay`,
    {
      headers: {
        "x-task-handoff-control-plane-id": "cpl_test",
        "x-task-handoff-user-id": "usr_test",
      },
    },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(upstreamHeaders, {
      authorization: "Bearer instance-token",
      "x-task-handoff-control-plane-id": "cpl_test",
      "x-task-handoff-user-id": "usr_test",
    });
  } finally {
    client.close();
    await app.close();
  }
});
