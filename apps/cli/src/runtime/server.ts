import { Command, InvalidArgumentError, Option } from "commander";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { isExactSemanticVersion, updateChannelForVersion } from "./update-channel.mjs";
import {
  currentServerInstallArgs,
  globalPrefixFromModulePath,
} from "@task-handoff/core/core/server-update-installation";

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
  const prefix = globalPrefixFromModulePath(packageRoot);
  if (prefix) return prefix;
  throw new Error(`Cannot determine the npm global prefix from ${packageRoot}.`);
}

function currentInstallOptions() {
  return currentServerInstallArgs();
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

function npmIntegrity(version: string, registry?: string) {
  const args = ["view", `@task-handoff/server@${version}`, "dist.integrity", "--json"];
  if (registry) args.push("--registry", registry);
  const value = JSON.parse(run(npmCommand, args));
  if (typeof value !== "string" || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(value)) {
    throw new Error(`npm did not return immutable integrity metadata for @task-handoff/server@${version}.`);
  }
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
    .option("--preserve-current", "Reuse the installed service configuration")
    .option("--materialize-only", "Rewrite service configuration without starting services")
    .action((options) => {
      requireRoot();
      run(process.execPath, [
        path.join(packageRoot, "bin", "task-handoff-install-server"),
        ...(options.preserveCurrent ? currentInstallOptions() : []),
        ...installArgs(options),
        ...(options.materializeOnly ? ["--materialize-only"] : []),
      ], { stdio: "inherit" });
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
      const prefix = findGlobalPrefix();
      const preserved = currentInstallOptions();
      const nodeSocket = preserved[preserved.indexOf("--node-agent-ipc-path") + 1];
      const controlPlanePort = Number(preserved[preserved.indexOf("--control-plane-port") + 1]);
      const integrity = npmIntegrity(targetVersion, options.registry);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-server-update-"));
      const jobFile = path.join(directory, "job.json");
      const timestamp = new Date().toISOString();
      fs.writeFileSync(jobFile, `${JSON.stringify({
        id: `update_cli_${process.pid}_${Date.now()}`,
        nodeId: "node_cli_server",
        source: "npm",
        channel: options.channel || updateChannelForVersion(targetVersion),
        fromVersion: manifest.version,
        toVersion: targetVersion,
        artifactRef: `npm:@task-handoff/server@${targetVersion}#${integrity}`,
        runtimeArtifacts: [],
        impact: {
          runningInstanceCount: 0,
          stoppedInstanceCount: 0,
          activeInstanceCount: 0,
          restartInstanceCount: 0,
          runningInstanceIds: [],
          stoppedInstanceIds: [],
          activeInstanceIds: [],
        },
        rollout: {
          phase: "queued",
          desiredVersion: targetVersion,
          expectedInstanceIds: [],
          expectedInstanceCount: 0,
          matchedInstanceCount: 0,
          pendingInstanceCount: 0,
          failedInstanceCount: 0,
          deferredInstanceCount: 0,
        },
        status: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
      }, null, 2)}\n`);
      try {
        console.log(`Updating @task-handoff/server ${manifest.version} -> ${targetVersion}`);
        run(path.join(packageRoot, "bin", "task-handoff-node-update-worker"), [
          "--job-file", jobFile,
          "--target-version", targetVersion,
          "--npm-command", npmCommand,
          "--install-prefix", prefix,
          "--node-agent-ipc-path", nodeSocket,
          "--control-plane-health-url", `http://127.0.0.1:${controlPlanePort}/api/health`,
          ...(options.registry ? ["--registry", options.registry] : []),
          "--standalone",
        ], { stdio: "inherit" });
        const completed = JSON.parse(fs.readFileSync(jobFile, "utf8"));
        if (completed.status !== "succeeded") throw new Error(completed.error?.message || `Update finished with status ${completed.status}.`);
        console.log(`Updated TaskHandoff server to ${targetVersion}.`);
      } catch (error) {
        console.error(`Update failed. The updater attempted to restore @task-handoff/server ${manifest.version}.`);
        throw error;
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
