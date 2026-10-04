import readline from "node:readline/promises";
import { CLI_PROFILE_ENV, CliProfileStore, type CliProfile } from "./config.ts";
import { connectToControlPlane, type ThctlConnection } from "./control-plane.ts";
import { ThctlError, CLI_EXIT_CODES } from "./errors.ts";
import type { CliEventSocketFactory } from "./event-socket.ts";
import { discoverLocalControlPlane, ensureLocalProfile, localControlPlaneLockPath } from "./local-control-plane.ts";
import type { CliOutput } from "./output.ts";
import { redactSecrets, registerSecretsFromValue } from "./redact.ts";

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

/**
 * 选择生效 profile：显式 label/环境变量 > 已配置 profile 的选择规则；
 * 完全没有 profile 时尝试检测本机控制面板并写入受管 `local` profile。
 */
export async function resolveProfile(context: CliContext, label?: string): Promise<CliProfile> {
  const requested = (label ?? context.profile)?.trim() || context.env[CLI_PROFILE_ENV]?.trim();
  if (requested) return context.store.select(requested, context.env);
  if (context.store.list().length > 0) return context.store.select(undefined, context.env);
  const discovery = await discoverLocalControlPlane({ env: context.env, fetchImpl: context.fetchImpl });
  if (discovery) return ensureLocalProfile(context.store, discovery);
  throw new ThctlError(
    "CLI_PROFILE_MISSING",
    `No Control Plane profile configured and no local Control Plane was detected (lock: ${localControlPlaneLockPath(context.env)}). Start the desktop Control Plane or run \`thctl profile add <origin>\`.`,
    CLI_EXIT_CODES.notFound,
  );
}

export function persistProfileSnapshot(store: CliProfileStore, profile: CliProfile) {
  const current = store.get(profile.label);
  if (current && current.updatedAt === profile.updatedAt) return profile;
  return store.save(profile);
}

export async function openConnection(context: CliContext, options: { profile?: CliProfile; withSession?: boolean } = {}): Promise<ThctlConnection> {
  let profile = options.profile ?? await resolveProfile(context);
  let connection: ThctlConnection;
  try {
    connection = await connectProfile(context, profile, options.withSession);
  } catch (error) {
    // 桌面控制面板换了端口时受管 profile 会失效：重新发现并收敛，其余错误原样抛出。
    const rebound = await rebindManagedLocalProfile(context, profile, error);
    if (!rebound) throw error;
    profile = rebound;
    connection = await connectProfile(context, profile, options.withSession);
  }
  persistProfileSnapshot(context.store, connection.profile);
  if (options.withSession !== false) {
    await renewSessionWhenExpiring(context, connection);
  }
  return connection;
}

function connectProfile(context: CliContext, profile: CliProfile, withSession?: boolean) {
  return connectToControlPlane({
    store: context.store,
    profile,
    fetchImpl: context.fetchImpl,
    approvalWait: {
      signal: context.signal,
      sleep: context.sleep,
      notify: (id) => { if (!context.output.json) context.output.warn(`Waiting for your Web approval (${id}); expires in at most five minutes.`); },
    },
    ...(withSession === undefined ? {} : { withSession }),
  });
}

async function rebindManagedLocalProfile(context: CliContext, profile: CliProfile, error: unknown) {
  if (profile.source !== "local-discovery") return undefined;
  if (!(error instanceof ThctlError) || !["CLI_NETWORK_ERROR", "CLI_IDENTITY_UNAVAILABLE"].includes(error.code)) return undefined;
  const discovery = await discoverLocalControlPlane({ env: context.env, fetchImpl: context.fetchImpl });
  if (!discovery || discovery.origin === profile.origin) return undefined;
  return ensureLocalProfile(context.store, discovery);
}

/** 会话剩余有效期小于 7 天时续期；服务端只在窗口内延长，其他失败不阻断读命令。 */
const SESSION_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function renewSessionWhenExpiring(context: CliContext, connection: ThctlConnection) {
  const secrets = context.store.secrets();
  const credential = secrets.read(connection.profile.label);
  if (!credential?.expiresAt) return;
  // 本地信任会话在 authentication disabled 下没有续期端点，由过期/401 后的重新签发代替。
  if (credential.mode === "local-trust") return;
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
        ...(request.body === undefined ? {} : { body: redactSecrets(request.body) }),
      }
      : {
        dryRun: true,
        steps: steps.map((step) => ({ method: step.method, path: step.path, ...(step.body === undefined ? {} : { body: redactSecrets(step.body) }) })),
      });
    return undefined as T;
  }
  // 真实写请求发送前登记敏感明文，保证服务端回显到错误信息时也能擦除。
  for (const step of steps) registerSecretsFromValue(step.body);
  await requireConfirmation(context, commandId, steps.length === 1
    ? `${request.method} ${request.path} — continue?`
    : `${steps.length} requests will be sent (${steps.map((step) => `${step.method} ${step.path}`).join(", ")}) — continue?`);
  return execute();
}

export function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw new ThctlError("CLI_CANCELLED", "The operation was cancelled.", CLI_EXIT_CODES.cancelled);
}
