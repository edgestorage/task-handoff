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

const {
  CodexAppServerClient,
  codexCliInvocation,
  codexThreadSettingsUpdateSupported,
  parseCodexCliVersion,
} = require("../packages/ai-session-runtime/src/codex-app-server/client/client.ts");

test("parses stable and prerelease Codex CLI versions", () => {
  assert.equal(parseCodexCliVersion("codex-cli 0.144.1\n"), "0.144.1");
  assert.equal(parseCodexCliVersion("codex-cli 0.145.0-alpha.18\n"), "0.145.0-alpha.18");
  assert.equal(parseCodexCliVersion("codex v1.2.3+managed\n"), "1.2.3+managed");
  assert.equal(parseCodexCliVersion("wrapper 1.2.3\n"), undefined);
});

test("gates thread settings updates at the verified Codex 0.133.0 boundary", () => {
  assert.equal(codexThreadSettingsUpdateSupported(undefined), false);
  assert.equal(codexThreadSettingsUpdateSupported("codex-cli/0.132.9"), false);
  assert.equal(codexThreadSettingsUpdateSupported("codex-cli/0.133.0"), true);
  assert.equal(codexThreadSettingsUpdateSupported("codex-cli/0.144.1"), true);
});

test("probes the Codex CLI through the win32 shim wrapper", (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-invocation-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "codex.cmd"), "@echo off\r\n", { mode: 0o755 });

  const launch = codexCliInvocation("codex", ["--version"], {
    env: { PATH: bin, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    platform: "win32",
  });
  assert.equal(launch.interpreterWrapped, true);
  assert.equal(launch.executable, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(launch.args.slice(0, 4), ["/d", "/s", "/c", "call"]);
  assert.equal(path.basename(launch.args[4]).toLowerCase(), "codex.cmd");
  assert.deepEqual(launch.args.slice(5), ["--version"]);
});

test("launches the caller's command unchanged when no shim wrapper is needed", () => {
  const env = { PATH: "/nonexistent" };
  const launch = codexCliInvocation("codex", ["app-server", "--listen", "stdio://"], { env, platform: "linux" });
  assert.equal(launch.interpreterWrapped, false);
  assert.equal(launch.executable, "codex");
  assert.deepEqual(launch.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(launch.env, env);
});

test("initializes Codex app-server with the TUI identity and detected version", async () => {
  const versionCommands = [];
  const requests = [];
  const client = new CodexAppServerClient({
    command: "/opt/codex/bin/codex",
    resolveVersion: async (command) => {
      versionCommands.push(command);
      return "0.145.0-alpha.18";
    },
  });
  client.request = async (method, params) => {
    requests.push({ method, params });
    return { userAgent: "codex_cli_rs/0.145.0-alpha.18 (Linux; x86_64)" };
  };
  client.notify = () => undefined;

  await client.initialize();

  assert.deepEqual(versionCommands, ["/opt/codex/bin/codex"]);
  assert.deepEqual(requests, [{
    method: "initialize",
    params: {
      clientInfo: { name: "codex-tui", version: "0.145.0-alpha.18" },
      capabilities: { experimentalApi: true },
    },
  }]);
});

test("does not initialize app-server when the Codex version cannot be resolved", async () => {
  let requested = false;
  const client = new CodexAppServerClient({
    resolveVersion: async () => {
      throw Object.assign(new Error("version unavailable"), { code: "CODEX_VERSION_DETECTION_FAILED" });
    },
  });
  client.request = async () => {
    requested = true;
    return {};
  };

  await assert.rejects(client.initialize(), { code: "CODEX_VERSION_DETECTION_FAILED" });
  assert.equal(requested, false);
});

test("cleans up an uninitialized stdio process and retries version detection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-client-"));
  const command = path.join(directory, "fake-codex");
  fs.writeFileSync(command, `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      const request = JSON.parse(line);
      if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "codex_cli_rs/0.145.0" } }) + "\\n");
    }
    newline = buffer.indexOf("\\n");
  }
});
`);
  fs.chmodSync(command, 0o755);
  let attempts = 0;
  const client = new CodexAppServerClient({
    command,
    resolveVersion: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("temporary version failure"), { code: "CODEX_VERSION_DETECTION_FAILED" });
      return "0.145.0";
    },
  });

  try {
    await assert.rejects(client.start(), { code: "CODEX_VERSION_DETECTION_FAILED" });
    assert.equal(client.connected, false);
    await client.start();
    assert.equal(client.connected, true);
    assert.equal(attempts, 2);
  } finally {
    client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
