const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const tar = require("tar");
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
const hasXz = !spawnSync("xz", ["--version"], { stdio: "ignore" }).error;

async function tarArchive(root, options = {}) {
  const source = path.join(root, "archive-source");
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.writeFileSync(path.join(source, "bin", "tool"), "tool\n");
  if (options.symlink) fs.symlinkSync("tool", path.join(source, "bin", "tool-link"));
  const file = path.join(root, options.gzip === false ? "artifact.tar" : "artifact.tar.gz");
  await tar.create({ cwd: source, file, gzip: options.gzip !== false, portable: true }, ["bin"]);
  return fs.readFileSync(file);
}

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

test("NVM npm recipes execute with the resolved Node bin environment", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-recipe-nvm-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nvmDir = path.join(root, "nvm");
  const nvmBin = path.join(nvmDir, "versions", "node", "v24.1.0", "bin");
  fs.mkdirSync(nvmBin, { recursive: true });
  const npm = path.join(nvmBin, "npm");
  fs.writeFileSync(npm, "#!/usr/bin/env node\n", { mode: 0o755 });
  const commands = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: "/managed",
    stateDir: "/state",
    env: { PATH: "/missing", NVM_DIR: nvmDir },
    commandRunner: async (command) => { commands.push(command); return { exitCode: 0, stdout: "ok", stderr: "" }; },
  });

  await execute("install", {
    type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex"], privilege: "user",
  }, {
    appId: "codex",
    capabilities: { platform: "linux", arch: "x64", installers: ["npm"], privilege: "user", installerAccess: { npmGlobalWritable: true } },
  });

  assert.equal(commands[0].executable, npm);
  assert.equal(commands[0].env.NVM_BIN, nvmBin);
  assert.equal(commands[0].env.NVM_DIR, nvmDir);
  assert.equal(commands[0].env.PATH, `${nvmBin}${path.delimiter}/missing`);
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
  const artifact = await tarArchive(root);
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  const phases = [];
  const execute = createAppRecipeExecutor({
    installBaseDir,
    stateDir,
    fetcher: async () => new Response(artifact, { status: 200, headers: { "content-length": String(artifact.length) } }),
    commandRunner: async () => assert.fail("archive extraction must not invoke a system tar command"),
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

test("archive install rejects links before extraction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-link-"));
  const artifact = await tarArchive(root, { symlink: true });
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "apps"),
    stateDir: path.join(root, "state"),
    fetcher: async () => new Response(artifact, { status: 200 }),
  });
  await assert.rejects(
    execute("install", { type: "archive", platforms: ["linux"], url: "https://downloads.example.test/tool.tar.gz", sha256, format: "tar.gz", installRoot: "tool" }, { appId: "tool", capabilities }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "unsafe_archive",
  );
  assert.equal(fs.existsSync(path.join(root, "apps", "tool")), false);
});

test("tar.xz archives are streamed through structured tar validation", { skip: !hasXz }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-xz-"));
  await tarArchive(root, { gzip: false });
  const compressed = spawnSync("xz", ["-c", path.join(root, "artifact.tar")], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(compressed.status, 0, compressed.stderr?.toString());
  const artifact = compressed.stdout;
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "apps"),
    stateDir: path.join(root, "state"),
    fetcher: async () => new Response(artifact, { status: 200 }),
  });
  await execute("install", { type: "archive", platforms: ["linux"], url: "https://downloads.example.test/tool.tar.xz", sha256, format: "tar.xz", installRoot: "tool" }, { appId: "tool", capabilities });
  assert.equal(fs.readFileSync(path.join(root, "apps", "tool", "bin", "tool"), "utf8"), "tool\n");
});

test("archive install never activates files without an ownership manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-manifest-"));
  const artifact = await tarArchive(root);
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  const blockedStateDir = path.join(root, "blocked-state");
  fs.writeFileSync(blockedStateDir, "not a directory");
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "apps"),
    stateDir: blockedStateDir,
    fetcher: async () => new Response(artifact, { status: 200 }),
  });
  await assert.rejects(
    execute("install", { type: "archive", platforms: ["linux"], url: "https://downloads.example.test/tool.tar.gz", sha256, format: "tar.gz", installRoot: "tool" }, { appId: "tool", capabilities }),
  );
  assert.equal(fs.existsSync(path.join(root, "apps", "tool")), false);
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
