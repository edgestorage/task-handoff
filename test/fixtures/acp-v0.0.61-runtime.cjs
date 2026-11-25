const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const root = process.cwd();
const workspaceRequire = createRequire(path.join(root, "package.json"));
const ts = workspaceRequire("typescript");
workspaceRequire("./test/workspace-require.js").registerWorkspaceRequire(root);
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

async function run() {
  const { createControlPlaneAiSessionsApi } = workspaceRequire("./packages/control-plane-client/src/ai-sessions.ts");
  const { AiSessionPatchEventSchema } = workspaceRequire("./packages/protocol/src/ai-sessions.ts");
  const { CONTROL_PLANE_PROTOCOL_VERSION, normalizeControlledInstanceCapabilities } = workspaceRequire("./packages/protocol/src/control-plane.ts");
  const { createWebApp } = workspaceRequire("./packages/controlled-instance/src/web/server.ts");
  const { createAiSessionRegistry } = workspaceRequire("./packages/ai-session-runtime/src/ai-session-registry.ts");
  const { AiSessionHistoryStore } = workspaceRequire("./packages/ai-session-runtime/src/ai-session-history-store.ts");
  const { builtinManagedAppDefinitions } = workspaceRequire("./packages/app-runtime/src/catalog.ts");
  const { managedAppLauncherPath } = workspaceRequire("./packages/app-runtime/src/managed-node-apps.ts");
  process.env.TASK_HANDOFF_WEB_AUTH = "off";
  process.env.TASK_HANDOFF_AI_PROCESS_SCAN = "0";
  process.env.TASK_HANDOFF_AI_SESSION_SCAN = "0";
  process.env.TASK_HANDOFF_CODEX_APP_SERVER = "0";
  const data = process.env.TASK_HANDOFF_DATA_DIR;
  const registry = createAiSessionRegistry({ dir: path.join(data, "ai-sessions") });
  const history = new AiSessionHistoryStore({ dataDir: data });
  for (const [index, agent] of ["codex", "claude", "opencode", "gemini", "commandcode", "dsh"].entries()) {
    if (process.argv[2] === "legacy" && index >= 3) break;
    const timestamp = new Date().toISOString();
    history.upsert({
      id: `ses_${String(index + 1).padStart(13, "0")}`, agent, creationSource: "ai-session",
      providerSessionId: "shared-id", cwd: data, lastActiveAt: timestamp, archivedAt: timestamp,
    });
  }
  const managedApps = new Set(["codex", "claude", "opencode", "gemini", "commandcode", "dsh"]);
  for (const definition of builtinManagedAppDefinitions()) {
    const { id } = definition.launcher;
    if (!managedApps.has(id)) continue;
    process.env[`TASK_HANDOFF_ACP_${id.toUpperCase()}_ENABLED`] = "1";
    const launcher = managedAppLauncherPath(path.join(data, "managed-apps"), definition);
    if (!launcher) continue;
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const app = await createWebApp({ logger: false, aiSessionRegistry: registry, staticDir: path.join(data, "missing-static") });
  await app.ready();
  process.on("message", async ({ id, operation, payload }) => {
    try {
      let result;
      if (operation === "inject") {
        const response = await app.inject(payload);
        result = { statusCode: response.statusCode, body: response.json() };
      } else if (operation === "client-history") {
        const client = createControlPlaneAiSessionsApi({ request: (url, schema) => {
          const query = new URL(url, "http://fixture.invalid").search;
          return schema.parse(payload[query]);
        } });
        result = await client.history("inst_matrix", undefined, payload.agents);
      } else if (operation === "parse-capabilities") {
        result = normalizeControlledInstanceCapabilities(payload);
      } else if (operation === "contract") {
        result = { protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION };
      } else if (operation === "parse-patch") {
        result = AiSessionPatchEventSchema.parse(payload);
      } else if (operation === "seed-history") {
        history.upsert({
          id: "ses_0000000000009", agent: payload.agent, creationSource: "ai-session",
          providerSessionId: "future-id", cwd: data, lastActiveAt: payload.timestamp, archivedAt: payload.timestamp,
        });
        result = payload.agent;
      } else if (operation === "seed-approval") {
        const session = registry.start({ agent: "gemini", creationSource: "ai-session", providerSessionId: "active-id", cwd: data });
        registry.applyRealtimeEvent(session.id, {
          kind: "approval-requested", activeTurnId: "approval-turn", providerTurnId: "approval-turn",
          status: "waiting", phase: "approval", approvalRequest: { id: "test-request", decisions: ["allow"] },
        });
        result = session.id;
      } else if (operation === "stop") {
        await app.close();
        process.disconnect();
        return;
      } else throw new Error(`Unknown operation: ${operation}`);
      process.send({ id, result });
    } catch (error) {
      process.send({ id, error: error.stack });
    }
  });
  process.send({ ready: true });
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect();
});
