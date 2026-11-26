const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const root = path.resolve(process.argv[2] || "");
const baseUrl = process.argv[3];
if (!root || !baseUrl) throw new Error("usage: acp-v0.0.61-http-client.cjs <v0.0.61 checkout> <base url>");

const workspaceRequire = createRequire(path.join(root, "package.json"));
const typescript = workspaceRequire("typescript");
workspaceRequire("./test/workspace-require.js").registerWorkspaceRequire(root);
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = typescript.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

async function read(pathname) {
  const response = await fetch(new URL(pathname, baseUrl));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data;
}

async function run() {
  const {
    CONTROL_PLANE_PROTOCOL_VERSION,
    normalizeControlledInstanceCapabilities,
  } = workspaceRequire("./packages/protocol/src/control-plane.ts");
  const {
    AiSessionHistoryListSchema,
    AiSessionsSnapshotSchema,
  } = workspaceRequire("./packages/protocol/src/ai-sessions.ts");

  const status = await read("/api/instance/status");
  assert.equal(status.protocolVersion, CONTROL_PLANE_PROTOCOL_VERSION, "node-agent connection protocol is unchanged");
  AiSessionsSnapshotSchema.parse(status.aiSessions);

  const capabilities = normalizeControlledInstanceCapabilities(status.capabilities);
  const providers = Object.fromEntries(
    capabilities.features.aiSessionProviders.map((provider) => [provider.agent, provider]),
  );
  assert.deepEqual(Object.keys(providers).sort(), ["claude", "codex", "commandcode", "dsh", "gemini", "opencode"]);

  assert.deepEqual(
    { ...providers.codex.actions, historyResume: undefined },
    {
      create: true, send: true, queue: true, steer: true, interrupt: true,
      archive: true, delete: true, fork: true, rename: true,
      approvalDecisions: ["allow", "deny", "skip"], historyResume: undefined,
    },
  );
  assert.deepEqual(
    { ...providers.claude.actions, historyResume: undefined },
    {
      create: false, send: true, queue: true, steer: true, interrupt: true,
      archive: true, delete: false, fork: false, rename: false,
      approvalDecisions: [], historyResume: undefined,
    },
  );
  assert.deepEqual(
    { ...providers.opencode.actions, historyResume: undefined },
    {
      create: true, send: true, queue: true, steer: true, interrupt: true,
      archive: true, delete: true, fork: true, rename: true,
      approvalDecisions: ["allow", "deny"], historyResume: undefined,
    },
  );

  for (const [agent, historyResume] of [["gemini", true], ["commandcode", true], ["dsh", false]]) {
    assert.deepEqual(providers[agent].actions, {
      create: true,
      send: true,
      queue: false,
      steer: false,
      interrupt: true,
      archive: false,
      historyResume,
      delete: false,
      fork: false,
      rename: false,
      approvalDecisions: ["allow", "deny"],
    }, `${agent} actions`);
    assert.deepEqual(providers[agent].permissionModes, [], `${agent} permission modes`);
    assert.deepEqual(providers[agent].timeline, { sessionRead: true, turnRead: true, liveItems: true }, `${agent} timeline`);
  }

  const history = AiSessionHistoryListSchema.parse(
    await read("/api/ai-sessions/history?hierarchy=subagents&agents=*"),
  );
  assert.deepEqual(history.items.map(({ agent }) => agent).sort(), ["claude", "codex", "commandcode", "dsh", "gemini", "opencode"]);
  assert.equal(new Set(history.items.map(({ id }) => id)).size, history.items.length);

  const nativeHistory = AiSessionHistoryListSchema.parse(
    await read("/api/ai-sessions/history?hierarchy=subagents&agents=codex%2Cclaude%2Copencode"),
  );
  assert.deepEqual(nativeHistory.items.map(({ agent }) => agent).sort(), ["claude", "codex", "opencode"]);

  const futureCapabilities = normalizeControlledInstanceCapabilities({
    ...status.capabilities,
    futureRoot: { ignored: true },
    features: {
      ...status.capabilities.features,
      futureFeature: { ignored: true },
      aiSessionProviders: [
        ...status.capabilities.features.aiSessionProviders,
        {
          agent: "future-agent",
          actions: { create: true, send: true, historyResume: true, futureAction: "ignored" },
          permissionModes: [],
          timeline: { sessionRead: true, turnRead: true, liveItems: true, futureTimelineField: true },
          futureCapability: { ignored: true },
        },
      ],
    },
  });
  const futureProviders = Object.fromEntries(futureCapabilities.features.aiSessionProviders.map((provider) => [provider.agent, provider]));
  assert.equal(futureProviders["future-agent"].actions.create, true);
  assert.equal(futureProviders["future-agent"].actions.historyResume, true);
  assert.equal(futureCapabilities.features.futureFeature.ignored, true);
  for (const agent of ["codex", "claude", "opencode"]) {
    assert.deepEqual(futureProviders[agent], providers[agent], `${agent} remains readable with future capabilities`);
  }

  process.stdout.write(JSON.stringify({
    protocolVersion: status.protocolVersion,
    providers: Object.keys(providers).sort(),
    history: history.items.map(({ id, agent }) => ({ id, agent })),
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
