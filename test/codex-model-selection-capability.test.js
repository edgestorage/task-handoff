const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { CodexAppServerSessionBridge } = require("../packages/ai-session-runtime/src/codex-app-server.ts");
const { CodexAppServerClient } = require("../packages/ai-session-runtime/src/codex-app-server/client/client.ts");

function clientFor(commandVersion) {
  return new CodexAppServerClient({
    command: "/opt/codex/bin/codex",
    resolveVersion: async () => commandVersion,
  });
}

test("answers capability probes from the artifact version before the app-server starts", async () => {
  const resolvedVersions = [];
  let versionRequests = 0;
  const client = new CodexAppServerClient({
    command: "/opt/codex/bin/codex",
    resolveVersion: async () => {
      versionRequests += 1;
      return "0.145.2";
    },
    onVersionResolved: (version) => resolvedVersions.push(version),
  });

  assert.equal(client.connected, false);
  // Fail closed while the version is still unknown, then answer from the artifact.
  assert.equal(client.supportsThreadSettingsUpdate(), false);
  assert.equal(await client.resolveAppServerVersion(), "0.145.2");
  assert.equal(client.connected, false);
  assert.equal(client.supportsThreadSettingsUpdate(), true);
  assert.equal(client.threadForkCapabilities().fullHistory, true);
  assert.equal(client.supportsPaginatedTimeline(), true);
  // Probing never spawns the app-server and never repeats the version lookup.
  await client.resolveAppServerVersion();
  assert.equal(versionRequests, 1);
  assert.deepEqual(resolvedVersions, ["0.145.2"]);
});

test("keeps capability probing unsupported for app-server artifacts below the version boundary", async () => {
  const client = clientFor("0.132.9");
  await client.resolveAppServerVersion();
  assert.equal(client.supportsThreadSettingsUpdate(), false);
});

test("prefers the live handshake user agent over the resolved artifact version", async () => {
  const client = clientFor("0.132.9");
  await client.resolveAppServerVersion();
  assert.equal(client.supportsThreadSettingsUpdate(), false);
  client.request = async () => ({ userAgent: "codex_cli_rs/0.144.1 (Linux; x86_64)" });
  client.notify = () => undefined;
  await client.initialize();
  assert.equal(client.supportsThreadSettingsUpdate(), true);
});

test("advertises in-session model switching before the app-server connects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-capability-"));
  const registry = createAiSessionRegistry({ dir: root });
  let releaseVersion;
  const versionGate = new Promise((resolve) => { releaseVersion = resolve; });
  let client;
  const republished = [];
  const bridge = new CodexAppServerSessionBridge(registry, {
    // The bridge must own the client options so it can subscribe to the
    // artifact version; the probe client is created on first capability query.
    createClient: (options) => {
      client = new CodexAppServerClient({
        ...options,
        command: "/opt/codex/bin/codex",
        resolveVersion: () => versionGate,
      });
      return client;
    },
    onCapabilitiesChanged: () => republished.push(bridge.supportsThreadSettingsUpdate()),
  });
  try {
    // Provider reload is a structural property of the client, not of a connection.
    assert.equal(bridge.supportsProviderReload(), true);
    assert.equal(bridge.supportsThreadSettingsUpdate(), false);
    assert.equal(client !== undefined, true);
    releaseVersion("0.144.1");
    await client.resolveAppServerVersion();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.supportsThreadSettingsUpdate(), true);
    // Owners republish the capability document as soon as the artifact answers.
    assert.deepEqual(republished, [true]);
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retries the artifact probe after a failed version lookup", async () => {
  let attempts = 0;
  const client = new CodexAppServerClient({
    command: "/opt/codex/bin/codex",
    resolveVersion: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("codex is not installed yet");
      return "0.145.2";
    },
  });

  assert.equal(client.supportsThreadSettingsUpdate(), false);
  await assert.rejects(client.resolveAppServerVersion());
  assert.equal(client.supportsThreadSettingsUpdate(), false);
  assert.equal(await client.resolveAppServerVersion(), "0.145.2");
  assert.equal(client.supportsThreadSettingsUpdate(), true);
  assert.equal(attempts, 2);
});

test("a failed artifact probe is retried by the next capability query", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-probe-retry-"));
  const registry = createAiSessionRegistry({ dir: root });
  let attempts = 0;
  const bridge = new CodexAppServerSessionBridge(registry, {
    createClient: () => new CodexAppServerClient({
      command: "/opt/codex/bin/codex",
      resolveVersion: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("codex is not installed yet");
        return "0.145.2";
      },
    }),
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    assert.equal(bridge.supportsThreadSettingsUpdate(), false);
    await flush();
    assert.equal(attempts, 1);
    assert.equal(bridge.supportsThreadSettingsUpdate(), false);
    await flush();
    assert.equal(attempts, 2);
    assert.equal(bridge.supportsThreadSettingsUpdate(), true);
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
