import { Command, InvalidArgumentError, Option } from "commander";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { isExactSemanticVersion, updateChannelForVersion } from "./update-channel.mjs";

const packageRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
const npmCommand = process.env.TASK_HANDOFF_NPM_COMMAND || "npm";
const defaultUpdateChannel = updateChannelForVersion(manifest.version);

function run(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return String(result.stdout || "").trim();
}

function findGlobalPrefix() {
  let current = packageRoot;
  while (current !== path.dirname(current)) {
    if (path.basename(current) === "node_modules" && path.basename(path.dirname(current)) === "lib") {
      return path.dirname(path.dirname(current));
    }
    current = path.dirname(current);
  }
  throw new Error(`Cannot determine the npm global prefix from ${packageRoot}.`);
}

function parseEnvFile(file: string) {
  const values: Record<string, string> = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function serviceUser() {
  const unit = "/etc/systemd/system/task-handoff-node-agent.service";
  if (!fs.existsSync(unit)) return "root";
  return fs.readFileSync(unit, "utf8").match(/^User=(.+)$/m)?.[1] || "root";
}

function currentInstallOptions() {
  const controlPlane = parseEnvFile("/etc/task-handoff/control-plane.env");
  const nodeAgent = parseEnvFile("/etc/task-handoff/node-agent.env");
  return [
    "--service-user", serviceUser(),
    "--control-plane-data-dir", controlPlane.TASK_HANDOFF_CONTROL_PLANE_DATA_DIR || "/var/lib/task-handoff/control-plane",
    "--node-agent-data-dir", nodeAgent.TASK_HANDOFF_NODE_AGENT_DATA_DIR || "/var/lib/task-handoff/node-agent",
    "--control-plane-host", controlPlane.TASK_HANDOFF_CONTROL_PLANE_HOST || "0.0.0.0",
    "--control-plane-port", controlPlane.TASK_HANDOFF_CONTROL_PLANE_PORT || "8081",
    "--node-agent-host", nodeAgent.TASK_HANDOFF_NODE_AGENT_HOST || "127.0.0.1",
    "--node-agent-port", nodeAgent.TASK_HANDOFF_NODE_AGENT_PORT || "8091",
    "--node-agent-ipc-path", nodeAgent.TASK_HANDOFF_NODE_AGENT_IPC_PATH || "/run/task-handoff/node-agent.sock",
    "--auth-mode", controlPlane.TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE || "password",
  ];
}

function systemctlState(service: string) {
  const result = spawnSync("systemctl", ["is-active", service], { encoding: "utf8" });
  return String(result.stdout || "unknown").trim() || "unknown";
}

async function changeServerState(action: "start" | "stop" | "restart") {
  requireRoot();
  const installOptions = currentInstallOptions();
  const nodeSocket = installOptions[installOptions.indexOf("--node-agent-ipc-path") + 1];
  const controlPlanePort = Number(installOptions[installOptions.indexOf("--control-plane-port") + 1]);

  if (action === "stop") {
    run("systemctl", ["stop", "task-handoff-control-plane.service"], { stdio: "inherit" });
    run("systemctl", ["stop", "task-handoff-node-agent.service"], { stdio: "inherit" });
    console.log("Stopped TaskHandoff server services.");
    return;
  }

  run("systemctl", [action, "task-handoff-node-agent.service"], { stdio: "inherit" });
  waitForSocket(nodeSocket);
  run("systemctl", [action, "task-handoff-control-plane.service"], { stdio: "inherit" });
  await waitForHttp(controlPlanePort);
  console.log(`${action === "start" ? "Started" : "Restarted"} TaskHandoff server services.`);
}

function npmTarget(channel: string, exactVersion?: string) {
  return exactVersion || (channel === "stable" ? "latest" : channel);
}

function parseExactVersion(value: string) {
  if (!isExactSemanticVersion(value)) throw new InvalidArgumentError("must be an exact semantic version");
  return value;
}

function updateChannelOption() {
  return new Option("--channel <channel>", "stable, beta, or alpha")
    .choices(["stable", "beta", "alpha"])
    .default(defaultUpdateChannel)
    .conflicts("to");
}

function npmVersion(target: string, registry?: string) {
  const args = ["view", `@task-handoff/server@${target}`, "version", "--json"];
  if (registry) args.push("--registry", registry);
  const value = JSON.parse(run(npmCommand, args));
  if (typeof value !== "string") throw new Error(`npm target ${target} did not resolve to one version.`);
  return value;
}

function requireRoot() {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("Run this command as root so system packages and services can be changed.");
  }
}

function waitForSocket(socketPath: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(socketPath).isSocket()) return;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`Node agent socket was not ready after ${timeoutMs}ms: ${socketPath}`);
}

function waitForHttp(port: number, timeoutMs = 30_000) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const request = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1_000 }, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        retry();
      });
      request.on("timeout", () => request.destroy());
      request.on("error", retry);
    };
    const retry = () => Date.now() >= deadline
      ? reject(new Error(`Control plane was not healthy on port ${port} after ${timeoutMs}ms.`))
      : setTimeout(attempt, 250);
    attempt();
  });
}

function acquireLock() {
  const lock = "/run/task-handoff-server-update.lock";
  try {
    fs.mkdirSync(lock);
  } catch (error: any) {
    if (error?.code === "EEXIST") throw new Error("Another TaskHandoff server update is already running.");
    throw error;
  }
  return () => fs.rmSync(lock, { recursive: true, force: true });
}

function installArgs(options: Record<string, string | undefined>) {
  return [
    ["--service-user", options.serviceUser],
    ["--control-plane-data-dir", options.controlPlaneDataDir],
    ["--node-agent-data-dir", options.nodeAgentDataDir],
    ["--control-plane-host", options.controlPlaneHost],
    ["--control-plane-port", options.controlPlanePort],
    ["--node-agent-host", options.nodeAgentHost],
    ["--node-agent-port", options.nodeAgentPort],
    ["--node-agent-ipc-path", options.nodeAgentIpcPath],
    ["--auth-mode", options.authMode],
    ["--static-dir", options.staticDir],
  ].flatMap(([flag, value]) => value === undefined ? [] : [flag, value]);
}

async function main() {
  const program = new Command()
    .name("task-handoff")
    .description("Manage a TaskHandoff server and run its installed runtimes.")
    .version(manifest.version)
    .showSuggestionAfterError();

  program.command("control-plane", "Run the installed control-plane runtime.", {
    executableFile: "task-handoff-control-plane",
  });
  program.command("node-agent", "Run the installed node-agent runtime.", {
    executableFile: "task-handoff-node-agent",
  });
  program.command("controlled-instance", "Run the installed controlled-instance runtime.", {
    executableFile: "task-handoff-controlled-instance",
  });

  program.command("install")
    .description("Install or regenerate the server systemd services.")
    .option("--service-user <user>")
    .option("--control-plane-data-dir <path>")
    .option("--node-agent-data-dir <path>")
    .option("--control-plane-host <host>")
    .option("--control-plane-port <port>")
    .option("--node-agent-host <host>")
    .option("--node-agent-port <port>")
    .option("--node-agent-ipc-path <path>")
    .option("--auth-mode <mode>")
    .option("--static-dir <path>")
    .action((options) => {
      requireRoot();
      run(process.execPath, [path.join(packageRoot, "bin", "task-handoff-install-server"), ...installArgs(options)], { stdio: "inherit" });
    });

  program.command("status").description("Show the installed version and service state.").action(() => {
    console.log(`Package: @task-handoff/server ${manifest.version}`);
    console.log(`Node agent: ${systemctlState("task-handoff-node-agent.service")}`);
    console.log(`Control plane: ${systemctlState("task-handoff-control-plane.service")}`);
  });

  program.command("start")
    .description("Start the node agent and control plane services.")
    .action(() => changeServerState("start"));

  program.command("stop")
    .description("Stop the control plane and node agent services.")
    .action(() => changeServerState("stop"));

  program.command("restart")
    .description("Restart the node agent and control plane services safely.")
    .action(() => changeServerState("restart"));

  program.command("check")
    .description("Check npm for an available server version.")
    .addOption(updateChannelOption())
    .option("--registry <url>")
    .action((options) => {
      const target = npmTarget(options.channel);
      const available = npmVersion(target, options.registry);
      console.log(`Installed: ${manifest.version}`);
      console.log(`Available (${options.channel} channel, npm ${target}): ${available}`);
      console.log(available === manifest.version ? "Up to date." : `Update available: task-handoff update --to ${available}`);
    });

  program.command("update")
    .description("Update the server package set and restart services safely.")
    .addOption(updateChannelOption())
    .option("--to <version>", "exact semantic version", parseExactVersion)
    .option("--registry <url>")
    .option("--force")
    .action(async (options) => {
      requireRoot();
      const target = npmTarget(options.channel, options.to);
      const targetVersion = target === manifest.version ? manifest.version : npmVersion(target, options.registry);
      if (targetVersion === manifest.version && !options.force) {
        console.log(`@task-handoff/server ${manifest.version} is already installed.`);
        return;
      }
      const releaseLock = acquireLock();
      try {
        const prefix = findGlobalPrefix();
        const preserved = currentInstallOptions();
        const nodeSocket = preserved[preserved.indexOf("--node-agent-ipc-path") + 1];
        const controlPlanePort = Number(preserved[preserved.indexOf("--control-plane-port") + 1]);
        const npmArgs = ["install", "--global", "--prefix", prefix, `@task-handoff/server@${targetVersion}`];
        if (options.registry) npmArgs.push("--registry", options.registry);
        console.log(`Updating @task-handoff/server ${manifest.version} -> ${targetVersion}`);
        run(npmCommand, npmArgs, { stdio: "inherit" });
        run(path.join(prefix, "bin", "task-handoff"), ["install", ...preserved], { stdio: "inherit" });
        run("systemctl", ["restart", "task-handoff-node-agent.service"]);
        waitForSocket(nodeSocket);
        run("systemctl", ["restart", "task-handoff-control-plane.service"]);
        await waitForHttp(controlPlanePort);
        console.log(`Updated TaskHandoff server to ${targetVersion}.`);
      } catch (error) {
        console.error(`Update failed. To reinstall the previous version, run: npm install -g @task-handoff/server@${manifest.version}`);
        throw error;
      } finally {
        releaseLock();
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
