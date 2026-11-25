const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { prepareAcpLaunchConfig } = require("../packages/controlled-instance/src/web/acp-model-config.ts");

const selection = {
  modelEntityId: "model-primary",
  modelName: "Primary Label",
  modelUpstreamName: "upstream-primary",
};
const modelNames = [{ name: "Primary Label", upstreamName: "upstream-primary", order: 0 }];
const protocols = ["openai-chat-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

function directCatalog(endpoint) {
  return {
    protocolVersion: "2026-08-27",
    instanceId: "inst_test",
    entities: [{ id: "model-primary", protocols, modelNames, endpoint, key: "direct-key" }],
    updatedAt: "2026-11-25T00:00:00.000Z",
  };
}

function relayCatalog() {
  return {
    protocolVersion: "2026-10-02",
    instanceId: "inst_test",
    entities: [{
      id: "model-primary",
      protocols,
      modelNames,
      routes: [{ protocol: "google-generative-ai", baseUrl: "https://node.example/api/node-agent/model-relay/instances/inst_test/routes/rly_demo/v1" }],
    }],
    updatedAt: "2026-11-25T00:00:00.000Z",
  };
}

function temporaryDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-acp-config-"));
}

test("ACP Gemini launch config strips the version suffix Gemini appends itself", () => {
  const dataDir = temporaryDataDir();
  try {
    const direct = prepareAcpLaunchConfig({
      agent: "gemini",
      catalog: directCatalog("https://generativelanguage.googleapis.com/v1beta"),
      instanceCredential: "instance-token",
      modelSelection: selection,
      dataDir,
    });
    assert.equal(direct.env.GOOGLE_GEMINI_BASE_URL, "https://generativelanguage.googleapis.com");
    assert.equal(direct.env.GEMINI_MODEL, "upstream-primary");
    assert.equal(direct.env.GEMINI_API_KEY, "direct-key");

    const relay = prepareAcpLaunchConfig({
      agent: "gemini",
      catalog: relayCatalog(),
      instanceCredential: "instance-token",
      modelSelection: selection,
      dataDir,
    });
    assert.equal(relay.env.GOOGLE_GEMINI_BASE_URL, "https://node.example/api/node-agent/model-relay/instances/inst_test/routes/rly_demo/v1");
    assert.equal(relay.env.GEMINI_API_KEY, "instance-token");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("ACP Gemini privileged modes trust only the session workspace", () => {
  const dataDir = temporaryDataDir();
  try {
    const config = prepareAcpLaunchConfig({
      agent: "gemini",
      dataDir,
      cwd: "/workspace/demo",
    });
    assert.ok(config.cleanupDir);
    assert.ok(config.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(config.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH, "utf8")),
      { "/workspace/demo": "TRUST_FOLDER" },
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("ACP Command Code and dsh receive private configured-model files", () => {
  const dataDir = temporaryDataDir();
  try {
    const commandcode = prepareAcpLaunchConfig({
      agent: "commandcode",
      catalog: directCatalog("https://models.example/v1"),
      instanceCredential: "instance-token",
      modelSelection: selection,
      dataDir,
    });
    assert.equal(commandcode.env.HOME, commandcode.cleanupDir);
    assert.equal(commandcode.env.COMMAND_CODE_API_KEY, "task-handoff-local-only");
    assert.equal(commandcode.env.CMD_LOCAL_ONLY, "1");
    const commandCodeFile = path.join(commandcode.cleanupDir, ".commandcode", "providers.json");
    const commandCodeConfig = JSON.parse(fs.readFileSync(commandCodeFile, "utf8"));
    assert.deepEqual(commandCodeConfig.provider["task-handoff-model-primary"].models["upstream-primary"], {
      name: "Primary Label",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    const sessionFile = path.join(commandcode.cleanupDir, ".commandcode", "sessions", "session-1.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{\"message\":\"kept\"}\n");
    commandcode.persistSessionHome("session-1");
    const resumed = prepareAcpLaunchConfig({
      agent: "commandcode",
      catalog: directCatalog("https://models.example/v1"),
      instanceCredential: "instance-token",
      modelSelection: selection,
      dataDir,
      providerSessionId: "session-1",
    });
    assert.equal(fs.readFileSync(path.join(resumed.cleanupDir, ".commandcode", "sessions", "session-1.jsonl"), "utf8"), "{\"message\":\"kept\"}\n");
    assert.equal(fs.existsSync(path.join(resumed.cleanupDir, ".commandcode", "providers.json")), true);

    const dsh = prepareAcpLaunchConfig({
      agent: "dsh",
      catalog: directCatalog("https://models.example/v1"),
      instanceCredential: "instance-token",
      modelSelection: selection,
      dataDir,
    });
    assert.equal(dsh.env.DSH_HOME, dsh.cleanupDir);
    assert.equal(dsh.args.length, 2);
    assert.equal(dsh.args[0], "--patch");
    const patch = fs.readFileSync(dsh.args[1], "utf8");
    assert.match(patch, /^\- id: llm-pi-ai\n/);
    assert.match(patch, /"task-handoff-model-primary":/);
    assert.match(patch, /- id: "upstream-primary"/);

    const googleCatalog = directCatalog("https://models.example/v1beta");
    googleCatalog.entities[0].protocols = ["google-generative-ai"];
    const dshGoogle = prepareAcpLaunchConfig({
      agent: "dsh",
      catalog: googleCatalog,
      instanceCredential: "instance-token",
      modelSelection: selection,
      dataDir,
    });
    const googlePatch = fs.readFileSync(dshGoogle.args[1], "utf8");
    assert.match(googlePatch, /baseURL: "https:\/\/models.example\/v1beta"/);
    assert.doesNotMatch(googlePatch, /xhigh:/);

    const dshRelay = prepareAcpLaunchConfig({
      agent: "dsh",
      catalog: relayCatalog(),
      instanceCredential: "instance-token",
      modelSelection: selection,
      dataDir,
    });
    const relayPatch = fs.readFileSync(dshRelay.args[1], "utf8");
    assert.match(relayPatch, /baseURL: "https:\/\/node.example\/api\/node-agent\/model-relay\/instances\/inst_test\/routes\/rly_demo\/v1\/v1beta"/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
