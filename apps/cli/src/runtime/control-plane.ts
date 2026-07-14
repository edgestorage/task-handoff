import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { runControlPlaneServer } from "@task-handoff/control-plane/server";

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
    .name("task-handoff-control-plane")
    .description("Run the TaskHandoff control plane.")
    .version(packageVersion())
    .option("--host <host>", "Control plane host", process.env.TASK_HANDOFF_CONTROL_PLANE_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Control plane port", parsePort, Number(process.env.TASK_HANDOFF_CONTROL_PLANE_PORT) || 8081)
    .option("--data-dir <path>", "Control plane data directory")
    .option(
      "--static-dir <path>",
      "Control plane Web UI static directory",
      process.env.TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR || path.resolve(__dirname, "..", "ui"),
    )
    .option(
      "--auth-mode <mode>",
      "Control plane auth mode: disabled or password",
      parseAuthMode,
      process.env.TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE || "password",
    )
    .action(async (options) => {
      await runControlPlaneServer({
        host: options.host,
        port: options.port,
        dataDir: options.dataDir,
        staticDir: options.staticDir,
        auth: { mode: options.authMode },
      });
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
