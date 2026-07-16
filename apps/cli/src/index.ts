import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { runWebServer } from "@task-handoff/controlled-instance/web/server";
import { runControlPlaneServer } from "@task-handoff/control-plane/server";
import { runNodeAgentServer } from "@task-handoff/control-plane/node-agent";

function box(title: string, lines: string[]) {
  const width = Math.max(title.length + 4, ...lines.map((line) => line.length + 4));
  const top = `╭${"─".repeat(width - 2)}╮`;
  const heading = `│ ${title}${" ".repeat(width - title.length - 3)}│`;
  const separator = `├${"─".repeat(width - 2)}┤`;
  const body = lines.map((line) => `│ ${line}${" ".repeat(width - line.length - 3)}│`);
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  return [top, heading, separator, ...body, bottom].join("\n");
}

function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Port must be a valid TCP port.");
  }
  return port;
}

function parseAuthMode(value: string) {
  if (value !== "disabled" && value !== "password") {
    throw new Error("Auth mode must be disabled or password.");
  }
  return value;
}

function parseNodeAgentConnectionMode(value: string) {
  if (value !== "local-ipc" && value !== "local-loopback") {
    throw new Error("Node agent connection mode must be local-ipc or local-loopback.");
  }
  return value;
}

function defaultNodeAgentEndpoint() {
  const host = process.env.TASK_HANDOFF_NODE_AGENT_HOST || "127.0.0.1";
  const port = Number(process.env.TASK_HANDOFF_NODE_AGENT_PORT) || 8091;
  return process.env.TASK_HANDOFF_NODE_AGENT_ENDPOINT || `http://${host}:${port}`;
}

async function createNodeAgentPairingInvite(options: { endpoint: string; token?: string; expiresInMs?: number }) {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const response = await fetch(`${endpoint}/api/node-agent/pairing/invites`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({
      ...(options.expiresInMs ? { expiresInMs: options.expiresInMs } : {}),
    }),
  });
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

function showDetailedHelp(program: Command) {
  console.log(
    box("task-handoff", [
      "Run and manage TaskHandoff server components.",
      "",
      "Common commands:",
      "  task-handoff control-plane",
      "  task-handoff node-agent",
      "  task-handoff node-agent-invite",
      "  task-handoff web",
    ]),
  );
  console.log("");
  program.helpInformation().trimEnd().split("\n").forEach((line) => console.log(line));
}

function normalizeLegacyArgs(argv: string[]) {
  if (argv[2] === undefined) {
    argv.push("help");
  }
}

async function main() {
  const program = new Command();
  let packageVersion = "unknown";
  try {
    packageVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version || packageVersion;
  } catch {
    // Keep the CLI usable when package metadata is unavailable.
  }

  program
    .name("task-handoff")
    .description("Run and manage TaskHandoff server components.")
    .version(packageVersion)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ task-handoff control-plane",
        "  $ task-handoff node-agent",
        "  $ task-handoff node-agent-invite",
        "  $ task-handoff web",
        "  $ task-handoff help",
      ].join("\n"),
    );

  program
    .command("control-plane")
    .description("Run the TaskHandoff control plane server.")
    .option("--host <host>", "Control plane host", process.env.TASK_HANDOFF_CONTROL_PLANE_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Control plane port", parsePort, Number(process.env.TASK_HANDOFF_CONTROL_PLANE_PORT) || 8081)
    .option("--data-dir <path>", "Control plane data directory")
    .option("--static-dir <path>", "Control plane Web UI static directory")
    .option("--auth-mode <mode>", "Control plane auth mode: disabled or password", parseAuthMode, process.env.TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE || "password")
    .action(async (options) => {
      await runControlPlaneServer({
        host: options.host,
        port: options.port,
        dataDir: options.dataDir,
        staticDir: options.staticDir,
        auth: { mode: options.authMode },
      });
    });

  program
    .command("node-agent")
    .description("Run a node agent that executes controlled instances on this host.")
    .option("--host <host>", "Node agent host", process.env.TASK_HANDOFF_NODE_AGENT_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Node agent port", parsePort, Number(process.env.TASK_HANDOFF_NODE_AGENT_PORT) || 8091)
    .option("--data-dir <path>", "Node agent data directory")
    .option("--token <token>", "Bearer token required by the control plane")
    .option("--connection-mode <mode>", "Local control connection mode: local-ipc or local-loopback", parseNodeAgentConnectionMode)
    .option("--ipc-path <path>", "Unix socket path used when connection mode is local-ipc")
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
    .command("node-agent-invite")
    .description("Create a one-time join token from a node agent.")
    .option("--endpoint <url>", "Node agent endpoint", defaultNodeAgentEndpoint())
    .option("--token <token>", "Bearer token for local node-agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--expires-in-ms <ms>", "Invite expiry in milliseconds", (value) => {
      const ms = Number(value);
      if (!Number.isInteger(ms) || ms <= 0) {
        throw new Error("Expiry must be a positive integer.");
      }
      return ms;
    })
    .option("--json", "Print raw JSON output")
    .action(async (options) => {
      const invite = await createNodeAgentPairingInvite({
        endpoint: options.endpoint,
        token: options.token,
        expiresInMs: options.expiresInMs,
      });
      if (options.json) {
        console.log(JSON.stringify(invite, null, 2));
        return;
      }
      if (invite.nodeId) {
        console.log(`Node: ${invite.nodeId}`);
      }
      console.log(`Join token: ${invite.joinToken}`);
      if (invite.expiresAt) {
        console.log(`Expires: ${invite.expiresAt}`);
      }
    });

  program
    .command("web")
    .description("Run the TaskHandoff web server.")
    .option("--host <host>", "Web server host", process.env.TASK_HANDOFF_WEB_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Web server port", parsePort, Number(process.env.TASK_HANDOFF_WEB_PORT) || 8080)
    .option("--static-dir <path>", "Web UI static directory")
    .action(async (options) => {
      await runWebServer({
        host: options.host,
        port: options.port,
        staticDir: options.staticDir,
      });
    });

  program
    .command("help")
    .description("Show detailed help.")
    .action(() => {
      showDetailedHelp(program);
    });

  normalizeLegacyArgs(process.argv);
  await program.parseAsync(process.argv);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
