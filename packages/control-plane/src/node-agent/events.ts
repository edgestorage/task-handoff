import WebSocket from "ws";
import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import { AiSessionEventTopic, AiSessionEventType } from "@task-handoff/protocol/ai-sessions";
import { AppSessionEventTopic } from "@task-handoff/protocol/app-sessions";
import { SessionStreamsHelloEventType, SessionStreamsHelloSchema, eventTopic, type EventEnvelope } from "@task-handoff/protocol/events";
import { EventConnectionRetryTimer, eventConnectionSafetyIntervalMs } from "../shared/events/connection-retry.ts";

type NodeAgentInstanceEventState = {
  listInstances(): ControlledInstance[];
};

type ForwardedInstanceEvent = EventEnvelope & {
  scope?: {
    instanceId?: string;
    [key: string]: unknown;
  };
};

type Logger = {
  info?: (data: Record<string, unknown>, message?: string) => void;
  warn?: (data: Record<string, unknown>, message?: string) => void;
};

export class NodeAgentInstanceEventForwarder {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly socketUrls = new Map<string, string>();
  private readonly retries = new Map<string, { timer: EventConnectionRetryTimer; url?: string }>();
  private readonly outputs = new Set<WebSocket>();
  private readonly state: NodeAgentInstanceEventState;
  private readonly token?: string;
  private readonly logger?: Logger;
  private readonly safetyIntervalMs: number;
  private readonly lastAiSessionEventByInstance = new Map<string, { streamId?: string; revision?: number }>();
  private readonly lastAppSessionEventByInstance = new Map<string, { streamId?: string; revision?: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private safetyReconciliations = 0;
  private localSequence = 0;
  private readonly createSocket: (url: string, options: { headers?: { authorization: string } }) => WebSocket;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  constructor(state: NodeAgentInstanceEventState, token?: string, options: { logger?: Logger; safetyIntervalMs?: number; createSocket?: NodeAgentInstanceEventForwarder["createSocket"]; setIntervalFn?: typeof setInterval; clearIntervalFn?: typeof clearInterval } = {}) {
    this.state = state;
    this.token = token;
    this.logger = options.logger;
    this.safetyIntervalMs = eventConnectionSafetyIntervalMs(options.safetyIntervalMs);
    this.createSocket = options.createSocket || ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
  }

  start() {
    this.sync();
    this.timer = this.setIntervalFn(() => {
      this.safetyReconciliations += 1;
      this.sync();
    }, this.safetyIntervalMs);
  }

  stop() {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
    for (const socket of this.sockets.values()) {
      socket.close();
    }
    this.sockets.clear();
    this.socketUrls.clear();
    for (const retry of this.retries.values()) retry.timer.cancel();
    this.retries.clear();
    this.outputs.clear();
  }

  addOutput(socket: WebSocket) {
    this.outputs.add(socket);
    socket.on("close", () => this.outputs.delete(socket));
    socket.on("error", () => this.outputs.delete(socket));
    this.syncNow();
    return () => {
      this.outputs.delete(socket);
    };
  }

  publish(type: string, payload: unknown, scope: Record<string, unknown> = {}) {
    const sequence = ++this.localSequence;
    const event: EventEnvelope = {
      v: 1,
      id: `node_evt_${Date.now().toString(36)}_${sequence.toString(36)}`,
      seq: sequence,
      type,
      topic: eventTopic(type),
      createdAt: new Date().toISOString(),
      payload,
      scope,
    };
    const encoded = JSON.stringify({ type: "node-agent.event.forwarded", event });
    for (const output of this.outputs) {
      if (output.readyState === WebSocket.OPEN) output.send(encoded);
    }
  }

  syncNow() {
    this.sync();
  }

  diagnostics() {
    return { reconnectAttempts: this.reconnectAttempts, safetyReconciliations: this.safetyReconciliations, activeConnections: this.sockets.size, pendingRetries: [...this.retries.values()].filter((entry) => entry.timer.pending).length, safetyIntervalMs: this.safetyIntervalMs };
  }

  private sync() {
    if (!this.outputs.size) {
      for (const socket of this.sockets.values()) {
        socket.close();
      }
      this.sockets.clear();
      this.socketUrls.clear();
      for (const retry of this.retries.values()) retry.timer.cancel();
      this.retries.clear();
      return;
    }
    const active = new Set<string>();
    for (const instance of this.state.listInstances()) {
      const url = instanceEventUrl(instance);
      if (!url) {
        continue;
      }
      active.add(instance.id);
      const scheduledRetry = this.retries.get(instance.id);
      if (scheduledRetry?.timer.pending && scheduledRetry.url !== url) {
        scheduledRetry.timer.cancel();
        this.retries.delete(instance.id);
      }
      if (this.socketUrls.get(instance.id) !== url && this.sockets.has(instance.id)) {
        this.sockets.get(instance.id)?.close();
        this.sockets.delete(instance.id);
      }
      if (!this.sockets.has(instance.id) && !this.retries.get(instance.id)?.timer.pending) {
        this.connect(instance.id, url);
      }
    }
    for (const [instanceId, socket] of this.sockets) {
      if (!active.has(instanceId)) {
        socket.close();
        this.sockets.delete(instanceId);
        this.socketUrls.delete(instanceId);
        const retry = this.retries.get(instanceId);
        retry?.timer.cancel();
        this.retries.delete(instanceId);
      }
    }
    for (const [instanceId, retry] of this.retries) {
      if (!active.has(instanceId)) {
        retry.timer.cancel();
        this.retries.delete(instanceId);
        this.socketUrls.delete(instanceId);
      }
    }
  }

  private connect(instanceId: string, url: string) {
    const headers = this.token ? { authorization: `Bearer ${this.token}` } : undefined;
    const socket = this.createSocket(url, { headers });
    this.sockets.set(instanceId, socket);
    this.socketUrls.set(instanceId, url);
    socket.on("open", () => {
      const retry = this.retries.get(instanceId);
      retry?.timer.reset();
      this.retries.set(instanceId, { timer: retry?.timer || new EventConnectionRetryTimer(), url });
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ v: 1, type: "subscribe", topics: [AiSessionEventTopic, "app.sessions", "apps", "instances"] }));
        this.logger?.info?.({ instanceId, url }, "ai-session.event.forward.connect");
        this.logger?.info?.({ instanceId, url }, "app-session.event.forward.connect");
      }
    });
    socket.on("message", (raw) => {
      const event = parseForwardedInstanceEvent(raw, instanceId);
      if (!event) {
        return;
      }
      if (event.type === SessionStreamsHelloEventType) {
        const hello = SessionStreamsHelloSchema.safeParse(event.payload);
        if (!hello.success) {
          this.logger?.warn?.({ instanceId, issues: hello.error.issues }, "session-stream.handshake.invalid");
          socket.close(1002, "Incompatible session stream handshake.");
          return;
        }
        const encoded = JSON.stringify({ type: "node-agent.streams.hello", instanceId, payload: hello.data });
        for (const output of this.outputs) if (output.readyState === WebSocket.OPEN) output.send(encoded);
        return;
      }
      this.recordAiSessionEvent(instanceId, event);
      this.recordAppSessionEvent(instanceId, event);
      const encoded = JSON.stringify({
        type: "node-agent.event.forwarded",
        event,
      });
      for (const output of this.outputs) {
        if (output.readyState === WebSocket.OPEN) {
          output.send(encoded);
        }
      }
    });
    socket.on("close", () => {
      if (this.sockets.get(instanceId) === socket) {
        this.sockets.delete(instanceId);
        this.socketUrls.delete(instanceId);
        this.scheduleReconnect(instanceId);
      }
    });
    socket.on("error", () => {
      this.logger?.warn?.({ instanceId, url }, "ai-session.event.forward.error");
      this.logger?.warn?.({ instanceId, url }, "app-session.event.forward.error");
      socket.close();
    });
  }

  private scheduleReconnect(instanceId: string) {
    const instance = this.state.listInstances().find((candidate) => candidate.id === instanceId);
    const url = instance && instanceEventUrl(instance);
    if (!url || !this.outputs.size) return;
    const current = this.retries.get(instanceId) ?? { timer: new EventConnectionRetryTimer() };
    if (current.timer.pending) return;
    current.url = url;
    const scheduled = current.timer.schedule(() => {
      if (!this.sockets.has(instanceId)) this.connect(instanceId, url);
    });
    if (scheduled) {
      this.reconnectAttempts += 1;
      this.logger?.info?.({ instanceId, url, attempt: scheduled.attempt, delay: scheduled.delay, reconnectAttempts: this.reconnectAttempts }, "session-stream.connection.reconnect-scheduled");
    }
    this.retries.set(instanceId, current);
  }

  private recordAiSessionEvent(instanceId: string, event: ForwardedInstanceEvent) {
    if (event.topic !== AiSessionEventTopic) {
      return;
    }
    if (event.type === AiSessionEventType.MessageDelta) {
      return;
    }
    const meta = eventPayloadMeta(event.payload);
    const previous = this.lastAiSessionEventByInstance.get(instanceId);
    if (previous?.streamId === meta.streamId && previous.revision !== undefined && meta.revision !== undefined && meta.revision > previous.revision + 1) {
      this.logger?.warn?.({
        instanceId,
        traceId: meta.traceId,
        streamId: meta.streamId,
        previousRevision: previous.revision,
        revision: meta.revision,
      }, "ai-session.event.forward.gap");
    }
    this.lastAiSessionEventByInstance.set(instanceId, {
      streamId: meta.streamId ?? previous?.streamId,
      revision: meta.revision ?? previous?.revision,
    });
    this.logger?.info?.({
      instanceId,
      traceId: meta.traceId,
      eventType: event.type,
      streamId: meta.streamId,
      revision: meta.revision,
    }, "ai-session.event.forward.message");
  }

  private recordAppSessionEvent(instanceId: string, event: ForwardedInstanceEvent) {
    if (event.topic !== AppSessionEventTopic) {
      return;
    }
    const meta = eventPayloadMeta(event.payload);
    const previous = this.lastAppSessionEventByInstance.get(instanceId);
    if (previous?.streamId === meta.streamId && previous.revision !== undefined && meta.revision !== undefined && meta.revision > previous.revision + 1) {
      this.logger?.warn?.({
        instanceId,
        traceId: meta.traceId,
        streamId: meta.streamId,
        previousRevision: previous.revision,
        revision: meta.revision,
      }, "app-session.event.forward.gap");
    }
    this.lastAppSessionEventByInstance.set(instanceId, {
      streamId: meta.streamId ?? previous?.streamId,
      revision: meta.revision ?? previous?.revision,
    });
    this.logger?.info?.({
      instanceId,
      traceId: meta.traceId,
      eventType: event.type,
      streamId: meta.streamId,
      revision: meta.revision,
    }, "app-session.event.forward.message");
  }
}

function eventPayloadMeta(payload: unknown) {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta) ? record.meta as Record<string, unknown> : {};
  return {
    streamId: typeof meta.streamId === "string" ? meta.streamId : undefined,
    revision: typeof meta.revision === "number" ? meta.revision : undefined,
    traceId: typeof meta.traceId === "string" ? meta.traceId : undefined,
  };
}

function instanceEventUrl(instance: ControlledInstance) {
  const base = instance.target?.api || instance.target?.web;
  if (!base) {
    return undefined;
  }
  try {
    const url = new URL("/api/events", base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseForwardedInstanceEvent(raw: unknown, instanceId: string): ForwardedInstanceEvent | undefined {
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (!type || type === "events.connected") {
      return undefined;
    }
    const scope = record.scope && typeof record.scope === "object" && !Array.isArray(record.scope) ? record.scope as Record<string, unknown> : {};
    return {
      v: 1,
      id: typeof record.id === "string" ? record.id : `evt_${Date.now().toString(36)}`,
      seq: Number(record.seq) || 0,
      type,
      topic: typeof record.topic === "string" ? record.topic : eventTopic(type),
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
      payload: "payload" in record ? record.payload : {},
      scope: {
        ...scope,
        instanceId,
      },
    };
  } catch {
    return undefined;
  }
}
