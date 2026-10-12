import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutorContext } from "../src/node-agent/runtimes/docker.ts";
import {
  WSL_BOOTSTRAP_ROOT,
  WSL_NODE_AGENT_PROBE_SCRIPT,
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

test("node agent url probes candidates inside the distro and takes the first reachable one", async () => {
  const executor = fakeExecutor();
  const probed: string[] = [];
  const lifecycle = makeLifecycle(executor, {
    probeAttempts: 1,
    probeNodeAgent: async (_distro: string, url: string) => {
      probed.push(url);
      return { reachable: url.startsWith("http://172.20.0.1:") };
    },
  });
  assert.equal(await lifecycle.nodeAgentUrl(gitContext(), "th-wsl-inst_a"), "http://172.20.0.1:8091");
  assert.deepEqual(probed, ["http://127.0.0.1:8091", "http://172.20.0.1:8091"]);
});

test("node agent url accepts the distro loopback when WSL shares the host localhost", async () => {
  const lifecycle = makeLifecycle(fakeExecutor(), { probeNodeAgent: async () => ({ reachable: true }) });
  assert.equal(await lifecycle.nodeAgentUrl(gitContext(), "th-wsl-inst_a"), "http://127.0.0.1:8091");
});

test("an explicit host address is the only probed candidate", async () => {
  const probed: string[] = [];
  const lifecycle = makeLifecycle(fakeExecutor(), {
    hostAddress: "192.168.1.5:9000",
    probeNodeAgent: async (_distro: string, url: string) => { probed.push(url); return { reachable: true }; },
  });
  assert.equal(await lifecycle.nodeAgentUrl(gitContext(), "th-wsl-inst_a"), "http://192.168.1.5:9000");
  assert.deepEqual(probed, ["http://192.168.1.5:9000"]);
});

test("the default probe runs the identity-checked HTTP probe inside the distro", async () => {
  const executor = fakeExecutor();
  const lifecycle = makeLifecycle(executor, { probeAttempts: 1 });
  assert.equal(await lifecycle.nodeAgentUrl(gitContext(), "th-wsl-inst_a"), "http://127.0.0.1:8091");
  const probeCall = executor.calls.find((call) => call.kind === "exec" && call.args?.[0] === "node" && call.args?.[2] === WSL_NODE_AGENT_PROBE_SCRIPT);
  assert.ok(probeCall, "expected the in-distro node probe to run");
  assert.equal(probeCall.args?.[3], "http://127.0.0.1:8091");
  assert.match(WSL_NODE_AGENT_PROBE_SCRIPT, /data\.role === 'node-agent'/);
  // 外部监听在节点已配对时要求 HMAC：401 `NODE_AGENT_*` 也必须算命中，否则探测会误报不可达。
  assert.match(WSL_NODE_AGENT_PROBE_SCRIPT, /startsWith\('NODE_AGENT_'\)/);
});

test("an unreachable node agent fails fast with the bind address and remediation", async () => {
  const lifecycle = makeLifecycle(fakeExecutor(), {
    probeAttempts: 1,
    listenerHost: () => "127.0.0.1",
    probeNodeAgent: async () => ({ reachable: false, detail: "connect ECONNREFUSED 172.20.0.1:8091" }),
  });
  await assert.rejects(
    lifecycle.nodeAgentUrl(gitContext(), "th-wsl-inst_a"),
    (error: Error & { code?: string; details?: Record<string, never> }) => {
      assert.equal(error.code, "WSL_NODE_AGENT_UNREACHABLE");
      const details = error.details as unknown as {
        listenerHost: string;
        listenerPort: number;
        candidates: Array<{ url: string; source: string; reason: string }>;
        remediation: string[];
      };
      assert.equal(details.listenerHost, "127.0.0.1");
      assert.equal(details.listenerPort, 8091);
      assert.deepEqual(details.candidates.map((entry) => entry.source), ["loopback", "gateway"]);
      assert.match(details.candidates[1].reason, /ECONNREFUSED/);
      assert.match(details.remediation[0], /all-ipv4/);
      assert.match(details.remediation[0], /Hyper-V firewall/);
      assert.ok(details.remediation.some((line) => line.includes("mirrored")));
      return true;
    },
  );
});

test("probe failures are retried before a candidate is written off", async () => {
  let attempts = 0;
  const lifecycle = makeLifecycle(fakeExecutor(), {
    probeNodeAgent: async () => {
      attempts += 1;
      return { reachable: attempts >= 2 };
    },
  });
  assert.equal(await lifecycle.nodeAgentUrl(gitContext(), "th-wsl-inst_a"), "http://127.0.0.1:8091");
  assert.equal(attempts, 2);
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
  const env = buildWslRuntimeEnvironment(gitContext(), { nodeAgentUrl: "http://172.20.0.1:8091", workspace: "/workspace", port: 19001 });
  assert.equal(env.TASK_HANDOFF_RUNTIME_KIND, "wsl");
  assert.equal(env.TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH, WSL_PRIVATE_CONFIG_PATH);
  assert.equal(env.TASK_HANDOFF_SKIP_WORKSPACE_BOOTSTRAP, "true");
  assert.ok("TASK_HANDOFF_WORKSPACE_GIT_URL" in env);
  assert.ok(Object.keys(env).every((key) => !/secret|token|password/i.test(key)));
});

test("the instance is told to listen on the node-owned port, not the image default", () => {
  const env = buildWslRuntimeEnvironment(gitContext(), { nodeAgentUrl: "http://127.0.0.1:18091", workspace: "/workspace", port: 19001 });
  assert.equal(env.TASK_HANDOFF_WEB_PORT, "19001");
  assert.equal(env.TASK_HANDOFF_WEB_HOST, "127.0.0.1");
});

test("a no-image WSL instance reports no image identity to the registration check", () => {
  // 实例记录没有 imageSelection 时上报 context.image（img_localhost）会被注册校验 403 拒绝。
  const noImage = buildWslRuntimeEnvironment(gitContext(), { nodeAgentUrl: "http://127.0.0.1:18091", workspace: "/workspace", port: 19001 });
  assert.ok(!("TASK_HANDOFF_IMAGE_ID" in noImage));
  assert.ok(!("TASK_HANDOFF_IMAGE_TAG" in noImage));

  const context = gitContext();
  (context.instance as { imageSelection?: unknown }).imageSelection = { imageId: "market_taskhandoff_codex", tag: "latest" };
  const withImage = buildWslRuntimeEnvironment(context, { nodeAgentUrl: "http://127.0.0.1:18091", workspace: "/workspace", port: 19001 });
  assert.equal(withImage.TASK_HANDOFF_IMAGE_ID, "market_taskhandoff_codex");
  assert.equal(withImage.TASK_HANDOFF_IMAGE_TAG, "latest");
});

test("start passes the allocated port into the unit environment", async () => {
  const executor = fakeExecutor();
  const lifecycle = makeLifecycle(executor, { probeNodeAgent: async () => ({ reachable: true }) });
  await lifecycle.start(gitContext({ port: 19001 }));
  const unitWrite = executor.calls.find((call) => call.kind === "execOrThrow" && (call.args?.[2] ?? "").includes("/etc/systemd/system/task-handoff-instance.service"));
  const unit = Buffer.from((/printf '%s' '([A-Za-z0-9+/=]+)'/.exec(unitWrite?.args?.[2] ?? "")?.[1] ?? ""), "base64").toString("utf8");
  assert.match(unit, /Environment="TASK_HANDOFF_WEB_PORT=19001"/);
});
