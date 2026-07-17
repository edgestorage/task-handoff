const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
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
  createManagedAppRegistry,
} = require("../packages/app-runtime/src/managed-app-definitions/index.ts");

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
    args: ["--model", "gpt-custom"],
  });
  assert.deepEqual(definitions.find((entry) => entry.launcher.id === "claude").launcher.args, [
    "--dangerously-skip-permissions",
    "--model",
    "claude-custom",
  ]);
});
