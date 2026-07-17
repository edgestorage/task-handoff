const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  AppRecipeExecutionError,
  createAppRecipeExecutor,
  runAppRecipeCommand,
  validateArchiveEntries,
} = require("../packages/controlled-instance/src/web/app-recipe-executor.ts");

const capabilities = { platform: "linux", arch: "x64", installers: ["apt"], privilege: "passwordless-sudo" };

test("timed out commands do not settle until an ignoring child process is killed", { skip: process.platform === "win32" }, async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runAppRecipeCommand({
      executable: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      // Leave enough time for the child to initialize its signal handler even
      // when the full test suite is running with many files in parallel.
      timeoutMs: 1_000,
      terminationGraceMs: 80,
    }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "command_timeout",
  );
  assert.equal(Date.now() - startedAt >= 1_080, true);
});

test("system package recipes use fixed executable and argument arrays without shell", async () => {
  const commands = [];
  const reportedCommands = [];
  const output = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: "/managed",
    stateDir: "/state",
    commandRunner: async (command, hooks) => {
      commands.push(command);
      hooks?.onOutput?.("stdout", `ran ${command.executable}\n`);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });
  const recipe = { type: "system-package", platforms: ["linux"], installer: "apt", packages: ["chromium", "chromium-sandbox"], privilege: "passwordless-sudo" };
  await execute("install", recipe, {
    appId: "chromium",
    capabilities,
    onCommand: (command) => reportedCommands.push(command),
    onOutput: (stream, chunk) => output.push({ stream, chunk }),
  });
  await execute("uninstall", recipe, { appId: "chromium", capabilities });
  assert.deepEqual(commands.map(({ executable, args }) => ({ executable, args })), [
    { executable: "sudo", args: ["-n", "apt-get", "update"] },
    { executable: "sudo", args: ["-n", "apt-get", "install", "-y", "--no-install-recommends", "chromium", "chromium-sandbox"] },
    { executable: "sudo", args: ["-n", "apt-get", "remove", "-y", "chromium", "chromium-sandbox"] },
  ]);
  assert.deepEqual(reportedCommands, [
    { executable: "sudo", args: ["-n", "apt-get", "update"] },
    { executable: "sudo", args: ["-n", "apt-get", "install", "-y", "--no-install-recommends", "chromium", "chromium-sandbox"] },
  ]);
  assert.deepEqual(output, [
    { stream: "stdout", chunk: "ran sudo\n" },
    { stream: "stdout", chunk: "ran sudo\n" },
  ]);
  assert.equal(commands.some((command) => Object.hasOwn(command, "shell")), false);
});

test("Codex npm recipes provide privilege-aware install and uninstall commands", async () => {
  const commands = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: "/managed",
    stateDir: "/state",
    commandRunner: async (command) => { commands.push(command); return { exitCode: 0, stdout: "ok", stderr: "" }; },
  });
  const recipe = { type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex"], privilege: "passwordless-sudo" };
  const context = { appId: "codex", capabilities: { platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo" } };

  await execute("install", recipe, context);
  await execute("uninstall", recipe, context);

  assert.deepEqual(commands.map(({ executable, args }) => ({ executable, args })), [
    { executable: "sudo", args: ["-n", "npm", "install", "--global", "--include=optional", "--no-audit", "--no-fund", "@openai/codex"] },
    { executable: "sudo", args: ["-n", "npm", "uninstall", "--global", "@openai/codex"] },
  ]);
});

test("Windows npm recipes run command shims through cmd.exe without shell mode", async () => {
  const commands = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: "C:\\managed",
    stateDir: "C:\\state",
    commandRunner: async (command) => { commands.push(command); return { exitCode: 0, stdout: "ok", stderr: "" }; },
  });
  const recipe = { type: "node-package", platforms: ["win32"], installer: "npm", packages: ["@anthropic-ai/claude-code"], privilege: "user" };
  const context = { appId: "claude", capabilities: { platform: "win32", arch: "x64", installers: ["npm"], privilege: "user", installerAccess: { npmGlobalWritable: true } } };

  await execute("install", recipe, context);
  await execute("uninstall", recipe, context);

  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.match(command.executable, /cmd\.exe$/i);
    assert.deepEqual(command.args.slice(0, 4), ["/d", "/s", "/c", "call"]);
    assert.match(command.args[4], /npm(?:\.cmd)?$/i);
    assert.equal(Object.hasOwn(command, "shell"), false);
  }
  assert.deepEqual(commands[0].args.slice(5), ["install", "--global", "--include=optional", "--no-audit", "--no-fund", "@anthropic-ai/claude-code"]);
  assert.deepEqual(commands[1].args.slice(5), ["uninstall", "--global", "@anthropic-ai/claude-code"]);
});

test("system package execution rejects invalid built-in package values and unavailable installers", async () => {
  const execute = createAppRecipeExecutor({ installBaseDir: "/managed", stateDir: "/state", commandRunner: async () => assert.fail("must not run") });
  await assert.rejects(
    execute("install", { type: "system-package", platforms: ["linux"], installer: "apt", packages: ["valid;touch-pwned"], privilege: "user" }, { appId: "tool", capabilities }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "invalid_builtin_recipe",
  );
  await assert.rejects(
    execute("install", { type: "system-package", platforms: ["linux"], installer: "dnf", packages: ["tool"], privilege: "user" }, { appId: "tool", capabilities }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "installer_unavailable",
  );
});

test("Node package execution rejects unsafe package values", async () => {
  const execute = createAppRecipeExecutor({ installBaseDir: "/managed", stateDir: "/state", commandRunner: async () => assert.fail("must not run") });
  await assert.rejects(
    execute("install", { type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex;touch-pwned"], privilege: "user" }, {
      appId: "codex",
      capabilities: { platform: "linux", arch: "x64", installers: ["npm"], privilege: "user" },
    }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "invalid_builtin_recipe",
  );
});

test("Codex npm uninstall removes only a validated stale retirement directory before one retry", async () => {
  const commands = [];
  let uninstallAttempts = 0;
  const execute = createAppRecipeExecutor({
    installBaseDir: "/managed",
    stateDir: "/state",
    commandRunner: async (command) => {
      commands.push(command);
      if (command.args.includes("uninstall") && uninstallAttempts++ === 0) {
        return {
          exitCode: 217,
          stdout: "",
          stderr: "npm ERR! code ENOTEMPTY\nnpm ERR! path /usr/local/lib/node_modules/@openai/codex\nnpm ERR! dest /usr/local/lib/node_modules/@openai/.codex-vdnmINeK\n",
        };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });
  await execute("uninstall", {
    type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex"], privilege: "passwordless-sudo",
  }, {
    appId: "codex",
    capabilities: { platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo" },
  });

  assert.deepEqual(commands.map(({ executable, args }) => ({ executable, args })), [
    { executable: "sudo", args: ["-n", "npm", "uninstall", "--global", "@openai/codex"] },
    { executable: "sudo", args: ["-n", "rm", "-rf", "--", "/usr/local/lib/node_modules/@openai/.codex-vdnmINeK"] },
    { executable: "sudo", args: ["-n", "npm", "uninstall", "--global", "@openai/codex"] },
  ]);
});

test("Node package recovery rejects unrelated ENOTEMPTY destinations", async () => {
  const commands = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: "/managed",
    stateDir: "/state",
    commandRunner: async (command) => {
      commands.push(command);
      return {
        exitCode: 217,
        stdout: "",
        stderr: "npm ERR! code ENOTEMPTY\nnpm ERR! path /usr/local/lib/node_modules/@openai/codex\nnpm ERR! dest /tmp/unrelated\n",
      };
    },
  });
  await assert.rejects(
    execute("uninstall", {
      type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex"], privilege: "passwordless-sudo",
    }, {
      appId: "codex",
      capabilities: { platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo" },
    }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "package_manager_failed",
  );
  assert.equal(commands.length, 1);
});

test("archive validation rejects absolute paths, parent traversal, and links", () => {
  assert.deepEqual(validateArchiveEntries([{ path: "bin/tool", type: "file" }, { path: "share", type: "directory" }]), ["bin/tool", "share"]);
  for (const entry of [
    { path: "/etc/passwd", type: "file" },
    { path: "../outside", type: "file" },
    { path: "bin/link", type: "symlink" },
    { path: "bin/hard", type: "hardlink" },
  ]) {
    assert.throws(() => validateArchiveEntries([entry]), (error) => error.code === "unsafe_archive");
  }
});

test("archive install verifies checksum before extraction and uninstall preserves unowned user files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-recipe-"));
  const installBaseDir = path.join(root, "apps");
  const stateDir = path.join(root, "state");
  const artifact = Buffer.from("trusted artifact bytes");
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  const phases = [];
  const execute = createAppRecipeExecutor({
    installBaseDir,
    stateDir,
    fetcher: async () => new Response(artifact, { status: 200, headers: { "content-length": String(artifact.length) } }),
    commandRunner: async (command) => {
      if (command.args[0] === "-tzvf") {
        return { exitCode: 0, stdout: "-rw-r--r-- user group 5 2026-07-16 00:00 bin/tool\n", stderr: "" };
      }
      const destination = command.args[command.args.indexOf("-C") + 1];
      fs.mkdirSync(path.join(destination, "bin"), { recursive: true });
      fs.writeFileSync(path.join(destination, "bin", "tool"), "tool\n");
      return { exitCode: 0, stdout: "bin/tool\n", stderr: "" };
    },
  });
  const recipe = { type: "archive", platforms: ["linux"], url: "https://downloads.example.test/tool.tar.gz", sha256, format: "tar.gz", installRoot: "tool" };
  await execute("install", recipe, { appId: "tool", capabilities, onPhase: (phase) => phases.push(phase) });
  assert.equal(fs.readFileSync(path.join(installBaseDir, "tool", "bin", "tool"), "utf8"), "tool\n");
  assert.deepEqual([...new Set(phases)], ["download", "inspect", "extract"]);
  fs.writeFileSync(path.join(installBaseDir, "tool", "user-config.json"), "{}\n");
  await execute("uninstall", recipe, { appId: "tool", capabilities });
  assert.equal(fs.existsSync(path.join(installBaseDir, "tool", "bin", "tool")), false);
  assert.equal(fs.readFileSync(path.join(installBaseDir, "tool", "user-config.json"), "utf8"), "{}\n");
  assert.equal(fs.existsSync(path.join(stateDir, "manifests", "tool.json")), false);
});

test("archive checksum failure never inspects or activates the artifact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-checksum-"));
  let commandCount = 0;
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "apps"),
    stateDir: path.join(root, "state"),
    fetcher: async () => new Response("tampered", { status: 200 }),
    commandRunner: async () => { commandCount += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  await assert.rejects(
    execute("install", { type: "archive", platforms: ["linux"], url: "https://downloads.example.test/tool.tar.gz", sha256: "a".repeat(64), format: "tar.gz", installRoot: "tool" }, { appId: "tool", capabilities }),
    (error) => error.code === "checksum_mismatch",
  );
  assert.equal(commandCount, 0);
  assert.equal(fs.existsSync(path.join(root, "apps", "tool")), false);
});
