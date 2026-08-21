import { Command } from "commander";
import path from "node:path";
import { resolvePackageVersion } from "@task-handoff/core/core/package-version";
import {
  initializeControlPlaneCredentials,
  replaceControlPlaneCredentials,
  runControlPlaneServer,
} from "@task-handoff/control-plane/server";

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

async function main() {
  const program = new Command();
  program
    .name("task-handoff-control-plane")
    .description("Run the TaskHandoff control plane.")
    .version(resolvePackageVersion("@task-handoff/cli"))
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

  program
    .command("credentials")
    .description("Initialize or replace Control Plane administrator credentials while the service is stopped.")
    .requiredOption("--username <username>", "New administrator username")
    .requiredOption("--password-stdin", "Read the new password from standard input")
    .option("--initialize-if-needed", "Create the administrator only when none exists")
    .option("--data-dir <path>", "Control plane data directory")
    .action(async (options: { username: string; passwordStdin: boolean; initializeIfNeeded?: boolean; dataDir?: string }) => {
      if (process.stdin.isTTY) {
        throw new Error("Pipe the new password to standard input when using --password-stdin.");
      }
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
      if (options.initializeIfNeeded) {
        const result = await initializeControlPlaneCredentials(options.dataDir, {
          username: options.username,
          password,
        });
        console.log(result.created ? "created" : "unchanged");
        return;
      }
      const user = await replaceControlPlaneCredentials(options.dataDir, {
        username: options.username,
        password,
      });
      console.log(`Updated Control Plane credentials for ${user.username}. Existing sessions were revoked.`);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
