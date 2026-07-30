const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
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
  detectFinalComputerCapabilities,
  detectManagedApp,
  detectManagedAppOwnership,
  detectManagedAppManagementSource,
  managedAppProjection,
  selectInstallRecipe,
} = require("../packages/app-runtime/src/managed-apps.ts");
const {
  builtinAppCatalog,
  builtinManagedAppDefinitions,
  publicManagedAppDefinitions,
} = require("../packages/app-runtime/src/catalog.ts");
const {
  builtinManagedAppRegistry,
  createManagedAppRegistry,
} = require("../packages/app-runtime/src/managed-app-definitions/index.ts");
const {
  resolveExecutable,
} = require("../packages/app-runtime/src/executable-resolver.ts");
const {
  resolveAppExecutable,
} = require("../packages/app-runtime/src/catalog.ts");
const {
  createCodexRuntime,
} = require("../packages/app-runtime/src/managed-app-definitions/codex/runtime.ts");
const {
  codexAppServerSocketPath,
} = require("../packages/app-runtime/src/runtime-utils.ts");

function executable(directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return filePath;
}

test("executable resolvers stop at PATH before NVM and Homebrew", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-resolver-path-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pathBin = path.join(root, "path-bin");
  const nvmDir = path.join(root, "nvm");
  const nvmBin = path.join(nvmDir, "versions", "node", "v24.1.0", "bin");
  const brewBin = path.join(root, "brew", "bin");
  const expected = executable(pathBin, "codex");
  executable(nvmBin, "codex");
  executable(brewBin, "codex");

  const resolution = resolveExecutable("codex", {
    env: { PATH: pathBin, NVM_DIR: nvmDir },
    platform: "darwin",
    homeDir: root,
    homebrewBinDirectories: [brewBin],
  });

  assert.equal(resolution.resolver, "path");
  assert.equal(resolution.executable, expected);
  assert.equal(resolution.env, undefined);
});

test("NVM resolver uses the default Node version and binds its bin directory to launch env", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-resolver-nvm-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nvmDir = path.join(root, "nvm");
  const olderBin = path.join(nvmDir, "versions", "node", "v20.1.0", "bin");
  const defaultBin = path.join(nvmDir, "versions", "node", "v22.2.0", "bin");
  executable(olderBin, "codex");
  const expected = executable(defaultBin, "codex");
  fs.mkdirSync(path.join(nvmDir, "alias"), { recursive: true });
  fs.writeFileSync(path.join(nvmDir, "alias", "default"), "22.2.0\n");

  const resolution = resolveExecutable("codex", {
    env: { PATH: "/missing", NVM_DIR: nvmDir },
    platform: "darwin",
    homeDir: root,
    homebrewBinDirectories: [],
  });

  assert.equal(resolution.resolver, "nvm");
  assert.equal(resolution.executable, expected);
  assert.equal(resolution.env.NVM_BIN, defaultBin);
  assert.equal(resolution.env.NVM_DIR, nvmDir);
  assert.equal(resolution.env.PATH, `${defaultBin}${path.delimiter}/missing`);
});

test("Homebrew resolver runs only after PATH and NVM miss", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-resolver-brew-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brewBin = path.join(root, "brew", "bin");
  const expected = executable(brewBin, "codex");

  const resolution = resolveExecutable("codex", {
    env: { PATH: "/missing", NVM_DIR: path.join(root, "missing-nvm") },
    platform: "darwin",
    homeDir: root,
    homebrewBinDirectories: [brewBin],
  });

  assert.equal(resolution.resolver, "homebrew");
  assert.equal(resolution.executable, expected);
  assert.equal(resolution.env.PATH, `${brewBin}${path.delimiter}/missing`);
});

test("catalog launchers retain the resolved executable environment", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-resolver-launch-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nvmDir = path.join(root, "nvm");
  const nvmBin = path.join(nvmDir, "versions", "node", "v24.1.0", "bin");
  const expected = executable(nvmBin, "codex");
  const app = resolveAppExecutable(
    { id: "codex", name: "Codex", kind: "tty", command: "codex", env: { NVM_DIR: nvmDir } },
    { PATH: "/missing" },
  );

  assert.equal(app.command, expected);
  assert.equal(app.env.NVM_BIN, nvmBin);
  assert.equal(app.env.PATH, `${nvmBin}${path.delimiter}/missing`);
});

test("Codex runtime removes a pre-existing fixed socket and only reuses its own child", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-owned-app-server-"));
  const socketRoot = path.join(root, "sockets");
  const runtimeDir = path.join(root, "runtime");
  const logDir = path.join(root, "logs");
  fs.mkdirSync(socketRoot, { recursive: true });
  const previousSocketDir = process.env.TASK_HANDOFF_CODEX_APP_SERVER_SOCKET_DIR;
  process.env.TASK_HANDOFF_CODEX_APP_SERVER_SOCKET_DIR = socketRoot;
  context.after(() => {
    if (previousSocketDir === undefined) delete process.env.TASK_HANDOFF_CODEX_APP_SERVER_SOCKET_DIR;
    else process.env.TASK_HANDOFF_CODEX_APP_SERVER_SOCKET_DIR = previousSocketDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const socketPath = codexAppServerSocketPath(path.join(runtimeDir, "codex-app-server"));
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.writeFileSync(socketPath, "external-stale-socket");
  let spawnCount = 0;
  let staleSocketRemovedBeforeSpawn = false;
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 4242,
    killed: false,
    exitCode: null,
    kill() {
      this.killed = true;
      this.exitCode = 0;
      return true;
    },
  });
  const runtime = createCodexRuntime({
    paths: { runtimeDir, logDir },
    allocatePort: () => 8101,
    hasCommand: () => true,
    spawnLogged: (_command, args) => {
      spawnCount += 1;
      assert.equal(args.at(-1), `unix://${socketPath}`);
      staleSocketRemovedBeforeSpawn = !fs.existsSync(socketPath);
      fs.writeFileSync(socketPath, "controlled-instance-socket");
      return child;
    },
    stopProcessTree: (candidate) => candidate.kill("SIGTERM"),
    waitForUnixSocket: (candidate) => assert.equal(fs.readFileSync(candidate, "utf8"), "controlled-instance-socket"),
    patchSession: () => {},
  });

  const first = runtime.sharedResource.acquire("codex", root, process.env, "consumer-one");
  const second = runtime.sharedResource.acquire("codex", root, process.env, "consumer-two");

  assert.equal(staleSocketRemovedBeforeSpawn, true);
  assert.equal(spawnCount, 1);
  assert.equal(second.details.pid, first.details.pid);
  assert.equal(second.details.socketPath, first.details.socketPath);
  runtime.stopAll();
});

test("managed AI providers own their resume arguments", () => {
  const codex = builtinManagedAppRegistry.provider("codex");
  const claude = builtinManagedAppRegistry.provider("claude");
  const terminal = builtinManagedAppRegistry.provider("terminal-tty");

  assert.equal(codex.capabilities.supportsAiSessionResume, true);
  assert.deepEqual(codex.aiSessionResumeArgs("codex-session"), ["resume", "codex-session"]);
  assert.equal(claude.capabilities.supportsAiSessionResume, true);
  assert.deepEqual(claude.aiSessionResumeArgs("claude-session"), ["--resume", "claude-session"]);
  assert.equal(Boolean(terminal.capabilities?.supportsAiSessionResume), false);
  assert.equal(terminal.aiSessionResumeArgs, undefined);
});

test("managed app providers own their program-specific runtime hooks", () => {
  const host = {
    paths: {},
    allocatePort: () => 8101,
    hasCommand: () => true,
    spawnLogged: () => { throw new Error("not used"); },
    stopProcessTree: () => {},
    waitForUnixSocket: () => {},
    patchSession: () => {},
  };
  const runtimeFor = (id) => builtinManagedAppRegistry.provider(id).createRuntime?.(host);

  assert.equal(typeof runtimeFor("codex").prepareTtyLaunch, "function");
  assert.equal(typeof runtimeFor("codex").sharedResource.ensure, "function");
  assert.equal(typeof runtimeFor("claude").prepareTtyLaunch, "function");
  assert.equal(typeof runtimeFor("chromium").prepareGuiArgs, "function");
  assert.equal(typeof runtimeFor("terminal-gui").prepareGuiArgs, "function");
  assert.equal(typeof runtimeFor("vscode-web").prepareWebSession, "function");
  assert.equal(runtimeFor("terminal-tty"), undefined);
});

function definition(overrides = {}) {
  return {
    launcher: { id: "tool", name: "Tool", kind: "tty", command: "tool" },
    detection: [{ type: "launcher-executable", versionArgs: ["--version"] }],
    distribution: {
      recipes: [{ type: "system-package", platforms: ["linux"], arches: ["x64"], installer: "apt", packages: ["tool"], privilege: "passwordless-sudo" }],
    },
    ...overrides,
  };
}

test("final computer capabilities are normalized from the controlled computer", () => {
  assert.deepEqual(detectFinalComputerCapabilities({
    platform: "linux",
    arch: "x64",
    getuid: () => 1000,
    canPasswordlessSudo: () => true,
    executable: (command) => command === "apt" || command === "sudo" ? `/usr/bin/${command}` : undefined,
  }), { platform: "linux", arch: "x64", installers: ["apt"], privilege: "passwordless-sudo" });

  assert.deepEqual(detectFinalComputerCapabilities({
    platform: "linux",
    arch: "arm64",
    getuid: () => 1000,
    canPasswordlessSudo: () => false,
    npmGlobalWritable: () => true,
    executable: (command) => command === "npm" ? "/usr/bin/npm" : undefined,
  }), { platform: "linux", arch: "arm64", installers: ["npm"], privilege: "user", installerAccess: { npmGlobalWritable: true } });

  assert.deepEqual(detectFinalComputerCapabilities({
    platform: "haiku",
    arch: "mips",
    getuid: () => 0,
    executable: () => undefined,
  }), { platform: "unknown", arch: "unknown", installers: [], privilege: "root" });
});

test("recipe selection uses exact final-computer platform, arch, installer, and privilege", () => {
  const app = definition();
  const supported = { platform: "linux", arch: "x64", installers: ["apt"], privilege: "passwordless-sudo" };
  assert.equal(selectInstallRecipe(app, supported).recipe.type, "system-package");
  assert.equal(selectInstallRecipe(app, { ...supported, platform: "darwin" }).reason.code, "UNSUPPORTED_PLATFORM");
  assert.equal(selectInstallRecipe(app, { ...supported, arch: "arm64" }).reason.code, "UNSUPPORTED_PLATFORM");
  assert.equal(selectInstallRecipe(app, { ...supported, installers: [] }).reason.code, "INSTALLER_UNAVAILABLE");
  assert.equal(selectInstallRecipe(app, { ...supported, privilege: "user" }).reason.code, "INSUFFICIENT_PRIVILEGE");
  assert.equal(Object.hasOwn(supported, "runtime"), false);
});

test("detection, not launcher registration, determines installed and broken states", () => {
  const app = definition({
    detection: [
      { type: "launcher-executable", versionArgs: ["--version"] },
      { type: "executable", command: "tool-helper" },
    ],
  });
  assert.equal(detectManagedApp(app, { executable: () => undefined }).state, "not-installed");
  assert.equal(detectManagedApp(app, { executable: (command) => command === "tool" ? "/external/bin/tool" : undefined }).state, "broken");
  assert.deepEqual(detectManagedApp(app, {
    executable: (command) => `/external/bin/${command}`,
    version: () => "tool 1.2.3\n",
  }), { state: "installed", executablePaths: ["/external/bin/tool", "/external/bin/tool-helper"], version: "tool 1.2.3" });
});

test("managed projection derives actions without exposing trusted recipe details", () => {
  const app = definition();
  const capabilities = { platform: "linux", arch: "x64", installers: ["apt"], privilege: "passwordless-sudo" };
  const projection = managedAppProjection(app, { state: "not-installed", executablePaths: [] }, capabilities);
  assert.equal(projection.state, "not-installed");
  assert.equal(projection.canInstall, true);
  assert.equal(projection.canUninstall, false);
  assert.equal(JSON.stringify(projection).includes("packages"), false);
  assert.equal(JSON.stringify(projection).includes("command"), false);
});

test("node-package ownership requires the detected executable to resolve into the managed package", async () => {
  const nodeApp = definition({
    distribution: { recipes: [{ type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@vendor/tool"], privilege: "user" }] },
  });
  const detected = { state: "installed", executablePaths: ["/usr/local/bin/tool"] };
  const capabilities = { platform: "linux", arch: "x64", installers: ["npm"], privilege: "user", installerAccess: { npmGlobalWritable: true } };
  const baseOptions = {
    runCommand: async () => ({ exitCode: 0, stdout: "/usr/local/lib/node_modules\n", stderr: "" }),
    readFile: async () => JSON.stringify({ bin: { tool: "cli.js" } }),
  };
  assert.equal(await detectManagedAppManagementSource(nodeApp, detected, capabilities, {
    ...baseOptions,
    realpath: async (value) => value === "/usr/local/bin/tool" ? "/usr/local/lib/node_modules/@vendor/tool/cli.js" : value,
  }), "recipe");
  assert.equal(await detectManagedAppManagementSource(nodeApp, detected, capabilities, {
    ...baseOptions,
    realpath: async (value) => value === "/usr/local/bin/tool" ? "/opt/external/tool" : value,
  }), "external");
  const external = managedAppProjection(nodeApp, detected, capabilities, "external");
  assert.equal(external.canUninstall, false);
  assert.equal(external.uninstallReason.code, "EXTERNALLY_MANAGED");
});

test("node-package ownership retains the recipe whose npm prefix owns the executable", async () => {
  const nodeApp = definition({
    distribution: { recipes: [
      { type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@vendor/tool"], privilege: "user" },
      { type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@vendor/tool"], privilege: "passwordless-sudo" },
    ] },
  });
  const detected = { state: "installed", executablePaths: ["/usr/local/bin/tool"] };
  const capabilities = { platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo", installerAccess: { npmGlobalWritable: true } };
  const ownership = await detectManagedAppOwnership(nodeApp, detected, capabilities, {
    runCommand: async (executable) => ({ exitCode: 0, stdout: executable === "sudo" ? "/usr/local/lib/node_modules\n" : "/home/agent/lib/node_modules\n", stderr: "" }),
    readFile: async () => JSON.stringify({ bin: { tool: "cli.js" } }),
    realpath: async (value) => value === "/usr/local/bin/tool" ? "/usr/local/lib/node_modules/@vendor/tool/cli.js" : value,
  });
  assert.equal(ownership.source, "recipe");
  assert.equal(ownership.recipe.privilege, "passwordless-sudo");
});

test("system-package ownership is established by the package manager, not executable presence", async () => {
  const app = definition();
  const detected = { state: "installed", executablePaths: ["/usr/bin/tool"] };
  const capabilities = { platform: "linux", arch: "x64", installers: ["apt"], privilege: "passwordless-sudo" };
  const options = {
    realpath: async (value) => value,
    runCommand: async () => ({ exitCode: 0, stdout: "tool:amd64: /usr/bin/tool\n", stderr: "" }),
  };
  assert.equal(await detectManagedAppManagementSource(app, detected, capabilities, options), "recipe");
  assert.equal(await detectManagedAppManagementSource(app, detected, capabilities, {
    ...options,
    runCommand: async () => ({ exitCode: 0, stdout: "other-package: /usr/bin/tool\n", stderr: "" }),
  }), "external");
});

test("archive ownership requires a validated controlled-instance manifest", async () => {
  const app = definition({
    distribution: { recipes: [{ type: "archive", platforms: ["linux"], url: "https://example.test/tool.tar.gz", sha256: "a".repeat(64), format: "tar.gz", installRoot: "tool" }] },
  });
  const detected = { state: "installed", executablePaths: ["/managed/tool/bin/tool"] };
  const capabilities = { platform: "linux", arch: "x64", installers: [], privilege: "user" };
  assert.equal(await detectManagedAppManagementSource(app, detected, capabilities, { archiveManifestOwned: async () => true }), "recipe");
  assert.equal(await detectManagedAppManagementSource(app, detected, capabilities, { archiveManifestOwned: async () => false }), "external");
});

test("builtin definitions are the single launcher source and custom launchers are not managed", () => {
  const definitions = builtinManagedAppDefinitions({ includeOptional: true });
  const catalog = builtinAppCatalog({ includeOptional: true });
  assert.deepEqual(catalog, definitions.map((entry) => entry.launcher));
  assert.equal(definitions.find((entry) => entry.launcher.id === "chromium").distribution.recipes[0].type, "system-package");
  const codex = definitions.find((entry) => entry.launcher.id === "codex");
  assert.equal(codex.distribution.recipes[0].type, "node-package");
  assert.equal(codex.distribution.recipes[0].installer, "npm");
  assert.deepEqual(codex.distribution.recipes[0].packages, ["@openai/codex"]);
  assert.deepEqual(codex.distribution.recipes[0].platforms, ["linux", "darwin", "win32"]);
  assert.deepEqual(codex.distribution.recipes[0].arches, ["x64", "arm64"]);
  const claude = definitions.find((entry) => entry.launcher.id === "claude");
  assert.equal(claude.distribution.recipes[0].type, "node-package");
  assert.equal(claude.distribution.recipes[0].installer, "npm");
  assert.deepEqual(claude.distribution.recipes[0].packages, ["@anthropic-ai/claude-code"]);
  assert.deepEqual(claude.distribution.recipes[0].platforms, ["linux", "darwin", "win32"]);
  assert.deepEqual(claude.distribution.recipes[0].arches, ["x64", "arm64"]);
  assert.equal(selectInstallRecipe(claude, {
    platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo", installerAccess: { npmGlobalWritable: true },
  }).recipe.privilege, "user");
  assert.equal(selectInstallRecipe(claude, {
    platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo", installerAccess: { npmGlobalWritable: false },
  }).recipe.privilege, "passwordless-sudo");
  assert.equal(selectInstallRecipe(claude, {
    platform: "freebsd", arch: "x64", installers: ["npm"], privilege: "root",
  }).reason.code, "UNSUPPORTED_PLATFORM");
  assert.equal(selectInstallRecipe(claude, {
    platform: "linux", arch: "ppc64", installers: ["npm"], privilege: "root",
  }).reason.code, "UNSUPPORTED_PLATFORM");
  const codexProjection = managedAppProjection(codex, { state: "installed", executablePaths: ["/usr/local/bin/codex"] }, {
    platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo",
  });
  assert.equal(codexProjection.canUninstall, true);
  const missingCodexProjection = managedAppProjection(codex, { state: "not-installed", executablePaths: [] }, {
    platform: "linux", arch: "arm64", installers: ["npm"], privilege: "user", installerAccess: { npmGlobalWritable: true },
  });
  assert.equal(missingCodexProjection.canInstall, true);
  const readOnlyCodexProjection = managedAppProjection(codex, { state: "not-installed", executablePaths: [] }, {
    platform: "linux", arch: "arm64", installers: ["npm"], privilege: "user", installerAccess: { npmGlobalWritable: false },
  });
  assert.equal(readOnlyCodexProjection.canInstall, false);
  assert.equal(readOnlyCodexProjection.installReason.code, "INSTALLER_NOT_WRITABLE");
  const publicDefinitions = publicManagedAppDefinitions({ includeOptional: true });
  assert.equal(publicDefinitions.some((entry) => entry.id === "custom-tool"), false);
  assert.equal(JSON.stringify(publicDefinitions).includes("command"), false);
  assert.equal(JSON.stringify(publicDefinitions).includes("packages"), false);
});

test("managed app providers isolate program definitions behind an extensible registry", () => {
  const provider = {
    id: "future-tool",
    optional: true,
    capabilities: { supportsCwdSelection: true },
    enabled: ({ env }) => env.ENABLE_FUTURE_TOOL === "1",
    definition: ({ env }) => definition({
      launcher: {
        id: "future-tool",
        name: "Future Tool",
        kind: "tty",
        command: env.FUTURE_TOOL_COMMAND || "future-tool",
      },
    }),
  };
  const registry = createManagedAppRegistry([provider]);

  assert.deepEqual(registry.definitions({ env: {} }), []);
  assert.equal(registry.definitions({ env: { ENABLE_FUTURE_TOOL: "1", FUTURE_TOOL_COMMAND: "future-bin" } })[0].launcher.command, "future-bin");
  assert.equal(registry.definitions({ includeOptional: true, env: {} })[0].launcher.id, "future-tool");
  assert.equal(registry.provider("future-tool").capabilities.supportsCwdSelection, true);
});

test("managed app registry rejects duplicate and inconsistent provider ids", () => {
  const provider = {
    id: "tool",
    definition: () => definition(),
  };
  assert.throws(() => createManagedAppRegistry([provider, provider]), /Duplicate managed app provider id/);

  const registry = createManagedAppRegistry([{
    id: "declared-tool",
    definition: () => definition(),
  }]);
  assert.throws(() => registry.definitions(), /returned launcher id tool/);
});

test("managed app registry rejects ambiguous runtime provider matches", () => {
  const matchingProvider = (id) => ({
    id,
    matchesRuntime: () => true,
    definition: () => definition({ launcher: { id, name: id, kind: "gui", command: id } }),
  });
  const registry = createManagedAppRegistry([matchingProvider("first"), matchingProvider("second")]);
  assert.throws(
    () => registry.runtimeProvider({ id: "custom", name: "Custom", kind: "gui", command: "custom" }),
    /Multiple managed app providers match runtime for custom/,
  );
});

test("built-in providers resolve commands and arguments from the supplied environment", () => {
  const definitions = builtinManagedAppDefinitions({
    includeOptional: true,
    env: {
      SHELL: "/bin/zsh",
      TASK_HANDOFF_CODEX_COMMAND: "custom-codex",
      TASK_HANDOFF_CODEX_MODEL: "gpt-custom",
      TASK_HANDOFF_CLAUDE_SKIP_PERMISSIONS: "1",
      TASK_HANDOFF_CLAUDE_MODEL: "claude-custom",
    },
  });
  assert.equal(definitions.find((entry) => entry.launcher.id === "terminal-tty").launcher.command, "/bin/zsh");
  assert.deepEqual(definitions.find((entry) => entry.launcher.id === "codex").launcher, {
    id: "codex",
    name: "Codex",
    kind: "tty",
    description: "OpenAI Codex CLI in the task workspace.",
    command: "custom-codex",
      args: ["-c", "check_for_update_on_startup=false", "--model", "gpt-custom"],
  });
  assert.deepEqual(definitions.find((entry) => entry.launcher.id === "claude").launcher.args, [
    "--dangerously-skip-permissions",
    "--model",
    "claude-custom",
  ]);
});

test("controlled Claude launch relies on materialized settings instead of a model argument", () => {
  const definitions = builtinManagedAppDefinitions({
    includeOptional: true,
    env: {
      TASK_HANDOFF_CONTROL_MODE: "controlled",
      TASK_HANDOFF_CLAUDE_MODEL: "claude-managed",
    },
  });
  assert.deepEqual(definitions.find((entry) => entry.launcher.id === "claude").launcher.args, []);
});
