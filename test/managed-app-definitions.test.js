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
  managedAppProjection,
  selectInstallRecipe,
} = require("../packages/app-runtime/src/managed-apps.ts");
const {
  builtinAppCatalog,
  builtinManagedAppDefinitions,
  publicManagedAppDefinitions,
} = require("../packages/app-runtime/src/catalog.ts");

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

test("builtin definitions are the single launcher source and custom launchers are not managed", () => {
  const definitions = builtinManagedAppDefinitions({ includeOptional: true });
  const catalog = builtinAppCatalog({ includeOptional: true });
  assert.deepEqual(catalog, definitions.map((entry) => entry.launcher));
  assert.equal(definitions.find((entry) => entry.launcher.id === "chromium").distribution.recipes[0].type, "system-package");
  assert.equal(definitions.find((entry) => entry.launcher.id === "codex").distribution.recipes[0].type, "bundled");
  const publicDefinitions = publicManagedAppDefinitions({ includeOptional: true });
  assert.equal(publicDefinitions.some((entry) => entry.id === "custom-tool"), false);
  assert.equal(JSON.stringify(publicDefinitions).includes("command"), false);
  assert.equal(JSON.stringify(publicDefinitions).includes("packages"), false);
});
