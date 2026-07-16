import { onBeforeUnmount, onMounted } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { SessionStreamsHelloEventType, SessionStreamsHelloSchema } from "@task-handoff/protocol/events";
import type { SessionStreamDescriptor } from "@task-handoff/protocol/events";
import type { AppManagementEvent } from "../../api/types";
import {
  AiSessionEventType,
  AppSessionEventType,
  type AiSessionDeltaResponse,
  type AppSessionDeltaResponse,
} from "../../api/types";

type EventMessage = {
  type?: string;
  topic?: string;
  payload?: unknown;
  event?: unknown;
  scope?: { instanceId?: string; nodeId?: string; [key: string]: unknown };
};

export function useControlPlaneEvents(input: {
  aiSessions: {
    applyEvent: (event: AiSessionDeltaResponse["events"][number]) => boolean;
    recoverDescriptor: (descriptor: SessionStreamDescriptor) => Promise<void>;
  };
  appSessions: {
    applyEvent: (event: AppSessionDeltaResponse["events"][number]) => boolean;
    recoverDescriptor: (descriptor: SessionStreamDescriptor) => Promise<void>;
  };
  isRefreshing: () => boolean;
  refresh: () => Promise<void>;
  appManagement?: {
    applyEvent: (instanceId: string, event: AppManagementEvent) => boolean;
    recoverOpen: () => void | Promise<void>;
  };
}) {
  const queryClient = useQueryClient();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
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
      void input.appManagement?.recoverOpen();
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
      if (message.type && !handled) scheduleRefresh();
    } catch {
      scheduleRefresh();
    }
  }

  function applyToCache(event: EventMessage) {
    if (event.type === AiSessionEventType.Snapshot || event.type === AiSessionEventType.Patch || event.type === AiSessionEventType.Removed) {
      return input.aiSessions.applyEvent({ type: event.type, payload: event.payload } as AiSessionDeltaResponse["events"][number]);
    }
    if (event.type === AppSessionEventType.Snapshot || event.type === AppSessionEventType.Patch || event.type === AppSessionEventType.Removed) {
      return input.appSessions.applyEvent({ type: event.type, payload: event.payload } as AppSessionDeltaResponse["events"][number]);
    }
    if (event.type === "app.management" && event.scope?.instanceId && event.payload && typeof event.payload === "object") {
      return input.appManagement?.applyEvent(event.scope.instanceId, event.payload as AppManagementEvent) || false;
    }
    return false;
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (input.isRefreshing()) {
        scheduleRefresh();
        return;
      }
      void input.refresh();
    }, 100);
  }

  onMounted(connect);
  onBeforeUnmount(() => {
    closing = true;
    reconnectAttempt = 0;
    socket?.close();
    socket = undefined;
    if (refreshTimer) clearTimeout(refreshTimer);
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
