import { onBeforeUnmount, onMounted, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";
import { SessionStreamsHelloEventType, SessionStreamsHelloSchema } from "@task-handoff/protocol/events";
import {
  InstanceLifecycleEventType,
  InstanceLifecycleSnapshotSchema,
  InstanceResourceMetricsEventType,
  InstanceResourceMetricsSchema,
  NodeJoinedEventSchema,
  type InstanceLifecycleSnapshot,
  type NodeJoinedEvent,
} from "@task-handoff/protocol/control-plane";
import { AiSessionTimelineItemEventSchema, AiSessionUnreadEventType, AiSessionUnreadStateSchema, type AiSessionTimelineItemEvent, type AiSessionUnreadState } from "@task-handoff/protocol/ai-sessions";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";
import type { SessionStreamDescriptor } from "@task-handoff/protocol/events";
import type { AppManagementEvent } from "../../api/types";
import type { InstanceResourceMetrics } from "../../api/types";
import { controlPlaneQueryKeys } from "../../api/queryKeys.ts";
import { controlPlaneDomainQueryKeys } from "../../api/queryInvalidation.ts";
import { applyInstanceLifecycle } from "./instanceLifecycleCache.ts";
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
      void queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.scopedInstanceBoard(toValue(input.instanceId || "")) });
      void input.appManagement?.recoverOpen();
      void input.resourceMetrics?.recoverOpen();
      if (recovering) input.aiSessions.recoverTimelineItems();
    });
    current.addEventListener("message", (event) => handleMessage(String(event.data)));
    current.addEventListener("close", () => {
      if (socket !== current) return;
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

  function sendSubscription(target = socket, replaySince = aiSessionTransientReplaySince.value) {
    if (!target || target.readyState !== WebSocket.OPEN) return;
    const instanceId = toValue(input.instanceId || "");
    const messageDeltaDemand = aiSessionMessageDeltaDemand.value;
    const scopedMessageDeltaDemanded = Boolean(instanceId) && (
      messageDeltaDemand.allInstances || messageDeltaDemand.instanceIds.includes(instanceId)
    );
    target.send(JSON.stringify({
      v: 1,
      type: "subscribe",
      topics: ["*"],
      ...(instanceId ? { instanceIds: [instanceId] } : {}),
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

  function handleMessage(raw: string) {
    try {
      const message = JSON.parse(raw) as EventMessage;
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
    if (event.type === "node.joined") {
      const joined = safeParseResponse(NodeJoinedEventSchema, event.payload);
      if (!joined.success) return false;
      input.nodes?.joined(joined.data);
      return false;
    }
    return false;
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
  });
  watch(() => toValue(input.instanceId || ""), () => {
    if (!socket) return;
    closing = true;
    socket.close();
    socket = undefined;
    closing = false;
    connect();
  });
  watch([aiSessionMessageDeltaDemand, aiSessionTimelineDemand, aiSessionTransientReplaySince], () => {
    const replaySince = aiSessionTransientReplaySince.value;
    sendSubscription(socket, replaySince);
    // Establish the authoritative half of the snapshot/replay barrier. Events
    // produced after replaySince are recovered by the source replay below it.
    if (replaySince) {
      void queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.scopedInstanceBoard(toValue(input.instanceId || "")) });
    }
  }, { deep: false });
  onBeforeUnmount(() => {
    closing = true;
    reconnectBackoff.reset();
    socket?.close();
    socket = undefined;
    if (invalidationTimer) clearTimeout(invalidationTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
}

function eventsUrl(instanceId = "") {
  const url = new URL("/api/events", window.location.origin);
  url.searchParams.set("aiSessionTransient", "1");
  if (instanceId) url.searchParams.set("instanceId", instanceId);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function normalizedEvents(message: EventMessage): EventMessage[] {
  if (message.type !== "node-agent.event.forwarded") return [message];
  const forwarded = message.event && typeof message.event === "object" && !Array.isArray(message.event)
    ? message.event as EventMessage
    : undefined;
  if (!forwarded?.type) return [];
  return [{ ...forwarded, scope: { ...(message.scope || {}), ...(forwarded.scope || {}) } }];
}

function eventInstanceId(event: EventMessage) {
  if (event.scope?.instanceId) return event.scope.instanceId;
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const instanceId = (event.payload as { instanceId?: unknown }).instanceId;
    return typeof instanceId === "string" ? instanceId : undefined;
  }
  return undefined;
}
