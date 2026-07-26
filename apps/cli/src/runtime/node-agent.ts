import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import {
  defaultNodeAgentDataDir,
  fetchNodeAgentIpc,
  nodeAgentIpcPath,
  runNodeAgentServer,
} from "@task-handoff/control-plane/node-agent";

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

function parsePositiveInteger(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Expiry must be a positive integer.");
  }
  return parsed;
}

async function createPairingInvite(options: {
  endpoint?: string;
  ipcPath?: string;
  token?: string;
  expiresInMs?: number;
}) {
  const headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const body = JSON.stringify({
    ...(options.expiresInMs ? { expiresInMs: options.expiresInMs } : {}),
  });
  const response = options.endpoint
    ? await fetch(`${options.endpoint.replace(/\/$/, "")}/api/node-agent/pairing/invites`, { method: "POST", headers, body })
    : await fetchNodeAgentIpc(options.ipcPath!, "/pairing/invites", { method: "POST", headers, body });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { nodeId?: unknown; joinToken?: unknown; expiresAt?: unknown };
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || `Node agent pairing invite failed with HTTP ${response.status}`);
  }
  const joinToken = typeof payload.data?.joinToken === "string" ? payload.data.joinToken : "";
  if (!joinToken) {
    throw new Error("Node agent pairing invite response did not include a join token.");
  }
  return {
    nodeId: typeof payload.data?.nodeId === "string" ? payload.data.nodeId : "",
    joinToken,
    expiresAt: typeof payload.data?.expiresAt === "string" ? payload.data.expiresAt : "",
  };
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

  program
    .command("invite")
    .description("Create a one-time token for pairing this node agent with a control plane.")
    .option("--endpoint <url>", "Use the node-agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local node-agent IPC socket path")
    .option("--data-dir <path>", "Node-agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local node-agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--expires-in-ms <ms>", "Invite expiry in milliseconds", parsePositiveInteger)
    .option("--json", "Print raw JSON output")
    .action(async (options) => {
      const rootOptions = program.opts();
      const explicitIpcPath = options.ipcPath || rootOptions.ipcPath
        || process.env.TASK_HANDOFF_NODE_AGENT_IPC_PATH;
      const dataDir = options.dataDir || rootOptions.dataDir
        || process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR;
      const ipcPath = options.endpoint
        ? undefined
        : explicitIpcPath || nodeAgentIpcPath(dataDir || defaultNodeAgentDataDir());
      const invite = await createPairingInvite({
        endpoint: options.endpoint,
        ipcPath,
        token: options.token,
        expiresInMs: options.expiresInMs,
      });
      if (options.json) {
        console.log(JSON.stringify(invite, null, 2));
        return;
      }
      if (invite.nodeId) console.log(`Node: ${invite.nodeId}`);
      console.log(`Join token: ${invite.joinToken}`);
      if (invite.expiresAt) console.log(`Expires: ${invite.expiresAt}`);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
