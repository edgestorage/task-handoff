const assert = require("node:assert/strict");
const fs = require("node:fs");
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

const { createAppUpdateChecker, parseAptPolicy, parseBrewOutdated } = require("../packages/controlled-instance/src/web/app-update-check.ts");

const aptCapabilities = { platform: "linux", arch: "x64", installers: ["apt"], privilege: "passwordless-sudo" };
const dnfCapabilities = { platform: "linux", arch: "x64", installers: ["dnf"], privilege: "passwordless-sudo" };
const npmCapabilities = { platform: "linux", arch: "x64", installers: ["npm"], privilege: "user", installerAccess: { npmGlobalWritable: true } };
const sudoNpmCapabilities = { platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo", installerAccess: { npmGlobalWritable: false } };

function checkerWith(responses) {
  const commands = [];
  const checker = createAppUpdateChecker({
    commandRunner: async (command) => {
      commands.push(command);
      const match = responses.shift();
      if (typeof match === "function") return match(command);
      return match ?? { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return { checker, commands };
}

const aptRecipe = { type: "system-package", platforms: ["linux"], installer: "apt", packages: ["chromium"], privilege: "passwordless-sudo" };
const dnfRecipe = { type: "system-package", platforms: ["linux"], installer: "dnf", packages: ["chromium"], privilege: "passwordless-sudo" };
const brewRecipe = { type: "system-package", platforms: ["linux"], installer: "brew", packages: ["chromium"], privilege: "user" };
const npmRecipe = { type: "node-package", platforms: ["linux"], installer: "npm", packages: ["@openai/codex"], privilege: "user" };
const sudoNpmRecipe = { ...npmRecipe, privilege: "passwordless-sudo" };

test("apt policy parsing reports installed, latest, and available status", () => {
  assert.deepEqual(parseAptPolicy("chromium:\n  Installed: 120.0\n  Candidate: 121.0\n"), { status: "update-available", installedVersion: "120.0", latestVersion: "121.0" });
  assert.deepEqual(parseAptPolicy("chromium:\n  Installed: 121.0\n  Candidate: 121.0\n"), { status: "up-to-date", installedVersion: "121.0", latestVersion: "121.0" });
  assert.equal(parseAptPolicy("chromium:\n  Installed: 121.0\n  Candidate: (none)\n").status, "up-to-date");
});

test("brew outdated parsing reports available updates", () => {
  assert.deepEqual(
    parseBrewOutdated(JSON.stringify({ formulae: [{ name: "chromium", installed: [{ version: "1.2.0" }], current_version: "1.3.0" }], casks: [] })),
    { status: "update-available", installedVersion: "1.2.0", latestVersion: "1.3.0" },
  );
  assert.equal(parseBrewOutdated(JSON.stringify({ formulae: [], casks: [] })).status, "up-to-date");
  assert.equal(parseBrewOutdated("not json").status, "unknown");
});

test("apt checks run a read-only apt-cache policy query", async () => {
  const { checker, commands } = checkerWith([{ exitCode: 0, stdout: "chromium:\n  Installed: 120.0\n  Candidate: 121.0\n", stderr: "" }]);
  const result = await checker(aptRecipe, { appId: "chromium", capabilities: aptCapabilities });
  assert.equal(result.status, "update-available");
  assert.ok(commands[0].executable.endsWith("apt-cache"));
  assert.deepEqual(commands[0].args, ["policy", "chromium"]);
  assert.equal(commands[0].env.LC_ALL, "C");
});

test("dnf checks treat exit code 100 as an available update", async () => {
  const { checker } = checkerWith([{ exitCode: 100, stdout: "chromium.x86_64  121.0  updates\n", stderr: "" }, { exitCode: 0, stdout: "", stderr: "" }]);
  assert.deepEqual(await checker(dnfRecipe, { appId: "chromium", capabilities: dnfCapabilities }), { status: "update-available", latestVersion: "121.0" });
  assert.deepEqual(await checker(dnfRecipe, { appId: "chromium", capabilities: dnfCapabilities }), { status: "up-to-date" });
});

test("brew checks use structured json output", async () => {
  const { checker, commands } = checkerWith([{ exitCode: 0, stdout: JSON.stringify({ formulae: [{ installed: [{ version: "1.0.0" }], current_version: "1.1.0" }], casks: [] }), stderr: "" }]);
  const result = await checker(brewRecipe, { appId: "chromium", capabilities: { ...aptCapabilities, installers: ["brew"] } });
  assert.equal(result.status, "update-available");
  assert.deepEqual(commands[0].args, ["outdated", "--json=v2", "chromium"]);
});

test("npm checks parse outdated json and elevate with sudo when the recipe does", async () => {
  const payload = JSON.stringify({ "@openai/codex": { current: "1.0.0", wanted: "1.0.0", latest: "1.1.0" } });
  const { checker, commands } = checkerWith([{ exitCode: 1, stdout: payload, stderr: "" }, { exitCode: 0, stdout: "", stderr: "" }, { exitCode: 1, stdout: "", stderr: "" }]);
  assert.deepEqual(await checker(npmRecipe, { appId: "codex", capabilities: npmCapabilities }), { status: "update-available", installedVersion: "1.0.0", latestVersion: "1.1.0" });
  assert.ok(commands[0].executable.endsWith("npm"));
  assert.deepEqual(commands[0].args, ["outdated", "--global", "--json", "--depth=0", "@openai/codex"]);
  assert.equal(await checker(npmRecipe, { appId: "codex", capabilities: npmCapabilities }).then((result) => result.status), "up-to-date");
  assert.equal(await checker(npmRecipe, { appId: "codex", capabilities: npmCapabilities }).then((result) => result.status), "up-to-date");
  const elevated = checkerWith([{ exitCode: 1, stdout: "", stderr: "" }]);
  await elevated.checker(sudoNpmRecipe, { appId: "codex", capabilities: sudoNpmCapabilities });
  assert.equal(elevated.commands[0].executable, "sudo");
  assert.ok(elevated.commands[0].args[1].endsWith("npm"));
  assert.deepEqual(elevated.commands[0].args.slice(0, 1), ["-n"]);
  assert.deepEqual(elevated.commands[0].args.slice(2), ["outdated", "--global", "--json", "--depth=0", "@openai/codex"]);
});

test("archive and bundled recipes have no remote update source", async () => {
  const { checker, commands } = checkerWith([]);
  assert.equal((await checker({ type: "archive", platforms: ["linux"], url: "https://downloads.example.test/tool.tar.gz", sha256: "a".repeat(64), format: "tar.gz", installRoot: "tool" }, { appId: "tool", capabilities: aptCapabilities })).status, "unsupported");
  assert.equal((await checker({ type: "bundled", platforms: ["linux"] }, { appId: "tool", capabilities: aptCapabilities })).status, "unsupported");
  assert.equal(commands.length, 0);
});

test("failing or timed out checks report unknown instead of throwing", async () => {
  const { checker } = checkerWith([
    { exitCode: 1, stdout: "", stderr: "E: could not open lock file" },
    () => { throw new Error("command_timeout"); },
  ]);
  assert.deepEqual(await checker(aptRecipe, { appId: "chromium", capabilities: aptCapabilities }), { status: "unknown", reason: "E: could not open lock file" });
  assert.deepEqual(await checker(aptRecipe, { appId: "chromium", capabilities: aptCapabilities }), { status: "unknown", reason: "command_timeout" });
});

test("unavailable installers are reported as unknown", async () => {
  const { checker, commands } = checkerWith([]);
  const result = await checker(npmRecipe, { appId: "codex", capabilities: { ...npmCapabilities, installers: [] } });
  assert.equal(result.status, "unknown");
  assert.equal(commands.length, 0);
});
