import WebSocket from "ws";
import {
  InstanceLifecycleEventType,
  InstanceLifecycleSnapshotSchema,
  ImagePullTerminalEventType,
  ImagePullTerminalFinishedSchema,
  ImagePullTerminalOutputSchema,
  controlledInstanceAcceptsTraffic,
  type ImagePullTerminalFinished,
  type ImagePullTerminalOutput,
  type ControlledInstance,
} from "@task-handoff/protocol/control-plane";
import { AiSessionEventTopic, AiSessionEventType } from "@task-handoff/protocol/ai-sessions";
import { AppSessionEventTopic } from "@task-handoff/protocol/app-sessions";
import { AiSessionTransientSubscriptionSchema, SessionStreamsHelloEventType, SessionStreamsHelloSchema, aiSessionTransientSubscriptionAccepts, eventTopic, type AiSessionTransientSubscription, type EventEnvelope } from "@task-handoff/protocol/events";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";
import { EventConnectionRetryTimer, eventConnectionSafetyIntervalMs } from "../shared/events/connection-retry.ts";

type NodeAgentInstanceEventState = {
  listInstances(): ControlledInstance[];
};

type ForwardedInstanceEvent = EventEnvelope & {
  replay?: boolean;
  scope?: {
    instanceId?: string;
    [key: string]: unknown;
  };
};

type Logger = {
  info?: (data: Record<string, unknown>, message?: string) => void;
  warn?: (data: Record<string, unknown>, message?: string) => void;
};

function splitTerminalReplay(data: string, maxLength = 60_000) {
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += maxLength) chunks.push(data.slice(offset, offset + maxLength));
  return chunks;
}

const MAX_EVENT_OUTPUT_BUFFERED_BYTES = 16 * 1024 * 1024;

export class NodeAgentInstanceEventForwarder {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly socketUrls = new Map<string, string>();
  private readonly retries = new Map<string, { timer: EventConnectionRetryTimer; url?: string }>();
  private readonly outputs = new Set<WebSocket>();
  private readonly outputSubscriptions = new Map<WebSocket, AiSessionTransientSubscription | undefined>();
  private readonly imagePullTerminalByInstance = new Map<string, { output: ImagePullTerminalOutput; tail: string; finished?: ImagePullTerminalFinished }>();
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
  private readonly setTimeoutFn: typeof setTimeout;

  constructor(state: NodeAgentInstanceEventState, token?: string, options: { logger?: Logger; safetyIntervalMs?: number; createSocket?: NodeAgentInstanceEventForwarder["createSocket"]; setIntervalFn?: typeof setInterval; clearIntervalFn?: typeof clearInterval; setTimeoutFn?: typeof setTimeout } = {}) {
    this.state = state;
    this.token = token;
    this.logger = options.logger;
    this.safetyIntervalMs = eventConnectionSafetyIntervalMs(options.safetyIntervalMs);
    this.createSocket = options.createSocket || ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
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
    this.outputSubscriptions.clear();
  }

  addOutput(socket: WebSocket, options: { expectsTransientSubscription?: boolean; legacyFallbackMs?: number } = {}) {
    this.outputs.add(socket);
    // Compatibility for v0.0.21: no subscription update means the older control-plane expects the full stream.
    this.outputSubscriptions.set(socket, options.expectsTransientSubscription ? AiSessionTransientSubscriptionSchema.parse({}) : undefined);
    let legacyFallback: ReturnType<typeof setTimeout> | undefined;
    if (!options.expectsTransientSubscription && options.legacyFallbackMs !== undefined) {
      legacyFallback = this.setTimeoutFn(() => {
        legacyFallback = undefined;
        if (this.outputs.has(socket) && this.outputSubscriptions.get(socket) === undefined) this.syncNow();
      }, options.legacyFallbackMs);
    }
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      this.outputs.delete(socket);
      this.outputSubscriptions.delete(socket);
      if (legacyFallback) clearTimeout(legacyFallback);
      this.syncNow();
    };
    socket.on("close", remove);
    socket.on("error", remove);
    for (const instance of this.state.listInstances()) {
      const snapshot = tryInstanceLifecycleSnapshot(instance);
      if (!snapshot) {
        this.logger?.warn?.({ instanceId: instance.id }, "instance.lifecycle.snapshot.invalid");
        continue;
      }
      this.sendForwarded(socket, this.createEvent(
        InstanceLifecycleEventType.Snapshot,
        snapshot,
        { instanceId: instance.id },
      ));
    }
    for (const [instanceId, terminal] of this.imagePullTerminalByInstance) {
      const chunks = splitTerminalReplay(terminal.tail);
      chunks.forEach((data, index) => this.sendForwarded(socket, this.createEvent(
        ImagePullTerminalEventType.Output,
        { ...terminal.output, sequence: terminal.output.sequence + index, data, ...(index === 0 ? { replay: true } : {}) },
        { instanceId },
      )));
      if (terminal.finished) {
        this.sendForwarded(socket, this.createEvent(ImagePullTerminalEventType.Finished, terminal.finished, { instanceId }));
      }
    }
    if (options.expectsTransientSubscription || options.legacyFallbackMs === undefined) this.syncNow();
    return remove;
  }

  setOutputSubscription(socket: WebSocket, input: unknown) {
    if (!this.outputs.has(socket)) return false;
    const parsed = AiSessionTransientSubscriptionSchema.safeParse(input);
    if (!parsed.success) return false;
    this.outputSubscriptions.set(socket, parsed.data);
    // Receiving the current subscription cancels the compatibility hold-open
    // and is the authority to establish controlled-instance inputs.
    this.syncNow();
    for (const [instanceId, instanceSocket] of this.sockets) this.sendInstanceSubscription(instanceId, instanceSocket);
    return true;
  }

  publish(type: string, payload: unknown, scope: Record<string, unknown> = {}) {
    this.rememberImagePullTerminal(type, payload);
    const event = this.createEvent(type, payload, scope);
    for (const output of this.outputs) this.sendForwarded(output, event);
  }

  private rememberImagePullTerminal(type: string, payload: unknown) {
    if (type === ImagePullTerminalEventType.Output) {
      const parsed = safeParseResponse(ImagePullTerminalOutputSchema, payload);
      if (!parsed.success) return;
      const output = parsed.data;
      const current = this.imagePullTerminalByInstance.get(output.instanceId);
      if (current && output.generation < current.output.generation) return;
      const sameGeneration = current?.output.generation === output.generation;
      const tail = output.replay || !sameGeneration ? output.data : `${current.tail}${output.data}`.slice(-(256 * 1024));
      this.imagePullTerminalByInstance.set(output.instanceId, { output, tail });
      return;
    }
    if (type === ImagePullTerminalEventType.Finished) {
      const parsed = safeParseResponse(ImagePullTerminalFinishedSchema, payload);
      if (!parsed.success) return;
      const finished = parsed.data;
      const current = this.imagePullTerminalByInstance.get(finished.instanceId);
      if (current?.output.generation === finished.generation) current.finished = finished;
    }
  }

  publishInstanceLifecycle(instance: ControlledInstance) {
    this.publish(
      InstanceLifecycleEventType.Snapshot,
      instanceLifecycleSnapshot(instance),
      { instanceId: instance.id },
    );
    const terminal = this.imagePullTerminalByInstance.get(instance.id);
    if (instance.imageProvisioning?.phase === "ready" && terminal?.finished?.outcome === "succeeded") {
      this.imagePullTerminalByInstance.delete(instance.id);
    }
  }

  private createEvent(type: string, payload: unknown, scope: Record<string, unknown>): EventEnvelope {
    const sequence = ++this.localSequence;
    return {
      v: 1,
      id: `node_evt_${Date.now().toString(36)}_${sequence.toString(36)}`,
      seq: sequence,
      type,
      topic: eventTopic(type),
      createdAt: new Date().toISOString(),
      payload,
      scope,
    };
  }

  private sendForwarded(output: WebSocket, event: EventEnvelope) {
    const encoded = JSON.stringify({ type: "node-agent.event.forwarded", event });
    this.sendOutput(output, encoded);
  }

  private sendOutput(output: WebSocket, encoded: string) {
    if (output.readyState !== WebSocket.OPEN) return false;
    if (output.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_EVENT_OUTPUT_BUFFERED_BYTES) {
      try { output.close(1013, "Event consumer is too slow."); } catch { /* Close is best-effort after rejecting the frame. */ }
      return false;
    }
    try {
      output.send(encoded);
      return true;
    } catch {
      try { output.close(1011, "Event delivery failed."); } catch { /* Close is best-effort after rejecting the frame. */ }
      return false;
    }
  }

  syncNow() {
    this.sync();
  }

  diagnostics() {
    const subscriptions = [...this.outputSubscriptions.values()];
    return {
      reconnectAttempts: this.reconnectAttempts,
      safetyReconciliations: this.safetyReconciliations,
      activeConnections: this.sockets.size,
      pendingRetries: [...this.retries.values()].filter((entry) => entry.timer.pending).length,
      safetyIntervalMs: this.safetyIntervalMs,
      transientDemand: {
        legacyOutputs: subscriptions.filter((entry) => entry === undefined).length,
        scopedOutputs: subscriptions.filter((entry) => entry !== undefined).length,
        messageDeltaAllInstances: subscriptions.some((entry) => entry?.messageDeltas.allInstances),
        messageDeltaInstanceCount: new Set(subscriptions.flatMap((entry) => entry?.messageDeltas.instanceIds || [])).size,
        timelineAllSessions: subscriptions.some((entry) => entry?.timelineAllSessions),
        timelineSessionCount: new Set(subscriptions.flatMap((entry) => entry?.timelineSessions.map((session) => JSON.stringify([session.instanceId, session.sessionId])) || [])).size,
      },
    };
  }

  private sync() {
    const instanceIds = new Set(this.state.listInstances().map((instance) => instance.id));
    for (const instanceId of this.imagePullTerminalByInstance.keys()) {
      if (!instanceIds.has(instanceId)) this.imagePullTerminalByInstance.delete(instanceId);
    }
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
      this.retries.set(instanceId, { timer: retry?.timer || new EventConnectionRetryTimer(), url });
      if (socket.readyState === WebSocket.OPEN) {
        this.sendInstanceSubscription(instanceId, socket);
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
        const hello = safeParseResponse(SessionStreamsHelloSchema, event.payload);
        if (!hello.success) {
          this.logger?.warn?.({ instanceId, issues: hello.error.issues }, "session-stream.handshake.invalid");
          socket.close(1002, "Incompatible session stream handshake.");
          return;
        }
        // Transport open is not recovery: a peer can repeatedly accept the
        // socket and then reject or omit the authoritative stream handshake.
        // Reset only after the current protocol handshake has succeeded.
        this.retries.get(instanceId)?.timer.reset();
        const encoded = JSON.stringify({ type: "node-agent.streams.hello", instanceId, payload: hello.data });
        for (const output of this.outputs) this.sendOutput(output, encoded);
        return;
      }
      this.recordAiSessionEvent(instanceId, event);
      this.recordAppSessionEvent(instanceId, event);
      const encoded = JSON.stringify({
        type: "node-agent.event.forwarded",
        event,
      });
      for (const output of this.outputs) {
        if (output.readyState === WebSocket.OPEN && this.outputAccepts(output, event)) {
          this.sendOutput(output, encoded);
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

  private sendInstanceSubscription(instanceId: string, socket: WebSocket) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const subscriptions = [...this.outputs].map((output) => this.outputSubscriptions.get(output));
    const legacyAll = subscriptions.some((entry) => entry === undefined);
    if (legacyAll) {
      socket.send(JSON.stringify({ v: 1, type: "subscribe", topics: [AiSessionEventTopic, "app.sessions", "apps", "instances"] }));
      return;
    }
    const messageDeltas = subscriptions.some((entry) => entry!.messageDeltas.allInstances || entry!.messageDeltas.instanceIds.includes(instanceId));
    const timelineAllSessions = subscriptions.some((entry) => entry!.timelineAllSessions);
    const timelineSessionIds = [...new Set(subscriptions.flatMap((entry) => entry!.timelineSessions
      .filter((session) => session.instanceId === instanceId)
      .map((session) => session.sessionId)))];
    const replaySince = earliestReplaySince(subscriptions.map((entry) => entry!.replaySince));
    socket.send(JSON.stringify({
      v: 1,
      type: "subscribe",
      topics: [
        AiSessionEventType.Snapshot,
        AiSessionEventType.Patch,
        AiSessionEventType.Removed,
        ...(messageDeltas ? [AiSessionEventType.MessageDelta] : []),
        ...(timelineAllSessions || timelineSessionIds.length ? [AiSessionEventType.TimelineItem] : []),
        "app.sessions",
        "apps",
        "instances",
      ],
      aiSessionTransient: {
        ...(replaySince ? { replaySince } : {}),
        messageDeltas: { allInstances: messageDeltas, instanceIds: [] },
        timelineAllSessions,
        timelineSessions: timelineSessionIds.map((sessionId) => ({ instanceId, sessionId })),
      },
    }));
  }

  private outputAccepts(output: WebSocket, event: ForwardedInstanceEvent) {
    const subscription = this.outputSubscriptions.get(output);
    if (!subscription) return true;
    return aiSessionTransientSubscriptionAccepts(subscription, event);
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
    }, { setTimeoutFn: this.setTimeoutFn });
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
    if (event.type === AiSessionEventType.MessageDelta || event.type === AiSessionEventType.TimelineItem) {
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

function instanceLifecycleSnapshot(instance: ControlledInstance) {
  return InstanceLifecycleSnapshotSchema.parse(instanceLifecycleSnapshotInput(instance));
}

function tryInstanceLifecycleSnapshot(instance: ControlledInstance) {
  const snapshot = InstanceLifecycleSnapshotSchema.safeParse(instanceLifecycleSnapshotInput(instance));
  return snapshot.success ? snapshot.data : undefined;
}

function instanceLifecycleSnapshotInput(instance: ControlledInstance) {
  return {
    instanceId: instance.id,
    revision: instance.stateRevision,
    updatedAt: instance.updatedAt,
    status: instance.status,
    health: instance.health,
    connectionStatus: instance.connectionStatus,
    accessStatus: instance.connectionStatus === "online" || instance.agentStatus === "online" ? "reachable" : "endpoint-unreachable",
    imageProvisioning: instance.imageProvisioning,
    workspace: instance.workspace,
    runtime: instance.runtime,
    runtimeVersion: instance.runtimeVersion,
    ready: instance.ready,
    lastHeartbeatAt: instance.lastHeartbeatAt,
  };
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
  if (!controlledInstanceAcceptsTraffic(instance)) return undefined;
  const base = instance.target?.api || instance.target?.web;
  if (!base) {
    return undefined;
  }
  try {
    const url = new URL("/api/events", base);
    url.searchParams.set("aiSessionTransient", "1");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  } catch {
    return undefined;
  }
}

function earliestReplaySince(values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort()[0];
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
      ...(record.replay === true ? { replay: true } : {}),
      scope: {
        ...scope,
        instanceId,
      },
    };
  } catch {
    return undefined;
  }
}
