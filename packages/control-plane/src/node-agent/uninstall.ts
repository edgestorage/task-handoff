import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { defaultNodeAgentDataDir } from "./persistence/paths.ts";

const NODE_AGENT_SERVICE = "task-handoff-node-agent.service";
const NODE_AGENT_UNIT_PATH = `/etc/systemd/system/${NODE_AGENT_SERVICE}`;
const NODE_AGENT_ENV_PATH = "/etc/task-handoff/node-agent.env";
const INSTALLED_PACKAGES = ["@task-handoff/node-agent", "@task-handoff/controlled-instance"];

type CommandResult = { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer };

export type NodeAgentUninstallOptions = {
  dataDir?: string;
  deleteData?: boolean;
  keepData?: boolean;
};

export type NodeAgentUninstallDependencies = {
  getuid: () => number | undefined;
  exists: (target: string) => boolean;
  readText: (target: string) => string;
  remove: (target: string, options: { recursive?: boolean; force?: boolean }) => void;
  run: (command: string, args: string[]) => CommandResult;
  confirmDeleteData: (dataDir: string) => Promise<boolean>;
  log: (message: string) => void;
};

function commandOutput(result: CommandResult) {
  return [result.stdout, result.stderr]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join("\n");
}

function runRequired(dependencies: NodeAgentUninstallDependencies, command: string, args: string[]) {
  const result = dependencies.run(command, args);
  if (result.status !== 0) {
    const output = commandOutput(result);
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
}

function valueFromEnvFile(contents: string, key: string) {
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== key) continue;
    return line.slice(separator + 1).trim();
  }
  return undefined;
}

export function installedNodeAgentDataDir(options: Pick<NodeAgentUninstallOptions, "dataDir">, dependencies: Pick<NodeAgentUninstallDependencies, "exists" | "readText">) {
  if (options.dataDir?.trim()) return path.resolve(options.dataDir.trim());
  if (dependencies.exists(NODE_AGENT_ENV_PATH)) {
    const configured = valueFromEnvFile(dependencies.readText(NODE_AGENT_ENV_PATH), "TASK_HANDOFF_NODE_AGENT_DATA_DIR");
    if (configured) return path.resolve(configured);
  }
  return path.resolve(defaultNodeAgentDataDir());
}

async function defaultConfirmDeleteData(dataDir: string) {
  if (!stdin.isTTY || !stdout.isTTY) {
    return false;
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      `Delete Node Agent data at ${dataDir}? This removes identity, configuration, logs, and managed-instance metadata. Docker volumes are preserved. [y/N] `,
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

const defaultDependencies: NodeAgentUninstallDependencies = {
  getuid: () => process.getuid?.(),
  exists: fs.existsSync,
  readText: (target) => fs.readFileSync(target, "utf8"),
  remove: (target, options) => fs.rmSync(target, options),
  run: (command, args) => spawnSync(command, args, { encoding: "utf8" }),
  confirmDeleteData: defaultConfirmDeleteData,
  log: (message) => console.log(message),
};

export async function uninstallNodeAgent(
  options: NodeAgentUninstallOptions,
  dependencies: NodeAgentUninstallDependencies = defaultDependencies,
) {
  if (options.deleteData && options.keepData) {
    throw new Error("--delete-data and --keep-data cannot be used together.");
  }
  if (dependencies.getuid() !== 0) {
    throw new Error("Run this command as root so the Node Agent service and packages can be removed.");
  }

  const envContents = dependencies.exists(NODE_AGENT_ENV_PATH)
    ? dependencies.readText(NODE_AGENT_ENV_PATH)
    : "";
  const dataDir = installedNodeAgentDataDir(options, {
    exists: (target) => target === NODE_AGENT_ENV_PATH && Boolean(envContents),
    readText: () => envContents,
  });
  if (dataDir === path.parse(dataDir).root) {
    throw new Error(`Refusing to use a filesystem root as the Node Agent data directory: ${dataDir}`);
  }
  const npmCommand = valueFromEnvFile(envContents, "TASK_HANDOFF_NPM_COMMAND")
    || process.env.TASK_HANDOFF_NPM_COMMAND
    || "npm";
  if (dependencies.exists(NODE_AGENT_UNIT_PATH)) {
    const unitContents = dependencies.readText(NODE_AGENT_UNIT_PATH);
    if (!/^ExecStart=\S*task-handoff-node-agent(?:\s|$)/m.test(unitContents)) {
      throw new Error(`Refusing to remove ${NODE_AGENT_SERVICE} because it is not owned by a standalone Node Agent installation.`);
    }
    runRequired(dependencies, "systemctl", ["disable", "--now", NODE_AGENT_SERVICE]);
    dependencies.remove(NODE_AGENT_UNIT_PATH, { force: true });
    runRequired(dependencies, "systemctl", ["daemon-reload"]);
  }

  runRequired(dependencies, npmCommand, ["uninstall", "--global", ...INSTALLED_PACKAGES]);
  dependencies.remove(NODE_AGENT_ENV_PATH, { force: true });
  dependencies.log("TaskHandoff Node Agent service and packages were removed.");

  const deleteData = options.deleteData
    ? true
    : options.keepData
      ? false
      : await dependencies.confirmDeleteData(dataDir);
  if (deleteData) {
    dependencies.remove(dataDir, { recursive: true, force: true });
    dependencies.log(`Node Agent data was deleted from ${dataDir}.`);
  } else {
    dependencies.log(`Node Agent data was preserved at ${dataDir}.`);
  }

  return { dataDir, dataDeleted: deleteData };
}
