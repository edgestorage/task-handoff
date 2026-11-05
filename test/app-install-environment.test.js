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
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  AppInstallEnvironmentError,
  AppInstallEnvironmentManager,
  MANAGED_NODE_VERSION,
} = require("../packages/controlled-instance/src/web/app-install-environment.ts");

function fixture(prefix = "install-environment-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const osReleasePath = path.join(root, "os-release");
  fs.writeFileSync(osReleasePath, "ID=ubuntu\nVERSION_CODENAME=noble\nID_LIKE=debian\n");
  return {
    root,
    dataDir: path.join(root, "data"),
    stateDir: path.join(root, "state"),
    osReleasePath,
  };
}

function manager(options = {}) {
  const paths = fixture();
  return {
    paths,
    environment: new AppInstallEnvironmentManager({
      dataDir: paths.dataDir,
      stateDir: paths.stateDir,
      env: {},
      platform: "linux",
      arch: "x64",
      osReleasePath: paths.osReleasePath,
      now: () => "2026-11-05T00:00:00.000Z",
      ...options,
    }),
  };
}

function update(profile, custom = {}, expectedRevision) {
  return {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    settings: { profile, custom },
  };
}

test("source profiles resolve official and China endpoints with revision checks", () => {
  const { environment } = manager();
  assert.deepEqual(environment.effectiveSources(), {});

  const official = environment.update(update("official", {}, 0));
  assert.equal(official.revision, 1);
  assert.equal(official.effective.npmRegistry, "https://registry.npmjs.org");
  assert.equal(official.effective.nodeDistUrl, "https://nodejs.org/dist");
  assert.equal(official.effective.aptMainMirror, "https://archive.ubuntu.com/ubuntu");

  assert.throws(
    () => environment.update(update("china", {}, 0)),
    (error) => error instanceof AppInstallEnvironmentError && error.code === "install_sources_revision_conflict" && error.statusCode === 409,
  );

  const china = environment.update(update("china"));
  assert.equal(china.revision, 2);
  assert.equal(china.effective.npmRegistry, "https://registry.npmmirror.com");
  assert.equal(china.effective.nodeDistUrl, "https://mirrors.cloud.tencent.com/nodejs-release");
  assert.equal(china.effective.aptMainMirror, "https://mirrors.tuna.tsinghua.edu.cn/ubuntu");
});

test("custom sources reject insecure, credentialed, and query URLs", () => {
  const { environment } = manager();
  for (const custom of [
    { npmRegistry: "http://registry.example.test" },
    { aptMainMirror: "https://user:secret@example.test/debian" },
    { nodeDistUrl: "https://example.test/dist?token=secret" },
    { aptSecurityMirror: "ftp://example.test/debian-security" },
  ]) {
    assert.throws(
      () => environment.update(update("custom", custom)),
      (error) => error instanceof AppInstallEnvironmentError && error.code === "install_sources_input_invalid",
    );
  }
});

test("stored settings are sanitized and remain the instance authority", () => {
  const paths = fixture();
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, "app-install-sources.json"), JSON.stringify({
    version: 1,
    revision: 7,
    unknown: true,
    settings: {
      profile: "custom",
      custom: {
        npmRegistry: "https://registry.example.test/",
        nodeDistUrl: "http://insecure.example.test",
        futureField: "ignored",
      },
      futureField: "ignored",
    },
  }));
  const environment = new AppInstallEnvironmentManager({
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    env: {},
    platform: "linux",
    arch: "x64",
    osReleasePath: paths.osReleasePath,
  });
  assert.equal(environment.revision, 7);
  assert.equal(environment.settings.profile, "custom");
  assert.equal(environment.settings.custom.npmRegistry, "https://registry.example.test");
  assert.equal(environment.settings.custom.nodeDistUrl, undefined);
});

test("apt sources use an isolated sources file and matching apt options", () => {
  const { paths, environment } = manager();
  environment.update(update("china"));
  const apt = environment.aptSourceConfiguration();
  assert.equal(apt.distro, "ubuntu");
  assert.equal(apt.codename, "noble");
  assert.ok(apt.sourcesFile.startsWith(path.join(paths.stateDir, "apt")));
  assert.equal(apt.options.includes("Dir::Etc::sourceparts=-"), true);
  assert.equal(apt.options.some((value) => value.startsWith("Dir::State::lists=")), true);
  assert.equal(apt.options.includes("APT::Get::List-Cleanup=0"), true);
  const sources = fs.readFileSync(apt.sourcesFile, "utf8");
  assert.match(sources, /mirrors\.tuna\.tsinghua\.edu\.cn\/ubuntu\/ noble main restricted universe multiverse/);
  assert.match(sources, /noble-security/);
});

test("non-Linux platforms do not project unsupported apt sources", () => {
  const { environment } = manager({ platform: "darwin", arch: "arm64" });
  environment.update(update("china"));
  const effective = environment.effectiveSources();
  assert.equal(effective.npmRegistry, "https://registry.npmmirror.com");
  assert.equal(effective.nodeDistUrl, "https://mirrors.cloud.tencent.com/nodejs-release");
  assert.equal(effective.aptMainMirror, undefined);
  assert.equal(effective.aptSecurityMirror, undefined);
  assert.equal(environment.supportsAptSources(), false);
});

test("private Node runtime overrides PATH and npm registry without changing host files", () => {
  const { paths, environment } = manager();
  environment.update(update("official"));
  const root = path.join(paths.dataDir, "toolchains", "node", `v${MANAGED_NODE_VERSION}`);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "node"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(root, "bin", "npm"), "#!/bin/sh\n");
  fs.mkdirSync(path.join(paths.dataDir, "toolchains", "node"), { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, "toolchains", "node", "current.json"), JSON.stringify({
    version: MANAGED_NODE_VERSION,
    root,
  }));
  const overrides = environment.runtimeOverrides();
  assert.equal(overrides.npm_config_registry, "https://registry.npmjs.org");
  assert.equal(overrides.PATH.startsWith(path.join(root, "bin")), true);
});

test("connection tests retry HEAD-capable checks with a bounded GET", async () => {
  const calls = [];
  const { environment } = manager({
    fetcher: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return init.method === "HEAD"
        ? new Response(null, { status: 405 })
        : new Response("", { status: 200 });
    },
  });
  environment.update(update("china"));
  const result = await environment.testSources();
  assert.equal(result.checks.length, 4);
  assert.equal(result.checks.every((check) => check.ok), true);
  assert.equal(calls.filter((call) => call.method === "HEAD").length, 4);
  assert.equal(calls.filter((call) => call.method === "GET").length, 4);
  assert.equal(calls.every((call) => call.url.startsWith("https://")), true);
});

test("Node preparation verifies the pinned artifact checksum", async () => {
  const { environment } = manager({
    fetcher: async () => new Response("not the pinned archive", { status: 200 }),
  });
  await assert.rejects(
    environment.prepareNodeToolchain(),
    (error) => error instanceof AppInstallEnvironmentError && error.code === "node_archive_checksum_mismatch",
  );
});
