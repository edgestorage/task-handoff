import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutorContext } from "../src/node-agent/runtimes/docker.ts";
import {
  WSL_BOOTSTRAP_ROOT,
  WSL_PRIVATE_CONFIG_PATH,
  WSL_UNIT_NAME,
  WslInstanceLifecycle,
  buildWslRuntimeEnvironment,
  renderWslInstanceUnit,
  systemdEnvironmentValue,
  windowsPathToDrvfs,
} from "../src/node-agent/runtimes/wsl-lifecycle.ts";
import type { WslSessionHandle } from "../src/node-agent/runtimes/wsl-executor.ts";

type Call = { kind: string; name?: string; args?: string[]; source?: string; destination?: string };

function fakeExecutor(options: { distroExists?: boolean } = {}) {
  const calls: Call[] = [];
  let sessionAlive = false;
  const sessions: WslSessionHandle[] = [];
  const executor = {
    calls,
    sessions,
    setSessionAlive(value: boolean) { sessionAlive = value; },
    async findDistro(name: string) {
      calls.push({ kind: "findDistro", name });
      return options.distroExists === false ? undefined : { name, state: "Running" };
    },
    async listDistros() { return []; },
    async unregister(name: string) { calls.push({ kind: "unregister", name }); },
    async terminate(name: string) { calls.push({ kind: "terminate", name }); },
    async systemctl(name: string, args: readonly string[]) { calls.push({ kind: "systemctl", name, args: [...args] }); return { stdout: "", stderr: "", exitCode: 0 }; },
    async unitActive(name: string, unit: string) { calls.push({ kind: "unitActive", name, args: [unit] }); return "active"; },
    async exec(name: string, argv: readonly string[]) { calls.push({ kind: "exec", name, args: [...argv] }); return { stdout: "", stderr: "", exitCode: 0 }; },
    async execOrThrow(name: string, argv: readonly string[]) { calls.push({ kind: "execOrThrow", name, args: [...argv] }); return { stdout: "", stderr: "", exitCode: 0 }; },
    async copyIntoDistro(name: string, source: string, destination: string) { calls.push({ kind: "copy", name, source, destination }); },
    async holdSession(name: string) {
      calls.push({ kind: "holdSession", name });
      sessionAlive = true;
      const handle: WslSessionHandle = { name, alive: () => sessionAlive, stop: async () => { sessionAlive = false; } };
      sessions.push(handle);
      return handle;
    },
    async releaseSession(name: string) { calls.push({ kind: "releaseSession", name }); sessionAlive = false; },
    async distroState() { return "running" as const; },
    async ensureDistroRunning() { return "running" as const; },
    async defaultGateway() { return "172.20.0.1"; },
    sessionAlive() { return sessionAlive; },
  };
  return executor;
}

function fakeProvisioner() {
  return {
    distroNameForInstance(instance: { id: string; containerName?: string }) {
      return instance.containerName?.trim() || `th-wsl-${instance.id}`;
    },
    async provision(instance: { id: string; runtimeId: string; containerName?: string }) {
      return {
        distroName: this.distroNameForInstance(instance),
        created: true,
        ownership: {} as never,
        labels: { "task-handoff.runtime-kind": "wsl", "task-handoff.instance-id": instance.id },
        state: "Running" as const,
      };
    },
    forgetDistro() {},
  };
}

function gitContext(overrides: {
  id?: string;
  containerName?: string;
  port?: number;
  source?: Record<string, unknown>;
} = {}) {
  const id = overrides.id ?? "inst_a";
  return {
    instance: {
      id,
      name: "Instance",
      runtimeId: "runtime_wsl_host",
      runtime: { containerName: overrides.containerName, labels: {}, ...(overrides.port ? { port: overrides.port } : {}), target: { status: "unknown" } },
      target: { status: "unknown" },
    },
    project: {
      id: "proj_1",
      source: overrides.source ?? { type: "git", url: "https://example.com/x.git", ref: { type: "branch", name: "main" }, clone: { depth: 1 } },
      workspacePolicy: { path: "/workspace", mode: "git-clone", readOnly: false },
    },
    image: { id: "img_localhost", tag: "local" },
    node: { id: "node_1" },
    runtime: { id: "runtime_wsl_host" },
    privateConfigPath: "/tmp/nonexistent-private-config.json",
  } as unknown as ExecutorContext;
}

function makeLifecycle(executor: ReturnType<typeof fakeExecutor>, extra: Record<string, unknown> = {}) {
  return new WslInstanceLifecycle({
    provisioner: fakeProvisioner() as never,
    executor: executor as never,
    listenerPort: 8091,
    allocatePort: async () => 18099,
    ...extra,
  });
}

test("windowsPathToDrvfs maps drives and rejects non-Windows paths", () => {
  assert.equal(windowsPathToDrvfs("C:\\Users\\x\\repo"), "/mnt/c/Users/x/repo");
  assert.equal(windowsPathToDrvfs("d:/data/repo"), "/mnt/d/data/repo");
  assert.equal(windowsPathToDrvfs("/home/user/repo"), undefined);
});

test("systemd environment values escape specifiers, quotes and backslashes", () => {
  assert.equal(systemdEnvironmentValue('50% "quoted" \\ path\nline'), '50%% \\"quoted\\" \\\\ path\\nline');
  const unit = renderWslInstanceUnit({ B_KEY: "b", A_KEY: "a" }, { workspace: "/workspace", description: "d" });
  assert.match(unit, /Environment="A_KEY=a"\nEnvironment="B_KEY=b"/);
  assert.match(unit, /ExecStart=\/bin\/bash \/opt\/task-handoff\/bootstrap\/entrypoint\.sh task-handoff web/);
});

test("start provisions the distro, holds a keep-alive session and starts the unit", async () => {
  const executor = fakeExecutor();
  const lifecycle = makeLifecycle(executor);
  const result = await lifecycle.start(gitContext({ port: 18099 }));
  assert.equal(result.runtime?.containerName, "th-wsl-inst_a");
  assert.equal(result.runtime?.port, 18099);
  assert.equal(result.target?.web, "http://127.0.0.1:18099");
  assert.equal(result.runtime?.kind, "wsl");
  assert.ok(executor.calls.some((call) => call.kind === "holdSession" && call.name === "th-wsl-inst_a"));
  assert.ok(executor.calls.some((call) => call.kind === "systemctl" && call.args?.[0] === "restart" && call.args?.[1] === WSL_UNIT_NAME));
  assert.ok(executor.calls.some((call) => call.kind === "execOrThrow" && (call.args?.[2] ?? "").includes("/etc/systemd/system/task-handoff-instance.service")));
});

test("stop stops the unit, releases the session and terminates the distro", async () => {
  const executor = fakeExecutor();
  const lifecycle = makeLifecycle(executor);
  const result = await lifecycle.stop(gitContext({ containerName: "th-wsl-inst_a" }));
  assert.equal(result.status, "stopped");
  const order = executor.calls.map((call) => call.kind);
  assert.ok(executor.calls.some((call) => call.kind === "systemctl" && call.args?.[0] === "stop"));
  assert.ok(order.indexOf("releaseSession") < order.indexOf("terminate"));
});

test("delete unregisters an owned distro and reports deleted volumes", async () => {
  const executor = fakeExecutor();
  const lifecycle = makeLifecycle(executor);
  const result = await lifecycle.delete(gitContext({ containerName: "th-wsl-inst_a" }), { deleteVolumes: true });
  assert.equal(result.completed, true);
  assert.equal(result.containerDeleted, true);
  assert.ok(executor.calls.some((call) => call.kind === "unregister" && call.name === "th-wsl-inst_a"));
  assert.equal(result.deletedVolumes.length, 3);
});

test("delete failure retains the business record for idempotent retry", async () => {
  const executor = fakeExecutor();
  executor.unregister = async () => { throw Object.assign(new Error("busy"), { code: "WSL_COMMAND_FAILED" }); };
  const lifecycle = makeLifecycle(executor);
  const result = await lifecycle.delete(gitContext({ containerName: "th-wsl-inst_a" }), { deleteVolumes: true });
  assert.equal(result.completed, false);
  assert.equal(result.volumeResults.every((entry) => entry.status === "failed"), true);
});

test("node agent url prefers an explicit address then falls back to the distro gateway", async () => {
  const executor = fakeExecutor();
  const gatewayLifecycle = makeLifecycle(executor);
  assert.equal(await gatewayLifecycle.nodeAgentUrl(gitContext(), "th-wsl-inst_a"), "http://172.20.0.1:8091");
  const explicit = makeLifecycle(fakeExecutor(), { hostAddress: "192.168.1.5:9000" });
  assert.equal(await explicit.nodeAgentUrl(gitContext(), "th-wsl-inst_a"), "http://192.168.1.5:9000");
});

test("local-folder workspaces map to drvfs symlinks and reject unmappable paths", async () => {
  const executor = fakeExecutor();
  const lifecycle = makeLifecycle(executor);
  const result = await lifecycle.start(gitContext({
    source: { type: "local-folder", path: "C:\\Users\\zspmhzx\\Desktop\\repo" },
  }));
  assert.equal(result.workspace?.path, "/workspace");
  assert.ok(executor.calls.some((call) => call.kind === "execOrThrow" && (call.args?.[2] ?? "").includes("ln -sfn '/mnt/c/Users/zspmhzx/Desktop/repo'")));

  const unmappable = makeLifecycle(fakeExecutor());
  await assert.rejects(
    unmappable.start(gitContext({ source: { type: "local-folder", path: "/home/user/repo" } })),
    { code: "WSL_WORKSPACE_UNSUPPORTED" },
  );
});

test("runtime environment declares WSL identity, private config bridge and git contract", () => {
  const env = buildWslRuntimeEnvironment(gitContext(), { nodeAgentUrl: "http://172.20.0.1:8091", workspace: "/workspace" });
  assert.equal(env.TASK_HANDOFF_RUNTIME_KIND, "wsl");
  assert.equal(env.TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH, WSL_PRIVATE_CONFIG_PATH);
  assert.equal(env.TASK_HANDOFF_SKIP_WORKSPACE_BOOTSTRAP, "true");
  assert.ok("TASK_HANDOFF_WORKSPACE_GIT_URL" in env);
  assert.ok(Object.keys(env).every((key) => !/secret|token|password/i.test(key)));
});
