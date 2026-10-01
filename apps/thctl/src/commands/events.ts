import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";
import { SessionStreamsHelloEventType, SessionStreamsHelloSchema } from "@task-handoff/protocol/events";
import { requestUrl } from "../control-plane.ts";
import { CLI_EXIT_CODES, ThctlError, networkError, protocolError, serverError } from "../errors.ts";
import { createControlPlaneEventSocket, type CliEventSocket, type CliEventSocketFactory } from "../event-socket.ts";
import { openConnection, resolveProfile, type CliContext, type CliInvocation } from "../runtime.ts";

export const EVENT_KEEPALIVE_INTERVAL_MS = 20_000;

/** 去重只服务重连，上限之外按插入顺序淘汰最老的事件 id。 */
const SEEN_EVENT_LIMIT = 10_000;

/**
 * 服务端 topic 是 `ai.sessions` 形状，命令行额外接受 `ai-sessions` 这种别名；
 * 其余取值按协议原样透传（总线同时支持用事件 type 订阅）。
 */
const TOPIC_ALIASES: Record<string, string> = {
  "ai-sessions": "ai.sessions",
  "app-sessions": "app.sessions",
};

export function normalizeEventTopics(values: readonly string[] = []) {
  const topics = values
    .map((value) => String(value).trim())
    .filter(Boolean)
    .map((topic) => TOPIC_ALIASES[topic] ?? topic);
  return topics.length ? [...new Set(topics)] : ["*"];
}

/** `/api/events` 与 HTTP 命令共用同一个已固定 origin，只把协议换成 ws/wss。 */
export function eventStreamUrl(origin: string, instanceId?: string) {
  const url = new URL(requestUrl(origin, "/api/events"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("aiSessionTransient", "1");
  url.searchParams.set("resourceMetricsScope", "1");
  if (instanceId) url.searchParams.set("instanceId", instanceId);
  return url.toString();
}

export type EventStreamOptions = {
  url: string;
  authorization: string;
  topics: readonly string[];
  instanceId?: string;
  /** 服务端以 401 拒绝凭证时触发，调用方据此清理本地 session。 */
  onUnauthorized?: () => void;
};

type EventFrame = { type?: unknown; id?: unknown; payload?: unknown };

function parseEventFrame(data: string): EventFrame | undefined {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as EventFrame;
  } catch {
    return undefined;
  }
}

function createSubscribeFrame(options: EventStreamOptions) {
  return {
    v: 1,
    type: "subscribe",
    topics: [...options.topics],
    ...(options.instanceId ? { instanceIds: [options.instanceId] } : {}),
    // 终端消费者只要权威事件：显式关闭资源指标和高频 AI session 瞬时流，
    // 否则协议默认值会把 token 级增量也投递过来。
    metricInstanceIds: [],
    aiSessionTransient: {
      messageDeltas: { allInstances: false, instanceIds: [] },
      timelineAllSessions: false,
      timelineSessions: [],
    },
    aiSessionHierarchy: { subagents: true },
  };
}

/** 401/403 是权威拒绝，重连不会改变结果；其余状态在已有权威快照后可以重试。 */
function upgradeRejection(status: number, options: EventStreamOptions) {
  if (status === 401) {
    options.onUnauthorized?.();
    return {
      fatal: true,
      error: new ThctlError(
        "CLI_EVENT_STREAM_UNAUTHORIZED",
        "The Control Plane rejected the event stream credential (HTTP 401). Run `thctl login` to authorize this CLI again.",
        CLI_EXIT_CODES.notAuthenticated,
        { url: options.url, status },
      ),
    };
  }
  if (status === 403) {
    return {
      fatal: true,
      error: new ThctlError(
        "CLI_EVENT_STREAM_FORBIDDEN",
        "The Control Plane refused the event stream (HTTP 403).",
        CLI_EXIT_CODES.forbidden,
        { url: options.url, status },
      ),
    };
  }
  return {
    fatal: false,
    error: serverError(status, "CLI_EVENT_STREAM_UPGRADE_FAILED", `The Control Plane refused the event stream (HTTP ${status}).`, { url: options.url }),
  };
}

function closeDescription(info: { code: number; reason: string }) {
  return `${info.code}${info.reason ? `: ${info.reason}` : ""}`;
}

/**
 * 订阅 `/api/events` 并把每个事件作为一行 JSON 写到 stdout。
 * 断线按连接 epoch 重连：新连接先完成 streams.hello 握手的 snapshot-first 恢复，
 * 再按事件 id 去重输出，不轮询、不重复已确认事件。
 */
export async function streamControlPlaneEvents(context: CliContext, options: EventStreamOptions) {
  if (context.signal.aborted) return;
  const createSocket: CliEventSocketFactory = context.createEventSocket ?? createControlPlaneEventSocket;
  const subscribeFrame = createSubscribeFrame(options);

  await new Promise<void>((resolve, reject) => {
    const seen = new Set<string>();
    const backoff = new StandardReconnectBackoff();
    let connection: { socket: CliEventSocket; authoritative: boolean } | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let everAuthoritative = false;
    let settled = false;

    const stopKeepalive = () => {
      if (keepalive) clearInterval(keepalive);
      keepalive = undefined;
    };
    const stopRetry = () => {
      if (retry) clearTimeout(retry);
      retry = undefined;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      stopKeepalive();
      stopRetry();
      const current = connection;
      connection = undefined;
      current?.socket.close(1000, "thctl stopped the event stream.");
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish();

    const scheduleReconnect = () => {
      if (settled || retry) return;
      const { attempt, delay } = backoff.next();
      context.output.warn(`Event stream disconnected; reconnecting (attempt ${attempt}, in ${delay}ms).`);
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, delay);
    };

    const retire = (record: { socket: CliEventSocket; authoritative: boolean }, outcome: { error?: Error; warning?: string }) => {
      if (settled || connection !== record) return;
      connection = undefined;
      stopKeepalive();
      try {
        record.socket.close(1000, outcome.error ? "thctl stopped the event stream." : "thctl is reconnecting the event stream.");
      } catch {
        // 关闭失败时由下一次连接和旧 socket 的 close 事件兜底。
      }
      if (outcome.error) {
        finish(outcome.error);
        return;
      }
      if (outcome.warning) context.output.warn(outcome.warning);
      scheduleReconnect();
    };

    const handleFrame = (record: { socket: CliEventSocket; authoritative: boolean }, data: string) => {
      const frame = parseEventFrame(data);
      if (!frame) {
        context.output.warn("Ignoring an unreadable event frame.");
        return;
      }
      if (frame.type === "pong") return;
      if (frame.type === SessionStreamsHelloEventType) {
        const hello = SessionStreamsHelloSchema.safeParse(frame.payload);
        if (!hello.success) {
          finish(protocolError("The Control Plane sent an incompatible session stream handshake.", { url: options.url }));
          return;
        }
        // 传输层 open 不等于恢复完成；握手成功才重置重连退避。
        record.authoritative = true;
        everAuthoritative = true;
        backoff.reset();
        return;
      }
      if (!record.authoritative) return;
      const id = typeof frame.id === "string" ? frame.id : undefined;
      if (id) {
        if (seen.has(id)) return;
        seen.add(id);
        if (seen.size > SEEN_EVENT_LIMIT) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
      }
      context.output.streams.stdout(`${JSON.stringify(frame)}\n`);
    };

    const connect = () => {
      if (settled) return;
      const record = { socket: undefined as unknown as CliEventSocket, authoritative: false };
      record.socket = createSocket({
        url: options.url,
        authorization: options.authorization,
        handlers: {
          opened: () => {
            if (settled || connection !== record) return;
            record.socket.send(JSON.stringify(subscribeFrame));
            stopKeepalive();
            keepalive = setInterval(() => {
              if (settled || connection !== record) return;
              try {
                record.socket.send(JSON.stringify({ v: 1, type: "ping", sentAt: new Date().toISOString() }));
              } catch {
                // 连接已断开；close 事件负责重连。
              }
            }, EVENT_KEEPALIVE_INTERVAL_MS);
          },
          message: (data) => {
            if (settled || connection !== record) return;
            handleFrame(record, data);
          },
          closed: (info) => {
            if (settled || connection !== record) return;
            if (info.code === 4003) {
              retire(record, {
                error: new ThctlError(
                  "CLI_EVENT_STREAM_SCOPE_NOT_VISIBLE",
                  "The requested event scope is not visible to this account.",
                  CLI_EXIT_CODES.forbidden,
                  { url: options.url, closeCode: info.code },
                ),
              });
              return;
            }
            if (info.code === 1002) {
              retire(record, {
                error: protocolError("The Control Plane closed the event stream because the protocol is incompatible.", { url: options.url, closeCode: info.code }),
              });
              return;
            }
            if (!record.authoritative) {
              retire(record, {
                error: networkError(
                  `The Control Plane closed the event stream before the session-stream handshake (code ${closeDescription(info)}).`,
                  { url: options.url, closeCode: info.code },
                ),
              });
              return;
            }
            retire(record, { warning: `Event stream closed (code ${closeDescription(info)}).` });
          },
          failed: (error) => {
            if (settled || connection !== record) return;
            if (!everAuthoritative) {
              retire(record, { error: networkError(`Could not open the event stream at ${options.url}: ${error.message}`, { url: options.url }) });
              return;
            }
            retire(record, { warning: `Event stream error: ${error.message}` });
          },
          rejected: (status) => {
            if (settled || connection !== record) return;
            const rejection = upgradeRejection(status, options);
            if (rejection.fatal || !everAuthoritative) {
              retire(record, { error: rejection.error });
              return;
            }
            retire(record, { warning: `${rejection.error.message} Retrying.` });
          },
        },
      });
      connection = record;
    };

    context.signal.addEventListener("abort", onAbort, { once: true });
    connect();
  });
}

export async function eventsCommand(context: CliContext, invocation: CliInvocation) {
  const topics = normalizeEventTopics((invocation.options.topic as string[] | undefined) ?? []);
  const instanceId = typeof invocation.options.instance === "string" ? invocation.options.instance.trim() : "";
  const profile = resolveProfile(context);
  const connection = await openConnection(context, { profile });
  const credential = context.store.secrets().read(connection.profile.label);
  if (!credential) {
    throw new ThctlError(
      "CLI_NOT_AUTHENTICATED",
      `No CLI session stored for \`${connection.profile.label}\`. Run \`thctl login\`.`,
      CLI_EXIT_CODES.notAuthenticated,
      { profile: connection.profile.label },
    );
  }
  await streamControlPlaneEvents(context, {
    url: eventStreamUrl(connection.profile.origin, instanceId || undefined),
    authorization: `Bearer ${credential.sessionToken}`,
    topics,
    ...(instanceId ? { instanceId } : {}),
    onUnauthorized: () => context.store.secrets().remove(connection.profile.label),
  });
}
