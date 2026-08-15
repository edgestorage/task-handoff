import { onBeforeUnmount, onMounted, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { SessionStreamsHelloEventType, SessionStreamsHelloSchema } from "@task-handoff/protocol/events";
import {
  InstanceLifecycleEventType,
  InstanceLifecycleSnapshotSchema,
  InstanceResourceMetricsEventType,
  InstanceResourceMetricsSchema,
  type InstanceLifecycleSnapshot,
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
import {
  AiSessionEventType,
  AppSessionEventType,
  type AiSessionDeltaResponse,
  type AiSessionMessageDeltaEvent,
  type AppSessionDeltaResponse,
} from "../../api/types";

type EventMessage = {
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
    applyMessageDelta: (payload: AiSessionMessageDeltaEvent) => boolean;
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
}) {
  const queryClient = useQueryClient();
  const pendingInvalidationKeys = new Map<string, readonly unknown[]>();
  let invalidationTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | undefined;
  let closing = false;
  let reconnectAttempt = 0;
  let hasOpened = false;

  function connect() {
    if (input.enabled !== undefined && !toValue(input.enabled)) return;
    if (socket && socket.readyState !== WebSocket.CLOSED) return;
    closing = false;
    const current = new WebSocket(eventsUrl(toValue(input.instanceId || "")));
    socket = current;
    current.addEventListener("open", () => {
      const recovering = hasOpened;
      hasOpened = true;
      reconnectAttempt = 0;
      const instanceId = toValue(input.instanceId || "");
      current.send(JSON.stringify({ type: "subscribe", topics: ["*"], ...(instanceId ? { instanceIds: [instanceId] } : {}) }));
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
        const baseDelay = Math.min(30_000, 1_000 * (2 ** reconnectAttempt));
        const delay = Math.min(30_000, Math.round(baseDelay * (0.75 + Math.random() * 0.5)));
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, delay);
      }
    });
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
      return input.aiSessions.applyMessageDelta(event.payload as AiSessionMessageDeltaEvent);
    }
    if (event.type === AiSessionEventType.TimelineItem) {
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
    return false;
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
  onBeforeUnmount(() => {
    closing = true;
    reconnectAttempt = 0;
    socket?.close();
    socket = undefined;
    if (invalidationTimer) clearTimeout(invalidationTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
}

function eventsUrl(instanceId = "") {
  const url = new URL("/api/events", window.location.origin);
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
