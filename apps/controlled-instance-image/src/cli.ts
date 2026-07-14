import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { runWebServer } from "@task-handoff/controlled-instance/web/server";

function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Port must be a valid TCP port.");
  }
  return port;
}

function normalizeArgs(argv: string[]) {
  if (argv[2] === undefined) {
    argv.push("web");
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  process.env.TASK_HANDOFF_CLI_PATH ||= __filename;
  const program = new Command();

  program.name("task-handoff-controlled-instance").description("Run a TaskHandoff controlled instance.").version(packageVersion());

  program
    .command("web")
    .description("Run the controlled instance web server.")
    .option("--host <host>", "Web server host", process.env.TASK_HANDOFF_WEB_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Web server port", parsePort, Number(process.env.TASK_HANDOFF_WEB_PORT) || 8080)
    .option(
      "--static-dir <path>",
      "Web UI static directory",
      process.env.TASK_HANDOFF_WEB_STATIC_DIR || path.resolve(__dirname, "..", "ui"),
    )
    .action(async (options) => {
      await runWebServer({
        host: options.host,
        port: options.port,
        staticDir: options.staticDir,
      });
    });

  normalizeArgs(process.argv);
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
