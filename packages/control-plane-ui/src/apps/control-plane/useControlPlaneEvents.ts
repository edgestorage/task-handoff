import { onBeforeUnmount, onMounted, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";
import { COMPACT_EVENT_ENVELOPE_VERSION, EventKeepalivePongSchema, SessionStreamsHelloEventType, SessionStreamsHelloSchema, normalizeEventEnvelope } from "@task-handoff/protocol/events";
import {
  InstanceLifecycleEventType,
  InstanceLifecycleSnapshotSchema,
  InstanceResourceMetricsEventType,
  InstanceResourceMetricsSchema,
  NodeStateProjectionEventSchema,
  NodeJoinedEventSchema,
  type InstanceLifecycleSnapshot,
  type NodeJoinedEvent,
} from "@task-handoff/protocol/control-plane";
import { AiSessionEventType as ProtocolAiSessionEventType, AiSessionTimelineItemEventSchema, AiSessionUnreadEventType, AiSessionUnreadStateSchema, normalizeAiSessionMessageDeltaEvent, type AiSessionTimelineItemEvent, type AiSessionUnreadState } from "@task-handoff/protocol/ai-sessions";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";
import { ControlPlaneNodeFleetUpdatedEventSchema } from "@task-handoff/protocol/control-plane-directory";
import { ControlPlaneAiSessionTriggerBoundEventSchema, ControlPlaneAiSessionTriggerUnboundEventSchema } from "@task-handoff/protocol/triggers";
import type { SessionStreamDescriptor } from "@task-handoff/protocol/events";
import type { AppManagementEvent } from "../../api/types";
import type { InstanceResourceMetrics } from "../../api/types";
import type { InstanceTriggerMutationResult } from "../../api/types";
import type { InstanceBoardPayload } from "../../api/types";
import { controlPlaneQueryKeys } from "../../api/queryKeys.ts";
import { getControlledInstanceTriggers } from "../../api/queries.ts";
import { controlPlaneDomainQueryKeys } from "../../api/queryInvalidation.ts";
import { applyInstanceLifecycle, applyNodeFleetState, applyNodeStateProjection } from "./instanceLifecycleCache.ts";
import { removeInstanceTriggerBinding, replaceInstanceTriggerSnapshot, upsertInstanceTriggerBinding } from "./instanceTriggerCache.ts";
import { controlPlaneEventDomains } from "./eventInvalidation.ts";
import { aiSessionMessageDeltaDemand, aiSessionTimelineDemand, aiSessionTransientReplaySince } from "./useAiSessionEventDemand.ts";
import {
  AiSessionEventType,
  AppSessionEventType,
  type AiSessionDeltaResponse,
  type AiSessionMessageDeltaEvent,
  type AppSessionDeltaResponse,
} from "../../api/types";

type EventMessage = {
  id?: string;
  replay?: boolean;
  type?: string;
  topic?: string;
  payload?: unknown;
  event?: unknown;
  scope?: { instanceId?: string; nodeId?: string; [key: string]: unknown };
};

const LIFECYCLE_COMMAND_NOTIFICATIONS = new Set([
  "instance.started",
  "instance.stopped",
  "instance.restarted",
  "instance.image-provisioning-retried",
]);

export function useControlPlaneEvents(input: {
  instanceId?: MaybeRefOrGetter<string>;
  resourceMetricInstanceIds?: MaybeRefOrGetter<string[]>;
  enabled?: MaybeRefOrGetter<boolean>;
  aiSessions: {
    applyEvent: (event: AiSessionDeltaResponse["events"][number]) => boolean;
    applyUnreadEvent: (state: AiSessionUnreadState) => boolean;
    applyMessageDelta: (payload: AiSessionMessageDeltaEvent, options?: { replay?: boolean }) => boolean;
    applyTimelineItem: (payload: AiSessionTimelineItemEvent) => boolean;
    recoverTimelineItems: () => void;
    recoverDescriptor: (descriptor: SessionStreamDescriptor) => Promise<void>;
  };
  appSessions: {
    applyEvent: (event: AppSessionDeltaResponse["events"][number]) => boolean;
    recoverDescriptor: (descriptor: SessionStreamDescriptor) => Promise<void>;
  };
  appManagement?: {
    applyEvent: (instanceId: string, event: AppManagementEvent) => boolean;
    recoverOpen: () => void | Promise<void>;
  };
  resourceMetrics?: {
    applyEvent: (metrics: InstanceResourceMetrics) => boolean;
    recoverOpen: () => void | Promise<void>;
  };
  imagePullProgress?: {
    applyEvent: (type: string, payload: unknown) => boolean;
    clear?: (instanceId: string) => void;
    reconcileLifecycle?: (lifecycle: InstanceLifecycleSnapshot) => void;
  };
  nodes?: {
    joined: (event: NodeJoinedEvent) => void;
  };
}) {
  const queryClient = useQueryClient();
  const pendingInvalidationKeys = new Map<string, readonly unknown[]>();
  let invalidationTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let socket: WebSocket | undefined;
  let closing = false;
  const reconnectBackoff = new StandardReconnectBackoff();
  let hasOpened = false;
  const seenTransientEventIds = new Set<string>();

  function connect() {
    if (input.enabled !== undefined && !toValue(input.enabled)) return;
    if (socket && socket.readyState !== WebSocket.CLOSED) return;
    closing = false;
    const current = new WebSocket(eventsUrl(toValue(input.instanceId || "")));
    socket = current;
    current.addEventListener("open", () => {
      const recovering = hasOpened;
      hasOpened = true;
      const instanceId = toValue(input.instanceId || "");
      sendSubscription(current, new Date().toISOString());
      startKeepalive(current);
      void queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.scopedInstanceBoard(toValue(input.instanceId || "")) });
      void input.appManagement?.recoverOpen();
      void input.resourceMetrics?.recoverOpen();
      for (const triggerInstanceId of cachedInstanceIds(instanceId)) {
        void recoverInstanceTriggers(triggerInstanceId);
      }
      if (recovering) input.aiSessions.recoverTimelineItems();
    });
    current.addEventListener("message", (event) => handleMessage(String(event.data)));
    current.addEventListener("close", () => {
      if (socket !== current) return;
      stopKeepalive();
      socket = undefined;
      if (!closing && !reconnectTimer) {
        const { delay } = reconnectBackoff.next();
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, delay);
      }
    });
  }

  function sendSubscription(target = socket, replaySince: string | undefined = undefined) {
    if (!target || target.readyState !== WebSocket.OPEN) return;
    const instanceId = toValue(input.instanceId || "");
    const messageDeltaDemand = aiSessionMessageDeltaDemand.value;
    const scopedMessageDeltaDemanded = Boolean(instanceId) && (
      messageDeltaDemand.allInstances || messageDeltaDemand.instanceIds.includes(instanceId)
    );
    target.send(JSON.stringify({
      v: 1,
      type: "subscribe",
      eventEnvelopeVersion: COMPACT_EVENT_ENVELOPE_VERSION,
      topics: ["*"],
      ...(instanceId ? { instanceIds: [instanceId] } : {}),
      ...(input.resourceMetrics ? { metricInstanceIds: toValue(input.resourceMetricInstanceIds || []) } : {}),
      aiSessionTransient: {
        ...(replaySince ? { replaySince } : {}),
        messageDeltas: instanceId
          ? { allInstances: false, instanceIds: scopedMessageDeltaDemanded ? [instanceId] : [] }
          : messageDeltaDemand,
        timelineAllSessions: false,
        timelineSessions: aiSessionTimelineDemand.value.filter((entry) => !instanceId || entry.instanceId === instanceId),
      },
    }));
  }

  function startKeepalive(target: WebSocket) {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      if (socket !== target || target.readyState !== WebSocket.OPEN) return;
      target.send(JSON.stringify({ v: 1, type: "ping", sentAt: new Date().toISOString() }));
    }, 20_000);
  }

  function stopKeepalive() {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  }

  function handleMessage(raw: string) {
    try {
      const message = JSON.parse(raw) as EventMessage;
      if (EventKeepalivePongSchema.safeParse(message).success) return;
      const instanceId = toValue(input.instanceId || "");
      if (message.type === SessionStreamsHelloEventType) {
        const parsed = safeParseResponse(SessionStreamsHelloSchema, message.payload);
        if (!parsed.success) {
          closing = true;
          console.error("SESSION_STREAM_PROTOCOL_INCOMPATIBLE", parsed.error.issues);
          socket?.close(1002, "Incompatible session stream protocol.");
          return;
        }
        const hello = parsed.data;
        // Transport open is not recovery: reset only after the authoritative
        // session-stream handshake succeeds.
        reconnectBackoff.reset();
        for (const descriptor of hello.streams.filter((stream) => !instanceId || stream.instanceId === instanceId)) {
          if (descriptor.topic === "app.sessions") void input.appSessions.recoverDescriptor(descriptor);
          if (descriptor.topic === "ai.sessions") void input.aiSessions.recoverDescriptor(descriptor);
        }
        return;
      }
      const events = normalizedEvents(message).filter((event) => !instanceId || !eventInstanceId(event) || eventInstanceId(event) === instanceId);
      const handled = events.some(applyToCache);
      if (!handled) scheduleTargetedInvalidation(events);
    } catch (error) {
      console.warn("CONTROL_PLANE_EVENT_INVALID", error);
    }
  }

  function applyToCache(event: EventMessage) {
    if (event.type && LIFECYCLE_COMMAND_NOTIFICATIONS.has(event.type)) {
      return true;
    }
    if (event.type?.startsWith("instance.ai-session.") || event.type?.startsWith("instance.app-session.")) {
      // These are operation receipts, not instance resource mutations. AI/App
      // Session stream events own the resulting state; treating the receipts as
      // `instances` invalidations refetches the board after every session action.
      return true;
    }
    if (event.type === "trigger.deployment.bound") {
      const bound = safeParseResponse(ControlPlaneAiSessionTriggerBoundEventSchema, event.payload);
      if (!bound.success) return false;
      if (bound.data.mutation) {
        upsertInstanceTriggerBinding(queryClient, bound.data.instanceId, bound.data.mutation as InstanceTriggerMutationResult);
      } else {
        // Compatibility for v0.0.23: recover the authoritative instance
        // trigger snapshot when the event predates embedded mutation results.
        void recoverInstanceTriggers(bound.data.instanceId);
      }
      queueInvalidation(["control-plane-triggers"]);
      return true;
    }
    if (event.type === "trigger.deployment.unbound") {
      const unbound = safeParseResponse(ControlPlaneAiSessionTriggerUnboundEventSchema, event.payload);
      if (!unbound.success) return false;
      removeInstanceTriggerBinding(queryClient, unbound.data.instanceId, unbound.data.sessionId, unbound.data.configHash);
      queueInvalidation(["control-plane-triggers"]);
      return true;
    }
    if (event.type?.startsWith("trigger.") && eventInstanceId(event)) {
      void recoverInstanceTriggers(eventInstanceId(event)!);
      queueInvalidation(["control-plane-triggers"]);
      return true;
    }
    if (event.type?.startsWith("image.pull.")) {
      return input.imagePullProgress?.applyEvent(event.type, event.payload) || false;
    }
    if (event.type === AiSessionEventType.MessageDelta) {
      if (event.id && seenTransientEventIds.has(event.id)) return true;
      if (event.id) rememberTransientEventId(event.id);
      return input.aiSessions.applyMessageDelta(event.payload as AiSessionMessageDeltaEvent, { replay: event.replay });
    }
    if (event.type === AiSessionEventType.TimelineItem) {
      if (event.id && seenTransientEventIds.has(event.id)) return true;
      if (event.id) rememberTransientEventId(event.id);
      const item = safeParseResponse(AiSessionTimelineItemEventSchema, event.payload);
      return item.success ? input.aiSessions.applyTimelineItem(item.data) : false;
    }
    if (event.type === AiSessionUnreadEventType.Updated) {
      const state = safeParseResponse(AiSessionUnreadStateSchema, event.payload);
      if (!state.success || event.scope?.instanceId !== state.data.instanceId) return false;
      return input.aiSessions.applyUnreadEvent(state.data);
    }
    if (event.type === AiSessionEventType.Snapshot || event.type === AiSessionEventType.Patch || event.type === AiSessionEventType.Removed) {
      return input.aiSessions.applyEvent({ type: event.type, payload: event.payload } as AiSessionDeltaResponse["events"][number]);
    }
    if (event.type === AppSessionEventType.Snapshot || event.type === AppSessionEventType.Patch || event.type === AppSessionEventType.Removed) {
      return input.appSessions.applyEvent({ type: event.type, payload: event.payload } as AppSessionDeltaResponse["events"][number]);
    }
    if (event.type === "app.management" && event.scope?.instanceId && event.payload && typeof event.payload === "object") {
      return input.appManagement?.applyEvent(event.scope.instanceId, event.payload as AppManagementEvent) || false;
    }
    if (event.type === InstanceResourceMetricsEventType.Snapshot && event.payload && typeof event.payload === "object") {
      const metrics = safeParseResponse(InstanceResourceMetricsSchema, event.payload);
      if (!metrics.success || event.scope?.instanceId !== metrics.data.instanceId) return false;
      return input.resourceMetrics?.applyEvent(metrics.data) || false;
    }
    if (event.type === InstanceLifecycleEventType.Snapshot) {
      const lifecycle = safeParseResponse(InstanceLifecycleSnapshotSchema, event.payload);
      if (!lifecycle.success || event.scope?.instanceId !== lifecycle.data.instanceId) return false;
      input.imagePullProgress?.reconcileLifecycle?.(lifecycle.data);
      return applyInstanceLifecycle(queryClient, lifecycle.data);
    }
    if (event.type === "node.connection.updated" || event.type === "node.proxy-state.updated") {
      const state = safeParseResponse(NodeStateProjectionEventSchema, event.payload);
      // Compatibility for v0.0.23: older producers send internal observation
      // payloads. Returning false preserves the authoritative query fallback.
      return state.success ? applyNodeStateProjection(queryClient, state.data) : false;
    }
    if (event.type === "node.fleet.updated") {
      const state = safeParseResponse(ControlPlaneNodeFleetUpdatedEventSchema, event.payload);
      if (!state.success) return false;
      // Diagnostic-only fleet changes can be applied in place. The gateway is
      // the only boundary that can compare the old and new resource projection;
      // when it reports a semantic content change, recover the authoritative
      // topic query instead of pretending this metadata-only event contains rows.
      applyNodeFleetState(queryClient, state.data);
      // Compatibility for v0.0.23: absence means the old producer could not
      // distinguish diagnostic churn from a resource change, so recover the
      // authoritative topic. Current producers explicitly send false.
      return state.data.contentChanged === false;
    }
    if (event.type === "node.joined") {
      const joined = safeParseResponse(NodeJoinedEventSchema, event.payload);
      if (!joined.success) return false;
      input.nodes?.joined(joined.data);
      return false;
    }
    return false;
  }

  async function recoverInstanceTriggers(instanceId: string) {
    try {
      replaceInstanceTriggerSnapshot(queryClient, instanceId, await getControlledInstanceTriggers(instanceId));
    } catch (error) {
      console.warn("CONTROL_PLANE_TRIGGER_RECOVERY_FAILED", { instanceId, error });
    }
  }

  function cachedInstanceIds(scopeInstanceId: string) {
    const ids = new Set<string>();
    for (const [, payload] of queryClient.getQueriesData<InstanceBoardPayload>({ queryKey: controlPlaneQueryKeys.instanceBoard })) {
      for (const instance of payload?.data || []) {
        if (!scopeInstanceId || instance.id === scopeInstanceId) ids.add(instance.id);
      }
    }
    return ids;
  }

  function rememberTransientEventId(id: string) {
    seenTransientEventIds.delete(id);
    seenTransientEventIds.add(id);
    while (seenTransientEventIds.size > 10_000) seenTransientEventIds.delete(seenTransientEventIds.values().next().value!);
  }

  function scheduleTargetedInvalidation(events: EventMessage[]) {
    const topics = new Set(events.map((event) => event.topic).filter(Boolean));
    if (topics.has("triggers")) queueInvalidation(["control-plane-triggers"]);
    for (const queryKey of controlPlaneDomainQueryKeys(controlPlaneEventDomains(events))) queueInvalidation(queryKey);
  }

  function queueInvalidation(queryKey: readonly unknown[]) {
    pendingInvalidationKeys.set(JSON.stringify(queryKey), queryKey);
    if (invalidationTimer) return;
    invalidationTimer = setTimeout(() => {
      invalidationTimer = undefined;
      const keys = [...pendingInvalidationKeys.values()];
      pendingInvalidationKeys.clear();
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    }, 100);
  }

  onMounted(connect);
  watch(() => input.enabled === undefined || toValue(input.enabled), (enabled) => {
    if (enabled) {
      connect();
      return;
    }
    closing = true;
    socket?.close();
    socket = undefined;
    stopKeepalive();
  });
  watch(() => toValue(input.instanceId || ""), () => {
    if (!socket) return;
    closing = true;
    stopKeepalive();
    socket.close();
    socket = undefined;
    closing = false;
    connect();
  });
  watch([aiSessionMessageDeltaDemand, aiSessionTimelineDemand, aiSessionTransientReplaySince], () => {
    const replaySince = aiSessionTransientReplaySince.value;
    sendSubscription(socket, replaySince);
    // Timeline/detail queries establish their own authoritative snapshot before
    // consuming replayed transient events. Reconnect recovery is descriptor-
    // driven, so expanding transient demand must not refetch the full AI Session
    // list for every card selection.
  }, { deep: false });
  watch(() => JSON.stringify(toValue(input.resourceMetricInstanceIds || [])), () => {
    // Metrics scope is independent from AI transient replay. Re-sending an old
    // replay cursor here would incorrectly retrigger the HTTP recovery barrier.
    sendSubscription(socket);
  });
  onBeforeUnmount(() => {
    closing = true;
    reconnectBackoff.reset();
    socket?.close();
    socket = undefined;
    stopKeepalive();
    if (invalidationTimer) clearTimeout(invalidationTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
}

function eventsUrl(instanceId = "") {
  const url = new URL("/api/events", window.location.origin);
  url.searchParams.set("aiSessionTransient", "1");
  url.searchParams.set("resourceMetricsScope", "1");
  if (instanceId) url.searchParams.set("instanceId", instanceId);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function normalizedEvents(message: EventMessage): EventMessage[] {
  const candidate = message.type === "node-agent.event.forwarded" ? message.event : message;
  const normalized = normalizeEventEnvelope(candidate, message.scope);
  if (!normalized) return [];
  const instanceId = normalized.scope?.instanceId;
  if (normalized.type === ProtocolAiSessionEventType.MessageDelta && instanceId) {
    try {
      normalized.payload = normalizeAiSessionMessageDeltaEvent(normalized.payload, instanceId);
    } catch {
      return [];
    }
  }
  return [normalized];
}

function eventInstanceId(event: EventMessage) {
  if (event.scope?.instanceId) return event.scope.instanceId;
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const instanceId = (event.payload as { instanceId?: unknown }).instanceId;
    return typeof instanceId === "string" ? instanceId : undefined;
  }
  return undefined;
}
