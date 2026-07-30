const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const WebSocket = require("ws");

const { InstanceResourceMetricsSchema } = require("../packages/protocol/src/control-plane.ts");
const { DockerRuntimeMetricsCollector, parseDockerByteSize, parseDockerStatsOutput } = require("../packages/control-plane/src/node-agent/runtime-metrics.ts");
const { defaultCommandRunner } = require("../packages/control-plane/src/shared/process/command-runner.ts");
const { NodeAgentInstanceEventForwarder } = require("../packages/control-plane/src/node-agent/events.ts");

test("docker metric sizes normalize decimal and binary units", () => {
  assert.equal(parseDockerByteSize("512B"), 512);
  assert.equal(parseDockerByteSize("1.5kB"), 1500);
  assert.equal(parseDockerByteSize("1.5KiB"), 1536);
  assert.equal(parseDockerByteSize("2GiB"), 2 * 1024 ** 3);
  assert.equal(parseDockerByteSize("invalid"), undefined);
});

test("docker stats output becomes numeric resource metrics", () => {
  const sampledAt = "2026-07-17T00:00:00.000Z";
  const output = JSON.stringify({
    id: "abc123",
    name: "task-handoff-inst_1",
    cpu: "125.25%",
    memory: "512MiB / 2GiB",
    memoryPercent: "25.00%",
    network: "1.5MB / 2KiB",
    blockIo: "4MB / 5MB",
    pids: "24",
  });
  const parsed = parseDockerStatsOutput(output, sampledAt).get("task-handoff-inst_1");

  assert.deepEqual(parsed, {
    instanceId: "abc123",
    runtimeKind: "docker",
    state: "available",
    sampledAt,
    cpu: { usagePercent: 125.25 },
    memory: { usageBytes: 512 * 1024 ** 2, limitBytes: 2 * 1024 ** 3, usagePercent: 25 },
    network: { rxBytes: 1_500_000, txBytes: 2048 },
    blockIo: { readBytes: 4_000_000, writeBytes: 5_000_000 },
    pids: 24,
  });
});

test("collector batches containers, maps names to instances, and clears stopped values", async () => {
  const calls = [];
  const published = [];
  let targets = [{
    id: "inst_1",
    status: "running",
    runtime: { containerId: "abc123full", containerName: "task-handoff-inst_1", labels: {} },
  }];
  const collector = new DockerRuntimeMetricsCollector(async (command, args, options) => {
    calls.push([command, args, options]);
    return {
      stdout: JSON.stringify({ id: "abc123", name: "task-handoff-inst_1", cpu: "2.5%", memory: "64MiB / 1GiB", memoryPercent: "6.25%", network: "0B / 0B", blockIo: "0B / 0B", pids: "3" }),
      stderr: "",
    };
  }, () => targets, (metrics) => published.push(metrics));

  await collector.collect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "docker");
  assert.equal(calls[0][1].at(-1), "abc123full");
  assert.equal(calls[0][2].timeoutMs, 5_000);
  assert.equal(published.at(-1).instanceId, "inst_1");
  assert.equal(published.at(-1).state, "available");

  targets = [{ ...targets[0], status: "stopped" }];
  await collector.collect();
  assert.equal(calls.length, 1);
  assert.equal(published.at(-1).state, "stopped");
  assert.equal(published.at(-1).cpu, undefined);
});

test("the default command runner terminates commands at their deadline", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(
    defaultCommandRunner(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }),
    (error) => error.code === "RUNTIME_COMMAND_TIMEOUT" && error.statusCode === 504,
  );
});

test("collector reports pending before Docker assigns a container identifier", async () => {
  const published = [];
  const target = { id: "inst_pending", status: "starting", runtime: { labels: {} } };
  const collector = new DockerRuntimeMetricsCollector(async () => assert.fail("docker stats must not run"), () => [target], (metrics) => published.push(metrics));
  await collector.collect();
  assert.equal(published.at(-1).instanceId, "inst_pending");
  assert.equal(published.at(-1).state, "pending");
  assert.equal((await collector.snapshot("inst_pending")).state, "pending");
});

test("collector serializes overlapping samples", async () => {
  const target = { id: "inst_1", status: "running", runtime: { containerId: "abc123full", labels: {} } };
  let running = 0;
  let maxRunning = 0;
  let releaseFirst;
  let calls = 0;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const collector = new DockerRuntimeMetricsCollector(async () => {
    calls += 1;
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    if (calls === 1) await firstGate;
    running -= 1;
    return { stdout: JSON.stringify({ id: "abc123", cpu: "1%", memory: "1MiB / 1GiB", memoryPercent: "0.1%", network: "0B / 0B", blockIo: "0B / 0B", pids: "1" }), stderr: "" };
  }, () => [target]);
  const first = collector.collect();
  const second = collector.collect();
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maxRunning, 1);
  assert.equal(calls, 1);
});

test("fresh metric snapshots are served without starting another Docker sample", async () => {
  const target = { id: "inst_cached", status: "running", runtime: { containerId: "cached-full", labels: {} } };
  let calls = 0;
  const collector = new DockerRuntimeMetricsCollector(async () => {
    calls += 1;
    return { stdout: JSON.stringify({ id: "cached", cpu: "1%", memory: "1MiB / 1GiB", memoryPercent: "0.1%", network: "0B / 0B", blockIo: "0B / 0B", pids: "1" }), stderr: "" };
  }, () => [target]);

  await collector.collect();
  const first = await collector.snapshot(target.id);
  const second = await collector.snapshot(target.id);

  assert.equal(first, second);
  assert.equal(calls, 1);
});

test("one missing container does not poison metrics for healthy containers", async () => {
  const published = [];
  const healthy = { id: "inst_ok", status: "running", runtime: { containerId: "healthy-full", labels: {} } };
  const missing = { id: "inst_missing", status: "running", runtime: { containerId: "missing-full", labels: {} } };
  const collector = new DockerRuntimeMetricsCollector(async (_command, args) => {
    const identifiers = args.slice(args.indexOf("--format") + 2);
    if (identifiers.length > 1 || identifiers[0] === "missing-full") throw new Error("No such container");
    return { stdout: JSON.stringify({ id: "healthy", cpu: "3%", memory: "3MiB / 1GiB", memoryPercent: "0.3%", network: "0B / 0B", blockIo: "0B / 0B", pids: "2" }), stderr: "" };
  }, () => [healthy, missing], (metrics) => published.push(metrics));
  await collector.collect();
  assert.equal(published.findLast((entry) => entry.instanceId === "inst_ok").state, "available");
  assert.equal(published.findLast((entry) => entry.instanceId === "inst_missing").state, "unavailable");
});

test("resource metrics protocol remains strict", () => {
  const valid = { instanceId: "inst_1", runtimeKind: "docker", state: "available", sampledAt: "2026-07-17T00:00:00.000Z", cpu: { usagePercent: 2.5 } };
  assert.equal(InstanceResourceMetricsSchema.safeParse(valid).success, true);
  assert.equal(InstanceResourceMetricsSchema.safeParse({ ...valid, secret: "nope" }).success, false);
  assert.equal(InstanceResourceMetricsSchema.safeParse({ ...valid, cpu: { usagePercent: -1 } }).success, false);
});

test("node agent publishes metric snapshots through the authoritative event stream", () => {
  const frames = [];
  const output = new EventEmitter();
  output.readyState = WebSocket.OPEN;
  output.send = (value) => frames.push(JSON.parse(String(value)));
  const forwarder = new NodeAgentInstanceEventForwarder({ listInstances: () => [] });
  forwarder.addOutput(output);
  forwarder.publish("instance.metrics.snapshot", { instanceId: "inst_1" }, { instanceId: "inst_1" });

  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "node-agent.event.forwarded");
  assert.equal(frames[0].event.type, "instance.metrics.snapshot");
  assert.equal(frames[0].event.topic, "instances");
  assert.equal(frames[0].event.scope.instanceId, "inst_1");
});
