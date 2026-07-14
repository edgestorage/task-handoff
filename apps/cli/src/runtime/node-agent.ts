import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { runNodeAgentServer } from "@task-handoff/control-plane/node-agent";

function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Port must be a valid TCP port.");
  }
  return port;
}

function parseConnectionMode(value: string) {
  if (value !== "local-ipc" && value !== "local-loopback") {
    throw new Error("Connection mode must be local-ipc or local-loopback.");
  }
  return value;
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  const program = new Command();
  program
    .name("task-handoff-node-agent")
    .description("Run a TaskHandoff node agent.")
    .version(packageVersion())
    .option("--host <host>", "Node agent host", process.env.TASK_HANDOFF_NODE_AGENT_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Node agent port", parsePort, Number(process.env.TASK_HANDOFF_NODE_AGENT_PORT) || 8091)
    .option("--data-dir <path>", "Node agent data directory")
    .option("--token <token>", "Bearer token required by the control plane")
    .option("--connection-mode <mode>", "Local control connection mode", parseConnectionMode)
    .option("--ipc-path <path>", "Unix socket path used by local-ipc mode")
    .option("--control-plane-tunnel-url <url>", "Control plane reverse WebSocket tunnel URL")
    .action(async (options) => {
      await runNodeAgentServer({
        host: options.host,
        port: options.port,
        dataDir: options.dataDir,
        token: options.token,
        connectionMode: options.connectionMode,
        ipcPath: options.ipcPath,
        controlPlaneTunnelUrl: options.controlPlaneTunnelUrl,
      });
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
