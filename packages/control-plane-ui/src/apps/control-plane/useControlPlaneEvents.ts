import { onBeforeUnmount, onMounted } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { SessionStreamsHelloEventType, SessionStreamsHelloSchema } from "@task-handoff/protocol/events";
import {
  InstanceLifecycleEventType,
  InstanceLifecycleSnapshotSchema,
  InstanceResourceMetricsEventType,
  InstanceResourceMetricsSchema,
} from "@task-handoff/protocol/control-plane";
import { AiSessionUnreadEventType, AiSessionUnreadStateSchema, type AiSessionUnreadState } from "@task-handoff/protocol/ai-sessions";
import type { SessionStreamDescriptor } from "@task-handoff/protocol/events";
import type { AppManagementEvent } from "../../api/types";
import type { InstanceResourceMetrics } from "../../api/types";
import { applyInstanceLifecycle } from "./instanceLifecycleCache.ts";
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
  aiSessions: {
    applyEvent: (event: AiSessionDeltaResponse["events"][number]) => boolean;
    applyUnreadEvent: (state: AiSessionUnreadState) => boolean;
    applyMessageDelta: (payload: AiSessionMessageDeltaEvent) => boolean;
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
}) {
  const queryClient = useQueryClient();
  const pendingInvalidationKeys = new Map<string, readonly unknown[]>();
  let invalidationTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | undefined;
  let closing = false;
  let reconnectAttempt = 0;

  function connect() {
    if (socket && socket.readyState !== WebSocket.CLOSED) return;
    closing = false;
    const current = new WebSocket(eventsUrl());
    socket = current;
    current.addEventListener("open", () => {
      reconnectAttempt = 0;
      void queryClient.invalidateQueries({ queryKey: ["instance-board"] });
      void queryClient.invalidateQueries({ queryKey: ["instance-board-payload"] });
      void input.appManagement?.recoverOpen();
      void input.resourceMetrics?.recoverOpen();
    });
    current.addEventListener("message", (event) => handleMessage(String(event.data)));
    current.addEventListener("close", () => {
      if (socket === current) socket = undefined;
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
      if (message.type === SessionStreamsHelloEventType) {
        const parsed = SessionStreamsHelloSchema.safeParse(message.payload);
        if (!parsed.success) {
          closing = true;
          console.error("SESSION_STREAM_PROTOCOL_INCOMPATIBLE", parsed.error.issues);
          socket?.close(1002, "Incompatible session stream protocol.");
          return;
        }
        const hello = parsed.data;
        for (const descriptor of hello.streams) {
          if (descriptor.topic === "app.sessions") void input.appSessions.recoverDescriptor(descriptor);
          if (descriptor.topic === "ai.sessions") void input.aiSessions.recoverDescriptor(descriptor);
        }
        return;
      }
      const handled = normalizedEvents(message).some(applyToCache);
      if (!handled) scheduleTargetedInvalidation(normalizedEvents(message));
    } catch (error) {
      console.warn("CONTROL_PLANE_EVENT_INVALID", error);
    }
  }

  function applyToCache(event: EventMessage) {
    if (event.type && LIFECYCLE_COMMAND_NOTIFICATIONS.has(event.type)) {
      return true;
    }
    if (event.type === AiSessionEventType.MessageDelta) {
      return input.aiSessions.applyMessageDelta(event.payload as AiSessionMessageDeltaEvent);
    }
    if (event.type === AiSessionUnreadEventType.Updated) {
      const state = AiSessionUnreadStateSchema.safeParse(event.payload);
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
      const metrics = InstanceResourceMetricsSchema.safeParse(event.payload);
      if (!metrics.success || event.scope?.instanceId !== metrics.data.instanceId) return false;
      return input.resourceMetrics?.applyEvent(metrics.data) || false;
    }
    if (event.type === InstanceLifecycleEventType.Snapshot) {
      const lifecycle = InstanceLifecycleSnapshotSchema.safeParse(event.payload);
      if (!lifecycle.success || event.scope?.instanceId !== lifecycle.data.instanceId) return false;
      return applyInstanceLifecycle(queryClient, lifecycle.data);
    }
    return false;
  }

  function scheduleTargetedInvalidation(events: EventMessage[]) {
    const topics = new Set(events.map((event) => event.topic).filter(Boolean));
    if (topics.has("triggers")) queueInvalidation(["control-plane-triggers"]);
    if (topics.has("nodes")) {
      queueInvalidation(["control-plane-nodes"]);
      queueInvalidation(["control-plane-node-runtimes"]);
      queueInvalidation(["instance-board"]);
    }
    if (topics.has("instances")) queueInvalidation(["instance-board"]);
    if (topics.has("projects")) {
      queueInvalidation(["control-plane-projects"]);
      queueInvalidation(["instance-board"]);
    }
    if (topics.has("models")) queueInvalidation(["control-plane-models"]);
    if (topics.has("images")) {
      queueInvalidation(["control-plane-images"]);
      queueInvalidation(["instance-board"]);
    }
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
  onBeforeUnmount(() => {
    closing = true;
    reconnectAttempt = 0;
    socket?.close();
    socket = undefined;
    if (invalidationTimer) clearTimeout(invalidationTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
}

function eventsUrl() {
  const url = new URL("/api/events", window.location.origin);
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
