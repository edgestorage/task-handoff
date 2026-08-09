const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const { LocalDockerExecutor } = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");
const { DockerRuntimeAdapter } = require("../packages/control-plane/src/node-agent/runtimes/adapters.ts");

const identity = {
  packageName: "@task-handoff/controlled-instance",
  version: "1.2.3",
  platform: "linux",
  arch: "x64",
  formatVersion: 1,
  launcherAbi: 1,
  entrypoint: "dist/controlled-instance.js",
  sha256: "a".repeat(64),
};

test("managed image keeps the instance runtime payload root-owned", () => {
  const dockerfile = fs.readFileSync(path.resolve(__dirname, "../Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /chown[^\n]*agent[^\n]*instance-runtime/);
  assert.match(dockerfile, /chmod 0755 \/opt\/task-handoff\/instance-runtime/);
});

test("Docker runtime install copies, installs through the root-owned updater, verifies payload, and restarts the same container", async () => {
  const calls = [];
  const executor = new LocalDockerExecutor(async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "inspect") return { stdout: "container-abc", stderr: "" };
    if (args[0] === "exec" && args.includes("verify-active")) {
      return { stdout: JSON.stringify(identity), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });

  const result = await executor.installRuntime({ containerName: "instance-1", artifactPath: "/cache/runtime.tar.gz", identity });
  assert.equal(result.containerId, "container-abc");
  assert.equal(result.version, "1.2.3");
  assert.ok(calls.some(([, args]) => args[0] === "cp" && args[1] === "/cache/runtime.tar.gz"));
  assert.ok(calls.some(([, args]) => args[0] === "cp" && args[2].includes(":/opt/task-handoff/instance-runtime/incoming/")));
  const install = calls.find(([, args]) => args[0] === "exec" && args.some((arg) => arg.endsWith("/runtime-installer.mjs")) && args.includes("install"));
  assert.deepEqual(install[1].slice(0, 4), ["exec", "--user", "0", "container-abc"]);
  assert.ok(calls.some(([, args]) => args[0] === "cp" && args[2].startsWith("container-abc:")));
  assert.ok(calls.some(([, args]) => args[0] === "restart" && args[1] === "container-abc"));
  assert.equal(calls.some(([, args]) => args[0] === "rm" || args[0] === "run" || args[0] === "pull"), false);
});

test("Docker runtime install rejects a changed container identity", async () => {
  let inspections = 0;
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect") return { stdout: ++inspections === 1 ? "before" : "after", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  await assert.rejects(
    () => executor.installRuntime({ containerName: "instance-1", artifactPath: "/cache/runtime.tar.gz", identity }),
    (error) => ["INSTANCE_RUNTIME_INSTALL_FAILED", "INSTANCE_RUNTIME_RESTART_FAILED"].includes(error.code) && /identity changed/.test(error.message),
  );
});

test("Docker runtime install rejects a container that does not match the authoritative id before copying", async () => {
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: "replacement-container", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  await assert.rejects(
    () => executor.installRuntimeRelease({ containerName: "instance-1", expectedContainerId: "authoritative-container", artifactPath: "/cache/runtime.tar.gz", identity }),
    (error) => error.code === "INSTANCE_RUNTIME_INSTALL_FAILED" && /identity mismatch before runtime install/.test(error.message),
  );
  assert.equal(calls.some((args) => args[0] === "cp" || args[0] === "exec" || args[0] === "restart"), false);
});

test("Docker adapter promotes the recovered container id to the install authority", async () => {
  const calls = [];
  const runCommand = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({
        Id: "recovered-container",
        State: { Running: true },
        Config: { Entrypoint: [], Cmd: [], Labels: { "task-handoff.instance-id": "instance-1" } },
        Mounts: [],
      }), stderr: "" };
    }
    if (args[0] === "inspect") return { stdout: "recovered-container", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const executor = new LocalDockerExecutor(runCommand);
  const adapter = new DockerRuntimeAdapter(executor, runCommand, "linux", "x64");

  await adapter.installRuntime({
    project: { id: "project-1" },
    image: {},
    node: { id: "node-1" },
    runtime: { id: "runtime-1" },
    instance: { id: "instance-1", runtime: { containerName: "instance-1" } },
  }, { archivePath: "/cache/runtime.tar.gz", identity });

  assert.ok(calls.some((args) => args[0] === "cp" && args[2].startsWith("recovered-container:")));
  assert.equal(calls.filter((args) => args[0] === "exec").every((args) => args[3] === "recovered-container"), true);
});

test("Docker restart validates the authoritative container id before restart", async () => {
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: "replacement-container", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const context = {
    project: { id: "project-1", source: { type: "git-repository" } },
    image: { requestedReference: "task-handoff:latest" },
    node: { id: "node-1" },
    runtime: { id: "runtime-1" },
    instance: { id: "instance-1", runtime: { containerName: "instance-1" } },
  };
  await assert.rejects(
    () => executor.restart(context, "authoritative-container"),
    (error) => error.code === "INSTANCE_RUNTIME_RESTART_FAILED" && /identity mismatch before restart/.test(error.message),
  );
  assert.equal(calls.some((args) => args[0] === "restart"), false);
});

test("Docker runtime install recovery starts the same stopped container before retry", async () => {
  const calls = [];
  let running = false;
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({
        Id: "authoritative-container",
        State: { Running: running },
        Config: { Entrypoint: [], Cmd: [], Labels: { "task-handoff.instance-id": "instance-1" } },
        Mounts: [],
      }), stderr: "" };
    }
    if (args[0] === "start") {
      running = true;
      return { stdout: "instance-1", stderr: "" };
    }
    throw new Error(`unexpected Docker command: ${args.join(" ")}`);
  });

  assert.equal(await executor.ensureRuntimeInstallTargetRunning("instance-1", "authoritative-container"), "authoritative-container");
  assert.equal(calls.filter((args) => args[0] === "start").length, 1);
  assert.ok(calls.some((args) => args[0] === "start" && args[1] === "authoritative-container"));
});

test("Docker runtime install recovery never starts a replacement container", async () => {
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({
        Id: "replacement-container",
        State: { Running: false },
        Config: { Entrypoint: [], Cmd: [], Labels: { "task-handoff.instance-id": "instance-1" } },
        Mounts: [],
      }), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(
    () => executor.ensureRuntimeInstallTargetRunning("instance-1", "authoritative-container"),
    (error) => error.code === "INSTANCE_RUNTIME_INSTALL_FAILED" && /identity mismatch before runtime install recovery/.test(error.message),
  );
  assert.equal(calls.some((args) => args[0] === "start"), false);
});

test("Docker runtime target follows the target image rather than the node process", async () => {
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect" && args[1] === "--format") {
      return { stdout: JSON.stringify({ Platform: "linux", Image: "sha256:image" }), stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { stdout: JSON.stringify({ Os: "linux", Architecture: "amd64" }), stderr: "" };
    }
    throw new Error(`unexpected Docker command: ${args.join(" ")}`);
  });
  assert.deepEqual(await executor.inspectRuntimeTarget("instance-1"), { platform: "linux", arch: "x64", launcherAbi: 1 });
});

test("Docker runtime target falls back to daemon architecture and normalizes aliases", async () => {
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "aarch64" }), stderr: "" };
    throw new Error("container unavailable");
  });
  assert.deepEqual(await executor.inspectRuntimeTarget(), { platform: "linux", arch: "arm64", launcherAbi: 1 });
});

test("runtime launcher installation verifies mounted node-agent assets with one root exec", async () => {
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: "container-abc", stderr: "" };
    if (args[0] === "exec" && args[1] !== "--user") throw new Error("launcher absent");
    return { stdout: "", stderr: "" };
  }, { launcherAssetsDir: "/assets" });
  await executor.installRuntimeLauncher("instance-1", "container-abc");
  const rootExec = calls.filter((args) => args[0] === "exec" && args[1] === "--user" && args[2] === "0");
  assert.equal(rootExec.length, 1);
  assert.equal(rootExec[0][3], "container-abc");
  assert.match(rootExec[0].at(-1), /install -d -o root/);
  assert.equal(calls.some((args) => args[0] === "cp"), false);
  assert.equal(calls.some((args) => args[0] === "rm" || args[0] === "run" || args[0] === "pull"), false);
});

test("Linux launcher sources and package preparation enforce LF line endings", () => {
  const attributes = fs.readFileSync(path.resolve(__dirname, "../.gitattributes"), "utf8").split(/\r?\n/);
  for (const pattern of ["*.sh", "*.mjs", "*.cjs", "*.js"]) {
    assert.ok(attributes.includes(`${pattern} text eol=lf`), `${pattern} must be pinned to LF`);
  }
  const preparation = fs.readFileSync(path.resolve(__dirname, "../scripts/prepare-runtime-packages.mjs"), "utf8");
  assert.match(preparation, /replace\(\/\\r\\n\?\/g, "\\n"\)/);
  for (const file of ["entrypoint.sh", "instance-launcher.sh", "runtime-installer.mjs"]) {
    const contents = fs.readFileSync(path.resolve(__dirname, "../docker", file));
    assert.equal(contents.includes(Buffer.from("\r\n")), false, `${file} must use LF line endings`);
  }
  const entrypoint = fs.readFileSync(path.resolve(__dirname, "../docker/entrypoint.sh"), "utf8");
  const launcher = fs.readFileSync(path.resolve(__dirname, "../docker/instance-launcher.sh"), "utf8");
  assert.match(entrypoint, /sudo --preserve-env -u agent -- bash "\$0"/);
  assert.match(entrypoint, /exec bash "\$\{TASK_HANDOFF_INSTANCE_LAUNCHER\}"/);
  assert.doesNotMatch(launcher, /task-handoff-controlled-instance/);
});

test("runtime launcher installation preserves the root command stderr", async () => {
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect") return { stdout: "container-abc", stderr: "" };
    if (args[0] === "exec" && args[1] !== "--user") throw new Error("launcher absent");
    if (args[0] === "exec") {
      throw Object.assign(new Error("docker exec failed"), { details: { stdout: "", stderr: "install: permission denied" } });
    }
    return { stdout: "", stderr: "" };
  }, { launcherAssetsDir: "/assets" });
  await assert.rejects(
    () => executor.installRuntimeLauncher("instance-1"),
    (error) => error.code === "INSTANCE_BASE_RUNTIME_INCOMPATIBLE" && /Cause: install: permission denied/.test(error.message),
  );
});

test("runtime launcher installation rejects a replacement before root exec", async () => {
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: "replacement-container", stderr: "" };
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(
    () => executor.installRuntimeLauncher("instance-1", "authoritative-container"),
    (error) => error.code === "INSTANCE_BASE_RUNTIME_INCOMPATIBLE" && /identity mismatch before runtime launcher install/.test(error.message),
  );
  assert.equal(calls.some((args) => args[0] === "exec"), false);
});

test("container installer verifies payload and atomically activates an idempotent release", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-installer-test-"));
  try {
    const payload = path.join(root, "payload");
    fs.mkdirSync(path.join(payload, "dist"), { recursive: true });
    fs.writeFileSync(path.join(payload, "package.json"), "{}\n");
    fs.writeFileSync(path.join(payload, "dist", "controlled-instance.js"), "process.stdout.write('ready')\n");
    fs.symlinkSync("dist/controlled-instance.js", path.join(payload, "entry.js"));
    const entries = [
      ["L", "entry.js", Buffer.from("dist/controlled-instance.js")],
      ["F", "package.json", Buffer.from("{}\n")],
      ["F", "dist/controlled-instance.js", Buffer.from("process.stdout.write('ready')\n")],
    ];
    // Keep the listing above spawnSync's default buffer so this exercises the
    // production-sized dependency tree path that the real artifact uses.
    fs.mkdirSync(path.join(payload, "deps"));
    for (let index = 0; index < 6_000; index += 1) {
      const relative = `deps/${String(index).padStart(5, "0")}-${"x".repeat(160)}`;
      fs.writeFileSync(path.join(payload, relative), "");
      entries.push(["F", relative, Buffer.alloc(0)]);
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left[1]), Buffer.from(right[1])));
    const hash = crypto.createHash("sha256");
    for (const [type, relative, contents] of entries) {
      hash.update(type);
      hash.update(relative);
      hash.update(Buffer.from([0]));
      hash.update(String(contents.byteLength));
      hash.update(Buffer.from([0]));
      hash.update(contents);
      hash.update(Buffer.from([0]));
    }
    const sha256 = hash.digest("hex");
    fs.writeFileSync(path.join(payload, "runtime-manifest.json"), `${JSON.stringify({
      packageName: "@task-handoff/controlled-instance",
      version: "1.2.3",
      platform: process.platform,
      arch: process.arch,
      formatVersion: 1,
      launcherAbi: 1,
      entrypoint: "dist/controlled-instance.js",
      sha256,
    })}\n`);
    const archive = path.join(root, "runtime.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", payload, "."]);
    const runtimeRoot = path.join(root, "runtime");
    const installer = path.resolve(__dirname, "../docker/runtime-installer.mjs");
    const args = [installer, "install", "--artifact", archive, "--version", "1.2.3", "--sha256", sha256, "--platform", process.platform, "--arch", process.arch, "--launcher-abi", "1"];
    execFileSync(process.execPath, args, { env: { ...process.env, TASK_HANDOFF_INSTANCE_RUNTIME_ROOT: runtimeRoot } });
    execFileSync(process.execPath, args, { env: { ...process.env, TASK_HANDOFF_INSTANCE_RUNTIME_ROOT: runtimeRoot } });
    const verified = JSON.parse(execFileSync(process.execPath, [installer, "verify-active"], { encoding: "utf8", env: { ...process.env, TASK_HANDOFF_INSTANCE_RUNTIME_ROOT: runtimeRoot } }));
    assert.equal(verified.sha256, sha256);
    const release = `1.2.3-${sha256}`;
    assert.equal(fs.realpathSync(path.join(runtimeRoot, "current")), fs.realpathSync(path.join(runtimeRoot, "releases", release)));
    assert.equal(fs.readdirSync(path.join(runtimeRoot, "releases")).length, 1);
    assert.equal(fs.statSync(path.join(runtimeRoot, "releases", release)).mode & 0o022, 0);
    fs.writeFileSync(path.join(runtimeRoot, "releases", release, "dist", "controlled-instance.js"), "tampered\n");
    assert.throws(
      () => execFileSync(process.execPath, [installer, "verify-active"], { stdio: "pipe", env: { ...process.env, TASK_HANDOFF_INSTANCE_RUNTIME_ROOT: runtimeRoot } }),
      /status: 1|Command failed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
