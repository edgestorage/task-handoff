const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const WebSocket = require("ws");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { CodexAppServerClient } = require("../packages/ai-session-runtime/src/codex-app-server/client/client.ts");
const { CodexAppServerConnectionProxy } = require("../packages/app-runtime/src/codex-app-server-proxy.ts");
const { createCodexAppServerToken } = require("../packages/app-runtime/src/runtime-utils.ts");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function tokenFixture(t, token) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-ws-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, "app-server-token");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  return tokenFile;
}

/**
 * Minimal stand-in for `codex app-server --listen ws://127.0.0.1:<port>
 * --ws-auth capability-token --ws-token-file <file>`: it only accepts the
 * bearer token and answers initialize plus thread/start.
 */
function fakeAppServer(t, options = {}) {
  const token = options.token ?? createCodexAppServerToken();
  return freePort().then((port) => {
    const server = new WebSocket.WebSocketServer({
      host: "127.0.0.1",
      port,
      verifyClient: (info, done) => {
        const authorized = info.req.headers.authorization === `Bearer ${token}`;
        if (authorized) done(true);
        else done(false, 401, "Unauthorized");
      },
    });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake-app-server/0.0.0" } }));
        }
        if (message.method === "thread/start") {
          socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "thread_ws", status: { type: "idle" } } } }));
        }
      });
    });
    t.after(() => {
      for (const socket of server.clients) socket.terminate();
      return new Promise((resolve) => server.close(resolve));
    });
    return { endpoint: `ws://127.0.0.1:${port}`, token, port };
  });
}

test("the codex client connects to a loopback app-server with its capability token", async (t) => {
  const appServer = await fakeAppServer(t);
  const tokenFile = tokenFixture(t, appServer.token);
  const client = new CodexAppServerClient({
    endpoint: appServer.endpoint,
    tokenFile,
    command: "codex",
    resolveVersion: async () => "0.161.0",
  });
  t.after(() => client.stop());

  await client.start();
  assert.equal(client.isConnected(), true);
  client.stop();
});

test("the codex client surfaces an unauthorized loopback app-server", async (t) => {
  const appServer = await fakeAppServer(t);
  const tokenFile = tokenFixture(t, "not-the-capability-token");
  const client = new CodexAppServerClient({
    endpoint: appServer.endpoint,
    tokenFile,
    command: "codex",
    resolveVersion: async () => "0.161.0",
  });

  await assert.rejects(client.start(), /rejected the connection: http 401/);
  client.stop();
});

test("the codex client reports an unreadable capability token file", async (t) => {
  const appServer = await fakeAppServer(t);
  const client = new CodexAppServerClient({
    endpoint: appServer.endpoint,
    tokenFile: path.join(os.tmpdir(), "task-handoff-missing-token-file"),
    command: "codex",
    resolveVersion: async () => "0.161.0",
  });

  await assert.rejects(client.start(), /token file is unreadable/);
  client.stop();
});

test("the app-server proxy relays a websocket upstream and records thread bindings", async (t) => {
  const appServer = await fakeAppServer(t);
  const tokenFile = tokenFixture(t, appServer.token);
  const boundThreads = [];
  const proxyPort = await freePort();
  const proxy = new CodexAppServerConnectionProxy(
    { transport: "ws", endpoint: appServer.endpoint, tokenFile },
    (threadId) => boundThreads.push(threadId),
  );
  proxy.start(proxyPort);
  t.after(() => proxy.stop());
  assert.equal(proxy.endpoint, `ws://127.0.0.1:${proxyPort}`);

  const client = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  t.after(() => client.terminate());

  const answer = new Promise((resolve, reject) => {
    client.once("message", (data) => resolve(JSON.parse(data.toString())));
    client.once("error", reject);
  });
  client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }));
  assert.equal((await answer).result.thread.id, "thread_ws");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(boundThreads, ["thread_ws"]);
});

test("the app-server proxy drops a websocket client when the token file is unreadable", async (t) => {
  const appServer = await fakeAppServer(t);
  const proxyPort = await freePort();
  const proxy = new CodexAppServerConnectionProxy(
    { transport: "ws", endpoint: appServer.endpoint, tokenFile: path.join(os.tmpdir(), "task-handoff-missing-token-file") },
    () => { throw new Error("no thread binding expected"); },
  );
  proxy.start(proxyPort);
  t.after(() => proxy.stop());

  const client = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
  const closed = await new Promise((resolve) => {
    client.once("close", () => resolve(true));
    client.once("error", () => resolve(true));
    client.once("open", () => client.send(JSON.stringify({ id: 1, method: "initialize", params: {} })));
  });
  assert.equal(closed, true);
});
