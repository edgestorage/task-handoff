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

async function npmPackageArchive(root, options = {}) {
  const source = path.join(root, options.sourceName || "npm-source");
  const packageRoot = path.join(source, "package");
  const launcher = path.join(packageRoot, "vendor", "bin", "tool");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "native-tool", version: options.version || "1.2.3", scripts: { postinstall: "exit 99" } }));
  fs.writeFileSync(launcher, options.body || "#!/bin/sh\nprintf '1.2.3\\n'\n", { mode: 0o755 });
  if (options.symlink) fs.symlinkSync(options.symlink, path.join(packageRoot, "vendor", "bin", "tool-link"));
  const file = path.join(root, options.sourceName ? `${options.sourceName}.tgz` : "native-package.tgz");
  await tar.create({ cwd: source, file, gzip: true, portable: true }, ["package"]);
  return fs.readFileSync(file);
}

function sri(value) {
  return `sha512-${crypto.createHash("sha512").update(value).digest("base64")}`;
}

function installSourcePolicy(npmRegistry) {
  return {
    createExecutionPolicy: () => ({
      revision: 1,
      effective: { npmRegistry },
      npmRegistry,
      prepareNodeRuntime: async () => { throw new Error("native package source checks must not prepare Node"); },
      nodeEnvironment: (env) => env,
      aptSourceConfiguration: () => undefined,
    }),
  };
}

function requestRange(init) {
  return new Headers(init?.headers).get("range");
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

test("system package updates refresh the apt index and use --only-upgrade", async () => {
  const commands = [];
  const phases = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: "/managed",
    stateDir: "/state",
    env: {},
    commandRunner: async (command) => { commands.push(command); return { exitCode: 0, stdout: "ok", stderr: "" }; },
  });
  const recipe = { type: "system-package", platforms: ["linux"], installer: "apt", packages: ["chromium"], privilege: "passwordless-sudo" };
  await execute("update", recipe, { appId: "chromium", capabilities, onPhase: (phase) => phases.push(phase) });
  assert.deepEqual(commands.map(({ executable, args }) => ({ executable, args })), [
    { executable: "sudo", args: ["-n", "apt-get", "update"] },
    { executable: "sudo", args: ["-n", "apt-get", "install", "-y", "--only-upgrade", "--no-install-recommends", "chromium"] },
  ]);
  assert.deepEqual(phases, ["update-package"]);
});

test("Codex npm recipes provide privilege-aware install and uninstall commands", async () => {
  const commands = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: "/managed",
    stateDir: "/state",
    env: {},
    commandRunner: async (command) => { commands.push(command); return { exitCode: 0, stdout: "ok", stderr: "" }; },
  });
  const recipe = { type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex"], privilege: "passwordless-sudo" };
  const context = { appId: "codex", capabilities: { platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo" } };

  await execute("install", recipe, context);
  await execute("uninstall", recipe, context);
  await execute("update", recipe, context);

  const expected = [
    ["install", "--global", "--include=optional", "--no-audit", "--no-fund", "@openai/codex"],
    ["uninstall", "--global", "@openai/codex"],
    ["install", "--global", "--include=optional", "--no-audit", "--no-fund", "@openai/codex"],
  ];
  assert.equal(commands.length, expected.length);
  for (const [index, command] of commands.entries()) {
    assert.equal(command.executable, "sudo");
    assert.deepEqual(command.args.slice(0, 3), ["-n", "env", "npm_config_cache=/state/npm-cache"]);
    assert.match(command.args[3], /npm$/);
    assert.deepEqual(command.args.slice(4), expected[index]);
  }
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
    env: {},
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

  assert.equal(commands.length, 3);
  for (const command of [commands[0], commands[2]]) {
    assert.equal(command.executable, "sudo");
    assert.deepEqual(command.args.slice(0, 3), ["-n", "env", "npm_config_cache=/state/npm-cache"]);
    assert.match(command.args[3], /npm$/);
    assert.deepEqual(command.args.slice(4), ["uninstall", "--global", "@openai/codex"]);
  }
  assert.deepEqual(commands[1], {
    executable: "sudo",
    args: ["-n", "rm", "-rf", "--", "/usr/local/lib/node_modules/@openai/.codex-vdnmINeK"],
    timeoutMs: 60_000,
  });
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

test("archive update re-verifies the checksum and atomically replaces the managed install", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-recipe-update-"));
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
  await execute("install", recipe, { appId: "tool", capabilities });
  fs.writeFileSync(path.join(installBaseDir, "tool", "user-config.json"), "{}\n");
  await execute("update", recipe, { appId: "tool", capabilities, onPhase: (phase) => phases.push(phase) });
  assert.equal(fs.readFileSync(path.join(installBaseDir, "tool", "bin", "tool"), "utf8"), "tool\n");
  assert.equal(fs.readFileSync(path.join(installBaseDir, "tool", "user-config.json"), "utf8"), "{}\n");
  assert.deepEqual([...new Set(phases)], ["download", "inspect", "extract"]);
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

test("Managed npm recipes install into the instance prefix and remove only that managed tree", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-node-app-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    commandRunner: async (command) => {
      commands.push(command);
      const prefix = command.args[command.args.indexOf("--prefix") + 1];
      const packageRoot = path.join(prefix, "node_modules", "@openai", "codex");
      fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "bin", "codex.js"), "#!/usr/bin/env node\n");
      fs.chmodSync(path.join(packageRoot, "bin", "codex.js"), 0o755);
      fs.mkdirSync(path.join(prefix, "node_modules", ".bin"), { recursive: true });
      fs.symlinkSync(path.join("..", "@openai", "codex", "bin", "codex.js"), path.join(prefix, "node_modules", ".bin", "codex"));
      fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ bin: { codex: "bin/codex.js" } }));
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });
  const recipe = {
    type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex"],
    managed: true, version: "0.165.0", privilege: "user",
  };
  const executionContext = {
    appId: "codex",
    capabilities: { platform: "linux", arch: "x64", installers: ["npm"], privilege: "user", installerAccess: { npmGlobalWritable: false } },
  };

  await execute("install", recipe, executionContext);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].args.includes("--global"), false);
  assert.ok(commands[0].args.includes("--prefix"));
  assert.ok(commands[0].args.includes("@openai/codex@0.165.0"));
  const target = path.join(root, "managed-apps", "node-package", "codex");
  assert.equal(fs.existsSync(path.join(target, "managed-app.json")), true);
  assert.equal(fs.existsSync(path.join(target, "node_modules", "@openai", "codex", "bin", "codex.js")), true);

  await execute("uninstall", recipe, executionContext);
  assert.equal(fs.existsSync(target), false);
  assert.equal(commands.length, 1);
});

test("Managed npm recipes keep the previous install when staging validation fails", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-node-app-failed-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "managed-apps", "node-package", "codex");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "managed-app.json"), JSON.stringify({ appId: "codex", packages: { "@openai/codex": "0.164.0" } }));
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    commandRunner: async () => ({ exitCode: 0, stdout: "installed nothing", stderr: "" }),
  });

  await assert.rejects(
    execute("update", {
      type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex"],
      managed: true, version: "0.165.0", privilege: "user",
    }, {
      appId: "codex",
      capabilities: { platform: "linux", arch: "x64", installers: ["npm"], privilege: "user" },
    }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "postcondition_failed",
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "managed-app.json"), "utf8")).packages["@openai/codex"], "0.164.0");
});

for (const launcher of ["missing", "external"]) {
  test(`Managed npm activation rejects a ${launcher} launcher and preserves the working install`, { skip: process.platform === "win32" }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-launcher-validation-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installBaseDir = path.join(root, "managed-apps");
    const target = path.join(installBaseDir, "node-package", "codex", "node_modules", ".bin", "codex");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "#!/bin/sh\nprintf previous-version\n", { mode: 0o755 });
    const external = path.join(root, "global-codex");
    fs.writeFileSync(external, "#!/bin/sh\nprintf global-version\n", { mode: 0o755 });
    const execute = createAppRecipeExecutor({
      installBaseDir, stateDir: path.join(root, "state"),
      commandRunner: async (command) => {
        const prefix = command.args[command.args.indexOf("--prefix") + 1];
        const packageRoot = path.join(prefix, "node_modules", "@openai", "codex");
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ bin: { codex: "cli.js" } }));
        fs.writeFileSync(path.join(packageRoot, "cli.js"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        if (launcher === "external") {
          fs.mkdirSync(path.join(prefix, "node_modules", ".bin"), { recursive: true });
          fs.symlinkSync(external, path.join(prefix, "node_modules", ".bin", "codex"));
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    await assert.rejects(execute("update", {
      type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex"], managed: true, version: "0.165.0", privilege: "user",
    }, { appId: "codex", capabilities: { platform: "linux", arch: "x64", installers: ["npm"], privilege: "user" } }),
    (error) => error.code === "postcondition_failed");
    assert.equal(spawnSync(target, [], { encoding: "utf8" }).stdout, "previous-version");
  });
}

test("native npm packages install without npm or node and uninstall only the manifest-owned tree", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-package-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installBaseDir = path.join(root, "managed-apps");
  const archive = await npmPackageArchive(root);
  const commands = [];
  const execute = createAppRecipeExecutor({
    installBaseDir,
    stateDir: path.join(root, "state"),
    fetcher: async () => new Response(archive, { headers: { "content-length": String(archive.length) } }),
    commandRunner: async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "1.2.3\n", stderr: "" };
    },
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: sri(archive),
    launchPath: "vendor/bin/tool", tarballUrl: "https://registry.example.test/native-tool.tgz", privilege: "user",
  };
  const executionContext = { appId: "native-tool", capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" } };
  await execute("install", recipe, executionContext);

  const target = path.join(installBaseDir, "native", "native-tool");
  const launcher = path.join(target, "vendor", "bin", "tool");
  assert.equal(fs.statSync(launcher).mode & 0o111, 0o111);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].args.join(" "), "--version");
  assert.equal(commands[0].executable.endsWith("/vendor/bin/tool"), true);
  assert.equal(commands[0].executable.includes(`${path.sep}native${path.sep}.staging${path.sep}`), true);
  assert.equal(commands.some(({ executable }) => /(?:^|\/)(?:npm|node)(?:\.exe|\.cmd)?$/.test(executable)), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(target, "managed-app.json"), "utf8"));
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.packageVersion, "1.2.3-linux-x64");
  assert.equal(manifest.installRoot, target);
  assert.equal(manifest.files.includes("vendor/bin/tool"), true);

  await execute("uninstall", recipe, executionContext);
  assert.equal(fs.existsSync(target), false);
});

test("native npm packages prefer the configured app install source", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-source-preferred-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = await npmPackageArchive(root);
  const requests = [];
  const output = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    installEnvironment: installSourcePolicy("https://registry.npmmirror.com"),
    fetcher: async (url, init) => {
      requests.push({ url: String(url), range: requestRange(init) });
      if (!String(url).startsWith("https://registry.npmmirror.com/")) throw new Error("official source must not be probed");
      return requestRange(init)
        ? new Response(null, { status: 206 })
        : new Response(archive, { headers: { "content-length": String(archive.length) } });
    },
    commandRunner: async () => ({ exitCode: 0, stdout: "1.2.3\n", stderr: "" }),
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: sri(archive),
    launchPath: "vendor/bin/tool", privilege: "user",
  };
  await execute("install", recipe, {
    appId: "native-tool",
    capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" },
    onOutput: (stream, chunk) => output.push({ stream, chunk }),
  });

  assert.equal(requests.length, 2);
  assert.equal(requests.every(({ url }) => url.startsWith("https://registry.npmmirror.com/")), true);
  assert.equal(requests[0].range, "bytes=0-0");
  assert.equal(requests[1].range, null);
  assert.match(output.map(({ chunk }) => chunk).join(""), /Using npm source https:\/\/registry\.npmmirror\.com/);
});

test("native npm packages fall back when the preferred source does not respond", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-source-fallback-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = await npmPackageArchive(root);
  const requests = [];
  const output = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    installEnvironment: installSourcePolicy("https://primary.example.test"),
    fetcher: async (url, init) => {
      requests.push({ url: String(url), range: requestRange(init) });
      if (String(url).startsWith("https://primary.example.test/")) throw new Error("connect timed out after 3000ms");
      if (!String(url).startsWith("https://registry.npmjs.org/")) throw new Error("unexpected fallback source");
      return requestRange(init)
        ? new Response(null, { status: 206 })
        : new Response(archive, { headers: { "content-length": String(archive.length) } });
    },
    commandRunner: async () => ({ exitCode: 0, stdout: "1.2.3\n", stderr: "" }),
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: sri(archive),
    launchPath: "vendor/bin/tool", privilege: "user",
  };
  await execute("install", recipe, {
    appId: "native-tool",
    capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" },
    onOutput: (stream, chunk) => output.push({ stream, chunk }),
  });

  assert.deepEqual(requests.map(({ url }) => new URL(url).hostname), [
    "primary.example.test",
    "registry.npmjs.org",
    "registry.npmjs.org",
  ]);
  const log = output.map(({ chunk }) => chunk).join("");
  assert.match(log, /npm source https:\/\/primary\.example\.test unavailable/);
  assert.match(log, /Using fallback npm source https:\/\/registry\.npmjs\.org/);
});

test("native npm package source probes abort after three seconds and continue with a fallback", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-source-timeout-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = await npmPackageArchive(root);
  const startedAt = Date.now();
  let abortedAt;
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    installEnvironment: installSourcePolicy("https://slow.example.test"),
    fetcher: async (url, init) => {
      if (String(url).startsWith("https://slow.example.test/")) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            abortedAt = Date.now();
            reject(init.signal.reason);
          }, { once: true });
        });
      }
      if (!String(url).startsWith("https://registry.npmjs.org/")) throw new Error("unexpected fallback source");
      return requestRange(init)
        ? new Response(null, { status: 206 })
        : new Response(archive, { headers: { "content-length": String(archive.length) } });
    },
    commandRunner: async () => ({ exitCode: 0, stdout: "1.2.3\n", stderr: "" }),
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: sri(archive),
    launchPath: "vendor/bin/tool", privilege: "user",
  };
  await execute("install", recipe, {
    appId: "native-tool",
    capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" },
  });

  assert.ok(abortedAt, "the source probe should be aborted");
  assert.ok(abortedAt - startedAt >= 2_800, `probe aborted too early after ${abortedAt - startedAt}ms`);
  assert.ok(abortedAt - startedAt < 4_500, `probe aborted too late after ${abortedAt - startedAt}ms`);
});

test("native npm packages report every unavailable source before failing", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-source-offline-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = await npmPackageArchive(root);
  const requests = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    installEnvironment: installSourcePolicy("https://primary.example.test"),
    fetcher: async (url) => {
      requests.push(String(url));
      throw new Error("connect timeout");
    },
    commandRunner: async () => { throw new Error("verification must not run"); },
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: sri(archive),
    launchPath: "vendor/bin/tool", privilege: "user",
  };
  await assert.rejects(
    execute("install", recipe, { appId: "native-tool", capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" } }),
    (error) => error instanceof AppRecipeExecutionError
      && error.code === "npm_registry_unavailable"
      && error.retryable === true
      && error.message.includes("https://registry.npmjs.org")
      && error.message.includes("https://registry.npmmirror.com"),
  );
  assert.deepEqual(requests.map((url) => new URL(url).hostname), [
    "primary.example.test",
    "registry.npmjs.org",
    "registry.npmmirror.com",
  ]);
});

test("native package updates preserve the previous install when verification fails", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-atomic-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installBaseDir = path.join(root, "managed-apps");
  const firstArchive = await npmPackageArchive(root, { sourceName: "first", body: "#!/bin/sh\nprintf 'previous-version\\n'\n" });
  const target = path.join(installBaseDir, "native", "native-tool");
  fs.mkdirSync(path.join(target, "vendor", "bin"), { recursive: true });
  const previousLauncher = path.join(target, "vendor", "bin", "tool");
  fs.writeFileSync(previousLauncher, "#!/bin/sh\nprintf 'previous-version\\n'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(target, "managed-app.json"), JSON.stringify({
    schemaVersion: 1, appId: "native-tool", version: "1.0.0", package: "native-tool",
    packageVersion: "1.0.0-linux-x64", integrity: sri(firstArchive), installRoot: target,
    launchPath: "vendor/bin/tool", files: ["vendor/bin/tool", "managed-app.json"],
  }));
  const secondArchive = await npmPackageArchive(root, { sourceName: "second", body: "#!/bin/sh\nprintf 'next-version\\n'\n" });
  const commands = [];
  const execute = createAppRecipeExecutor({
    installBaseDir,
    stateDir: path.join(root, "state"),
    fetcher: async () => new Response(secondArchive, { headers: { "content-length": String(secondArchive.length) } }),
    commandRunner: async (command) => { commands.push(command); return { exitCode: 0, stdout: "next-version\n", stderr: "" }; },
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: sri(firstArchive),
    launchPath: "vendor/bin/tool", tarballUrl: "https://registry.example.test/native-tool.tgz", privilege: "user",
  };
  await assert.rejects(
    execute("update", recipe, { appId: "native-tool", capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" } }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "checksum_mismatch",
  );
  assert.equal(commands.length, 0);
  assert.equal(spawnSync(previousLauncher, [], { encoding: "utf8" }).stdout.trim(), "previous-version");
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "managed-app.json"), "utf8")).version, "1.0.0");
});

test("native npm packages reject links and launchers outside the package root", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-links-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = await npmPackageArchive(root, { symlink: "/bin/sh" });
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    fetcher: async () => new Response(archive),
    commandRunner: async () => { throw new Error("verification must not run"); },
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: sri(archive),
    launchPath: "vendor/bin/tool", tarballUrl: "https://registry.example.test/native-tool.tgz", privilege: "user",
  };
  await assert.rejects(
    execute("install", recipe, { appId: "native-tool", capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" } }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "unsafe_archive",
  );
  await assert.rejects(
    execute("install", { ...recipe, launchPath: "../escape" }, { appId: "native-tool", capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" } }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "invalid_builtin_recipe",
  );
});

test("native package downloads reject unsafe redirects before contacting the target", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-redirect-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let redirectLocation = "http://mirror.example.test/native-tool.tgz";
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    fetcher: async (url, init) => {
      requests.push({ url: String(url), redirect: init?.redirect });
      return new Response(null, { status: 302, headers: { location: redirectLocation } });
    },
    commandRunner: async () => { throw new Error("verification must not run"); },
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    launchPath: "vendor/bin/tool", tarballUrl: "https://registry.example.test/native-tool.tgz", privilege: "user",
  };
  for (const location of [
    "http://mirror.example.test/native-tool.tgz",
    "https://user:pass@mirror.example.test/native-tool.tgz",
    "https://mirror.example.test/native-tool.tgz?token=secret",
    "https://mirror.example.test/native-tool.tgz#fragment",
  ]) {
    redirectLocation = location;
    requests.length = 0;
    await assert.rejects(
      execute("install", recipe, { appId: "native-tool", capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" } }),
      (error) => error instanceof AppRecipeExecutionError && error.code === "invalid_builtin_recipe",
    );
    assert.deepEqual(requests, [{ url: "https://registry.example.test/native-tool.tgz", redirect: "manual" }]);
  }
});

test("native package tarball URLs reject non-canonical sources before any request", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-source-url-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    fetcher: async (url) => {
      requests.push(String(url));
      throw new Error("unsafe source must not be requested");
    },
    commandRunner: async () => { throw new Error("verification must not run"); },
  });
  const baseRecipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    launchPath: "vendor/bin/tool", privilege: "user",
  };
  for (const tarballUrl of [
    "http://registry.example.test/native-tool.tgz",
    "https://user:pass@registry.example.test/native-tool.tgz",
    "https://registry.example.test/native-tool.tgz?token=secret",
    "https://registry.example.test/native-tool.tgz#fragment",
  ]) {
    await assert.rejects(
      execute("install", { ...baseRecipe, tarballUrl }, { appId: "native-tool", capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" } }),
      (error) => error instanceof AppRecipeExecutionError && error.code === "invalid_builtin_recipe",
    );
  }
  assert.deepEqual(requests, []);
});

test("native package downloads fail with a retryable timeout when the body stalls", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-timeout-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = new ReadableStream({ pull: () => new Promise(() => {}) });
  const execute = createAppRecipeExecutor({
    installBaseDir: path.join(root, "managed-apps"),
    stateDir: path.join(root, "state"),
    downloadTimeoutMs: 2_000,
    downloadIdleTimeoutMs: 20,
    fetcher: async () => new Response(body),
    commandRunner: async () => { throw new Error("verification must not run"); },
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    launchPath: "vendor/bin/tool", tarballUrl: "https://registry.example.test/native-tool.tgz", privilege: "user",
  };
  await assert.rejects(
    execute("install", recipe, { appId: "native-tool", capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" } }),
    (error) => error instanceof AppRecipeExecutionError && error.code === "download_timeout" && error.retryable === true,
  );
});

test("native package uninstall refuses unsafe ownership manifests without deleting the target", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-native-manifest-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installBaseDir = path.join(root, "managed-apps");
  const target = path.join(installBaseDir, "native", "native-tool");
  const launcher = path.join(target, "vendor", "bin", "tool");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const execute = createAppRecipeExecutor({
    installBaseDir,
    stateDir: path.join(root, "state"),
    fetcher: async () => { throw new Error("uninstall must not download"); },
    commandRunner: async () => { throw new Error("uninstall must not run commands"); },
  });
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    launchPath: "vendor/bin/tool", privilege: "user",
  };
  const manifest = {
    schemaVersion: 1, appId: "native-tool", version: "1.2.3", package: "native-tool",
    packageVersion: "1.2.3-linux-x64", integrity: recipe.integrity, installRoot: target,
    launchPath: "vendor/bin/tool", files: ["vendor/bin/tool", "managed-app.json"],
  };
  for (const invalid of [
    { ...manifest, installRoot: path.join("native", "native-tool") },
    { ...manifest, files: ["vendor/bin/tool", "../escape"] },
  ]) {
    fs.writeFileSync(path.join(target, "managed-app.json"), JSON.stringify(invalid));
    await assert.rejects(
      execute("uninstall", recipe, { appId: "native-tool", capabilities: { platform: "linux", arch: "x64", installers: [], privilege: "user" } }),
      (error) => error instanceof AppRecipeExecutionError && error.code === "ownership_manifest_missing",
    );
    assert.equal(fs.existsSync(launcher), true);
  }
});
