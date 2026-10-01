import readline from "node:readline/promises";
import { CliProfileStore, type CliProfile } from "./config.ts";
import { connectToControlPlane, type ThctlConnection } from "./control-plane.ts";
import { ThctlError, CLI_EXIT_CODES } from "./errors.ts";
import type { CliEventSocketFactory } from "./event-socket.ts";
import type { CliOutput } from "./output.ts";

export type CliContext = {
  store: CliProfileStore;
  output: CliOutput;
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  profile?: string;
  yes: boolean;
  dryRun: boolean;
  isTty: boolean;
  confirm: (question: string) => Promise<boolean>;
  openUrl: (url: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal;
  /** 事件流命令的 WebSocket 工厂；未注入时使用 `ws` 默认实现。 */
  createEventSocket?: CliEventSocketFactory;
};

export type CliInvocation = {
  args: Record<string, string | undefined>;
  options: Record<string, unknown>;
  /** 未按空格合并的原始位置参数，variadic 叶子命令用它保留每个参数的边界。 */
  rawArgs?: readonly string[];
};

export type CliResult = {
  data?: unknown;
  columns?: readonly { key: string; header: string; width?: number }[];
  message?: string;
};

export type CliHandler = (context: CliContext, invocation: CliInvocation) => Promise<CliResult | void>;

export async function promptConfirm(question: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function resolveProfile(context: CliContext, label?: string) {
  return context.store.select(label ?? context.profile, context.env);
}

export function persistProfileSnapshot(store: CliProfileStore, profile: CliProfile) {
  const current = store.get(profile.label);
  if (current && current.updatedAt === profile.updatedAt) return profile;
  return store.save(profile);
}

export async function openConnection(context: CliContext, options: { profile?: CliProfile; withSession?: boolean } = {}): Promise<ThctlConnection> {
  const profile = options.profile ?? resolveProfile(context);
  const connection = await connectToControlPlane({
    store: context.store,
    profile,
    fetchImpl: context.fetchImpl,
    ...(options.withSession === undefined ? {} : { withSession: options.withSession }),
  });
  persistProfileSnapshot(context.store, connection.profile);
  if (options.withSession !== false) {
    await renewSessionWhenExpiring(context, connection);
  }
  return connection;
}

/** 会话剩余有效期小于 7 天时续期；服务端只在窗口内延长，其他失败不阻断读命令。 */
const SESSION_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function renewSessionWhenExpiring(context: CliContext, connection: ThctlConnection) {
  const secrets = context.store.secrets();
  const credential = secrets.read(connection.profile.label);
  if (!credential?.expiresAt) return;
  const remaining = Date.parse(credential.expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining > SESSION_RENEWAL_WINDOW_MS) return;
  const renewal = await connection.client.auth.renewCliSession();
  secrets.write(connection.profile.label, { ...credential, expiresAt: renewal.expiresAt, savedAt: new Date().toISOString() });
}

function missingConfirmation(commandId: string) {
  return new ThctlError(
    "CLI_CONFIRMATION_REQUIRED",
    `\`${commandId}\` changes remote state. Re-run with --yes to confirm, or --dry-run to preview the request.`,
    CLI_EXIT_CODES.confirmationRequired,
    { command: commandId },
  );
}

export async function requireConfirmation(context: CliContext, commandId: string, question: string) {
  if (context.yes) return true;
  if (!context.isTty) throw missingConfirmation(commandId);
  const confirmed = await context.confirm(question);
  if (!confirmed) throw new ThctlError("CLI_CANCELLED", "The operation was cancelled.", CLI_EXIT_CODES.cancelled);
  return true;
}

export type WriteStep = {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
};

export type WriteDescriptor = WriteStep & {
  /** 多步写操作按顺序列出全部请求；单步写操作只用 method/path/body。 */
  steps?: readonly WriteStep[];
};

/** 把多步写操作组装成描述符，dry-run 时逐步输出将要发送的请求。 */
export function writeSteps(steps: readonly [WriteStep, ...WriteStep[]]): WriteDescriptor {
  return { ...steps[0], steps };
}

/**
 * 写操作统一门控：--dry-run 只输出将要发送的请求，--yes 跳过确认，
 * 非 TTY 且没有 --yes 时在发送任何请求前失败。
 */
export async function performWrite<T>(
  context: CliContext,
  commandId: string,
  descriptor: () => WriteDescriptor,
  execute: () => Promise<T>,
): Promise<T> {
  const request = descriptor();
  const steps = request.steps ?? [request];
  if (context.dryRun) {
    context.output.data(steps.length === 1
      ? {
        dryRun: true,
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
      }
      : {
        dryRun: true,
        steps: steps.map((step) => ({ method: step.method, path: step.path, ...(step.body === undefined ? {} : { body: step.body }) })),
      });
    return undefined as T;
  }
  await requireConfirmation(context, commandId, steps.length === 1
    ? `${request.method} ${request.path} — continue?`
    : `${steps.length} requests will be sent (${steps.map((step) => `${step.method} ${step.path}`).join(", ")}) — continue?`);
  return execute();
}

export function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw new ThctlError("CLI_CANCELLED", "The operation was cancelled.", CLI_EXIT_CODES.cancelled);
}
