import assert from "node:assert/strict";
import test from "node:test";
import type { NodeRuntime } from "@task-handoff/protocol/control-plane";
import {
  WSL_DEFAULT_SESSION_COMMAND,
  WSL_DISTRO_MISSING,
  WSL_DISTRO_NAME_MAX_LENGTH,
  WSL_DISTRO_PREFIX,
  WSL_RUNTIME_UNSUPPORTED_PLATFORM,
  WSL_SESSION_FAILED,
  WslExecutor,
  decodeWslOutput,
  defaultWslExecutablePath,
  parseWslDistroList,
  wslDistroNameForInstance,
  type WslCommandOptions,
  type WslCommandRunner,
  type WslSessionHandle,
} from "../src/node-agent/runtimes/wsl-executor.ts";
import {
  WSL_RUNTIME_LIFECYCLE_UNAVAILABLE,
  WslRuntimeAdapter,
  wslDistroNameForInstanceRecord,
  wslRuntimeCapabilities,
} from "../src/node-agent/runtimes/wsl-adapter.ts";
import type { ExecutorContext } from "../src/node-agent/runtimes/docker.ts";

type FakeCall = { args: string[]; options?: WslCommandOptions };

function fakeRunner(handler: (args: string[]) => { stdout?: string; stderr?: string; exitCode?: number } | undefined) {
  const calls: FakeCall[] = [];
  const runner: WslCommandRunner = async (args, options) => {
    calls.push({ args, options });
    const result = handler(args) ?? {};
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
  };
  return { runner, calls };
}

const LIST_OUTPUT = [
  "  NAME              STATE           VERSION",
  "* docker-desktop    Running         2",
  "  th-spike          Stopped         2",
  "",
].join("\n");

function fakeSession(name: string) {
  let alive = true;
  const handle: WslSessionHandle = {
    name,
    pid: 4242,
    alive: () => alive,
    stop: async () => {
      alive = false;
    },
  };
  return { handle, isAlive: () => alive, kill: () => { alive = false; } };
}

function context(instance: { id: string; port?: number; containerName?: string }) {
  return {
    instance: {
      id: instance.id,
      runtime: {
        port: instance.port,
        containerName: instance.containerName ?? "",
      },
    },
  } as unknown as ExecutorContext;
}

test("distro names are prefixed, legal, bounded and injective", () => {
  const simple = wslDistroNameForInstance("inst_05nyqzs5fadax");
  assert.ok(simple.startsWith(WSL_DISTRO_PREFIX));
  assert.match(simple, /^th-wsl-[a-z0-9-]+$/);
  assert.ok(simple.length <= WSL_DISTRO_NAME_MAX_LENGTH);
  assert.ok(!simple.startsWith("."));
  assert.equal(simple, wslDistroNameForInstance("inst_05nyqzs5fadax"));

  const collidingA = wslDistroNameForInstance("inst_a b");
  const collidingB = wslDistroNameForInstance("inst_a-b");
  assert.equal(collidingA.slice(0, collidingA.lastIndexOf("-")), collidingB.slice(0, collidingB.lastIndexOf("-")));
  assert.notEqual(collidingA, collidingB);

  const long = wslDistroNameForInstance(`inst_${"x".repeat(400)}`);
  assert.ok(long.length <= WSL_DISTRO_NAME_MAX_LENGTH, `expected <=128 chars, got ${long.length}`);

  const illegal = wslDistroNameForInstance('inst/../../etc "quoted" *?![]');
  assert.match(illegal, /^th-wsl-[a-z0-9-]+$/);
  assert.throws(() => wslDistroNameForInstance("   "), { code: "WSL_INSTANCE_ID_INVALID" });
});

test("wsl.exe output decoding adapts between UTF-16LE and UTF-8", () => {
  assert.equal(decodeWslOutput(Buffer.from("  NAME STATE VERSION\n", "utf16le")), "  NAME STATE VERSION\n");
  assert.equal(decodeWslOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("操作成功完成。", "utf16le")])), "操作成功完成。");
  assert.equal(decodeWslOutput(Buffer.from("Running\n", "utf8")), "Running\n");
  assert.equal(decodeWslOutput(Buffer.from("active\n", "utf8")), "active\n");
});

test("distro list parsing reads the UTF-16LE shaped table and ignores headers", () => {
  const distros = parseWslDistroList(LIST_OUTPUT);
  assert.deepEqual(distros, [
    { name: "docker-desktop", state: "Running", version: 2, isDefault: true },
    { name: "th-spike", state: "Stopped", version: 2, isDefault: false },
  ]);
  assert.deepEqual(parseWslDistroList(""), []);
  assert.deepEqual(parseWslDistroList("没有已安装的分发版。"), []);
});

test("the executable path is resolved absolutely from SystemRoot", () => {
  assert.equal(defaultWslExecutablePath({ SystemRoot: "D:\\Windows" }), "D:\\Windows\\System32\\wsl.exe");
  assert.equal(defaultWslExecutablePath({}), "C:\\Windows\\System32\\wsl.exe");
});

test("management and distro calls use the documented wsl.exe argument shapes", async () => {
  const { runner, calls } = fakeRunner((args) => {
    if (args[0] === "--list") return { stdout: LIST_OUTPUT };
    if (args[0] === "-d" && args[3] === "true") return { stdout: "" };
    return {};
  });
  const executor = new WslExecutor({ platform: "win32", wslPath: "C:\\Windows\\System32\\wsl.exe", runner });

  await executor.listDistros();
  assert.deepEqual(calls[0].args, ["--list", "--verbose"]);

  await executor.exec("th-spike", ["systemctl", "is-active", "th-spike-http"]);
  assert.deepEqual(calls[1].args, ["-d", "th-spike", "-u", "root", "--", "systemctl", "is-active", "th-spike-http"]);
  assert.equal(calls[1].options?.decode, "utf8");

  await executor.terminate("th-spike");
  assert.deepEqual(calls[2].args, ["--terminate", "th-spike"]);
  await executor.unregister("th-spike");
  assert.deepEqual(calls[3].args, ["--unregister", "th-spike"]);
  await executor.importDistro({ name: "th-wsl-inst", installDir: "C:\\th\\inst", tarballPath: "C:\\th\\base.tar.gz" });
  assert.deepEqual(calls[4].args, ["--import", "th-wsl-inst", "C:\\th\\inst", "C:\\th\\base.tar.gz", "--version", "2"]);
});

test("distro state maps to runtime liveness and unknown distros are absent", async () => {
  const { runner } = fakeRunner((args) => (args[0] === "--list" ? { stdout: LIST_OUTPUT } : {}));
  const executor = new WslExecutor({ platform: "win32", runner });
  assert.equal(await executor.distroState("docker-desktop"), "running");
  assert.equal(await executor.distroState("th-spike"), "stopped");
  assert.equal(await executor.distroState("missing"), "absent");
});

test("a non-Windows platform fails closed with a structured error", async () => {
  const executor = new WslExecutor({ platform: "darwin" });
  await assert.rejects(executor.listDistros(), { code: WSL_RUNTIME_UNSUPPORTED_PLATFORM });
});

test("failed management calls surface structured diagnostics with raw output", async () => {
  const { runner } = fakeRunner(() => ({ stdout: "", stderr: "指定的分发版不存在。", exitCode: -1 }));
  const executor = new WslExecutor({ platform: "win32", runner });
  await assert.rejects(executor.terminate("th-spike"), (error: Error & { code?: string; details?: { stderr?: string } }) => {
    assert.equal(error.code, "WSL_COMMAND_FAILED");
    assert.equal(error.details?.stderr, "指定的分发版不存在。");
    return true;
  });
});

test("ensureDistroRunning wakes a stopped distro and reports a missing one", async () => {
  let state = "Stopped";
  const { runner, calls } = fakeRunner((args) => {
    if (args[0] === "--list") {
      return { stdout: `  NAME              STATE           VERSION\n  th-wsl-inst       ${state}         2\n` };
    }
    if (args[0] === "-d" && args[args.length - 1] === "true") {
      state = "Running";
      return {};
    }
    return {};
  });
  const executor = new WslExecutor({ platform: "win32", runner });
  assert.equal(await executor.ensureDistroRunning("th-wsl-inst"), "running");
  assert.ok(calls.some((call) => JSON.stringify(call.args) === JSON.stringify(["-d", "th-wsl-inst", "-u", "root", "--", "true"])));

  const missing = new WslExecutor({ platform: "win32", runner: fakeRunner(() => ({ stdout: "" })).runner });
  await assert.rejects(missing.ensureDistroRunning("th-wsl-absent"), { code: WSL_DISTRO_MISSING });
});

test("the keep-alive session is held once per distro and released explicitly", async () => {
  const spawned: Array<{ name: string; args: string[] }> = [];
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const { runner } = fakeRunner((args) => (args[0] === "--list" ? { stdout: "  NAME STATE VERSION\n  th-wsl-inst Running 2\n" } : {}));
  const executor = new WslExecutor({
    platform: "win32",
    runner,
    sessionSpawner: (args, name) => {
      spawned.push({ name, args });
      const session = fakeSession(name);
      sessions.push(session);
      return session.handle;
    },
  });

  await executor.holdSession("th-wsl-inst");
  await executor.holdSession("th-wsl-inst");
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ["-d", "th-wsl-inst", "-u", "root", "--", ...WSL_DEFAULT_SESSION_COMMAND]);
  assert.equal(executor.sessionAlive("th-wsl-inst"), true);

  sessions[0].kill();
  assert.equal(executor.sessionAlive("th-wsl-inst"), false);

  await executor.holdSession("th-wsl-inst");
  assert.equal(spawned.length, 2);
  await executor.releaseSession("th-wsl-inst");
  assert.equal(executor.sessionAlive("th-wsl-inst"), false);
  await executor.holdSession("th-wsl-inst");
  assert.equal(spawned.length, 3);
  await executor.releaseAllSessions();
  assert.equal(executor.sessionAlive("th-wsl-inst"), false);
});

test("a session that cannot be confirmed is released and reported as failed", async () => {
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const { runner } = fakeRunner((args) => (args[0] === "--list" ? { stdout: "" } : { stdout: "" }));
  const executor = new WslExecutor({
    platform: "win32",
    runner,
    sessionSpawner: (args, name) => {
      const session = fakeSession(name);
      sessions.push(session);
      return session.handle;
    },
  });
  await assert.rejects(executor.holdSession("th-wsl-missing"), { code: WSL_SESSION_FAILED });
  assert.equal(executor.sessionAlive("th-wsl-missing"), false);
  assert.equal(sessions[0].isAlive(), false);
});

test("wsl runtime capabilities default to a no-image distro runtime", () => {
  assert.deepEqual(wslRuntimeCapabilities(), {
    requiresImage: false,
    artifactKind: "bundled-runtime-artifact",
    isolation: "distro",
    supportsControlledInstanceApi: true,
    supportsContainerLifecycle: false,
    supportsAppSessions: true,
    supportsHostSessions: false,
    workspaceProvisioning: { git: false, localFolder: false },
    baseProfiles: [],
  });
  const declared = wslRuntimeCapabilities({ workspaceProvisioning: { git: true }, baseProfiles: ["default"] });
  assert.deepEqual(declared.workspaceProvisioning, { git: true, localFolder: false });
  assert.deepEqual(declared.baseProfiles, ["default"]);
});

test("endpoint resolution uses the node-owned port and fails closed without one", async () => {
  const executor = new WslExecutor({ platform: "win32", runner: fakeRunner(() => ({})).runner });
  const adapter = new WslRuntimeAdapter(executor, { platform: "win32" });
  assert.equal(await adapter.resolveInstanceWeb(context({ id: "inst_one", port: 18099 })), "http://127.0.0.1:18099");
  await assert.rejects(adapter.resolveInstanceWeb(context({ id: "inst_one" })), { code: "INSTANCE_RUNTIME_ENDPOINT_UNAVAILABLE" });
});

test("runtime state is reported and unconfigured lifecycle fails closed", async () => {
  const { runner } = fakeRunner((args) => (args[0] === "--list" ? { stdout: "  NAME STATE VERSION\n  th-wsl-inst Running 2\n" } : {}));
  const executor = new WslExecutor({ platform: "win32", runner });
  const adapter = new WslRuntimeAdapter(executor, { platform: "win32" });
  assert.equal(wslDistroNameForInstanceRecord({ id: "inst_x", runtime: {} }), wslDistroNameForInstance("inst_x"));
  assert.equal(wslDistroNameForInstanceRecord({ id: "inst_x", runtime: { containerName: "th-wsl-custom" } }), "th-wsl-custom");
  assert.equal(await adapter.runtimeState(context({ id: "inst_x", containerName: "th-wsl-inst" })), "running");
  await assert.rejects(adapter.start(context({ id: "inst_x" })), { code: WSL_RUNTIME_LIFECYCLE_UNAVAILABLE });
  await assert.rejects(adapter.delete(context({ id: "inst_x" }), { deleteVolumes: false }), { code: WSL_RUNTIME_LIFECYCLE_UNAVAILABLE });
});

test("runtime check publishes structured online and offline diagnostics", async () => {
  const runtime = { capabilities: {} } as unknown as NodeRuntime;
  const online = new WslRuntimeAdapter(
    new WslExecutor({ platform: "win32", runner: fakeRunner(() => ({ stdout: "WSL 版本：3.0.1.0" })).runner }),
    { platform: "win32" },
  );
  const onlineResult = await online.check(runtime);
  assert.equal(onlineResult.status, "online");
  assert.equal((onlineResult.capabilities as any).requiresImage, false);
  assert.equal((onlineResult.capabilities as any).wsl.status, "online");

  const offline = new WslRuntimeAdapter(
    new WslExecutor({ platform: "win32", runner: fakeRunner(() => ({ stderr: "wsl.exe not found", exitCode: 1 })).runner }),
    { platform: "win32" },
  );
  const offlineResult = await offline.check(runtime);
  assert.equal(offlineResult.status, "offline");
  assert.equal((offlineResult.capabilities as any).wsl.status, "offline");
});
