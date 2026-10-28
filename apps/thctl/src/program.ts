import { Command, CommanderError } from "commander";
import { CliProfileStore, resolveCliConfigDir } from "./config.ts";
import type { CliEventSocketFactory } from "./event-socket.ts";
import { CLI_GROUPS, type CliLeaf } from "./contracts.ts";
import { CLI_EXIT_CODES, ThctlError, notImplementedError, toThctlError, usageError } from "./errors.ts";
import { THCTL_VERSION } from "./client-info.ts";
import { openInBrowser } from "./login.ts";
import { CLI_GLOBAL_OPTIONS } from "./global-options.ts";
import { CliOutput, defaultStreams, type CliStreams } from "./output.ts";
import type { CliResult } from "./runtime.ts";
import { promptConfirm, type CliContext } from "./runtime.ts";
import {
  UPDATE_CHECK_CHILD_ARG,
  maybeScheduleUpdateCheck,
  pendingUpdateNotice,
  runUpdateCheckChild,
} from "./update-check.ts";

function addGlobalOptions(command: Command) {
  for (const option of CLI_GLOBAL_OPTIONS) command.option(option.flags, option.description);
  return command;
}

/** 解析失败时叶子还没执行，先按原始参数选择错误输出的格式。 */
function requestedTableOutput(argv: readonly string[]) {
  for (const arg of argv.slice(2)) {
    if (arg === "--") break;
    if (arg === "--table") return true;
  }
  return false;
}

/** commander 的 repeatable 选项需要显式 collector，否则只保留最后一次取值。 */
function collectRepeatable(value: string, previous: string[] = []) {
  return [...previous, value];
}

function leafCommandName(leaf: CliLeaf) {
  const segments = leaf.name.split(" ");
  const leafSegment = segments.at(-1) as string;
  const args = (leaf.args ?? []).map((arg) => {
    if (arg.variadic) return arg.required ? `<${arg.name}...>` : `[${arg.name}...]`;
    return arg.required ? `<${arg.name}>` : `[${arg.name}]`;
  });
  return [leafSegment, ...args].join(" ");
}

function leafDescription(leaf: CliLeaf) {
  return leaf.handler ? leaf.summary : `${leaf.summary} (not implemented — planned stage ${leaf.stage})`;
}

function resolveNestedParent(root: Command, leaf: CliLeaf) {
  const segments = leaf.name.split(" ");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    const existing = parent.commands.find((command) => command.name() === segment);
    parent = existing ?? parent.command(segment).description(`${leaf.group} ${segment} commands`);
  }
  return parent;
}

/**
 * commander 会把长选项归一成 camelCase（`--request-id` → `requestId`），
 * 而 CLI 契约、schema 与命令层统一按 kebab-case 读取；这里在解析边界统一键名。
 */
function normalizeParsedOptions(options: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    normalized[key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)] = value;
  }
  return normalized;
}

async function executeLeaf(leaf: CliLeaf, context: CliContext, command: Command) {
  const args: Record<string, string | undefined> = {};
  (leaf.args ?? []).forEach((arg, index) => {
    const value = command.args[index];
    args[arg.name] = arg.variadic ? (command.args.slice(index).join(" ") || undefined) : value;
  });
  const options = normalizeParsedOptions(command.optsWithGlobals() as Record<string, unknown>);
  // JSON 是脚本优先的默认格式；--table 显式切回人读表格。--json 保留为兼容别名。
  context.output.json = options.table !== true;
  if (options.table === true && options.json === true) {
    throw usageError("CLI_OUTPUT_FORMAT_CONFLICT", "`--json` and `--table` cannot be used together.");
  }
  const invocationContext: CliContext = {
    ...context,
    profile: typeof options.profile === "string" ? options.profile : context.profile,
    yes: options.yes === true,
    dryRun: options["dry-run"] === true,
  };
  if (!leaf.handler) throw notImplementedError(leaf.id, leaf.stage);
  let result: CliResult | void;
  try {
    result = await leaf.handler(invocationContext, { args, options, rawArgs: command.args });
  } catch (error) {
    // 未注册路由归一为能力缺失，并补上命令上下文，方便脚本按域降级。
    if (error instanceof ThctlError && error.code === "CLI_ROUTE_MISSING") {
      throw new ThctlError(
        "CLI_CAPABILITY_MISSING",
        `${error.message} \`${leaf.id}\` is unavailable on this server version.`,
        error.exitCode,
        { ...error.details, command: leaf.id },
      );
    }
    throw error;
  }
  if (!result) return;
  if (result.data !== undefined) invocationContext.output.data(result.data, result.columns);
  if (result.message) invocationContext.output.message(result.message);
}

export function buildProgram(context: CliContext) {
  const program = new Command();
  program
    .name("thctl")
    .description("TaskHandoff Control Plane command line client.")
    .version(THCTL_VERSION, "--version", "Print the CLI version")
    .exitOverride()
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .configureOutput({
      writeOut: (text) => context.output.streams.stdout(text),
      // runCli catches CommanderError and renders it once in the selected output mode.
      writeErr: () => {},
    });
  addGlobalOptions(program);
  program.configureHelp({ sortSubcommands: false });

  for (const group of CLI_GROUPS) {
    const parent = group.flat
      ? program
      : program.command(group.name).description(group.summary);
    for (const leaf of group.leaves) {
      const command = resolveNestedParent(parent, leaf)
        .command(leafCommandName(leaf))
        .description(leafDescription(leaf));
      addGlobalOptions(command);
      for (const option of leaf.options ?? []) {
        if (option.repeatable) command.option(option.flags, option.description, collectRepeatable, []);
        else command.option(option.flags, option.description);
      }
      command.action(async () => {
        await executeLeaf(leaf, context, command);
      });
    }
  }
  return program;
}

export type RunCliOptions = {
  streams?: CliStreams;
  env?: Record<string, string | undefined>;
  store?: CliProfileStore;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  confirm?: (question: string) => Promise<boolean>;
  isTty?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
  createEventSocket?: CliEventSocketFactory;
  /**
   * 后台更新检查：打包后的 CLI 入口（bin.ts）显式开启；库调用和测试默认关闭。
   * spawnDetached/now 供测试注入派生进程与时钟。
   */
  updateCheck?: {
    enabled?: boolean;
    spawnDetached?: (execPath: string, args: string[]) => void;
    now?: () => number;
  };
};

export function createRuntimeContext(options: RunCliOptions = {}): CliContext {
  const env = options.env ?? process.env;
  const streams = options.streams ?? defaultStreams();
  return {
    store: options.store ?? new CliProfileStore(resolveCliConfigDir(env)),
    output: new CliOutput(streams, true),
    fetchImpl: options.fetchImpl ?? fetch,
    env,
    yes: false,
    dryRun: false,
    isTty: options.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: options.confirm ?? promptConfirm,
    openUrl: options.openUrl ?? openInBrowser,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    signal: options.signal ?? new AbortController().signal,
    ...(options.createEventSocket ? { createEventSocket: options.createEventSocket } : {}),
  };
}

export async function runCli(argv: string[], options: RunCliOptions = {}) {
  const context = createRuntimeContext(options);
  context.output.json = !requestedTableOutput(argv);
  // 隐藏子进程入口：只刷新更新检查状态，不解析命令、不产生输出。
  if (argv[2] === UPDATE_CHECK_CHILD_ARG) {
    await runUpdateCheckChild(context);
    return CLI_EXIT_CODES.ok;
  }
  const updateCheck = options.updateCheck ?? {};
  const updateCheckEnabled = updateCheck.enabled === true;
  const controller = new AbortController();
  const onSignal = () => {
    controller.abort();
    context.output.warn("Cancelling…");
  };
  // 注入的 signal 同时驱动命令（如 events 的流式订阅），进程信号仍走内部 controller。
  const externalSignal = options.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    // 先派生后台检查（结果落盘），本次运行只用上一次的缓存状态提示。
    if (updateCheckEnabled) {
      maybeScheduleUpdateCheck(context, {
        argv,
        ...(updateCheck.spawnDetached ? { spawnDetached: updateCheck.spawnDetached } : {}),
        ...(updateCheck.now ? { now: updateCheck.now() } : {}),
      });
    }
    const program = buildProgram({ ...context, signal: controller.signal });
    await program.parseAsync(argv);
    return CLI_EXIT_CODES.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.help" || error.code === "commander.version") return CLI_EXIT_CODES.ok;
      const mapped = new ThctlError("CLI_USAGE_ERROR", error.message, CLI_EXIT_CODES.usage);
      context.output.error(mapped);
      return mapped.exitCode;
    }
    const mapped = toThctlError(error);
    context.output.error(mapped);
    return mapped.exitCode;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (updateCheckEnabled) {
      const notice = pendingUpdateNotice(context, {
        argv,
        ...(updateCheck.now ? { now: updateCheck.now() } : {}),
      });
      if (notice) context.output.warn(notice);
    }
  }
}
