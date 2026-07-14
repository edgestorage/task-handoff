import { defineStore } from "pinia";
import type { QueryClient } from "@tanstack/vue-query";
import {
  AiSessionDeltaResponseSchema,
  AiSessionEventType,
  applyAiSessionStreamEvent,
  type AiSessionDeltaResponse,
  type AiSessionStreamEvent,
  type AiSessionsState,
} from "@task-handoff/protocol/ai-sessions";
import {
  AppSessionDeltaResponseSchema,
  AppSessionEventType,
  applyAppSessionStreamEvent,
  type AppSessionDeltaResponse,
  type AppSessionStreamEvent,
  type AppSessionsState,
} from "@task-handoff/protocol/app-sessions";
import {
  SessionStreamsHelloEventType,
  SessionStreamsHelloSchema,
  type SessionStreamDescriptor,
  type SessionStreamTopic,
} from "@task-handoff/protocol/events";
import { publicWebSocketUrl } from "../api/base";
import { getApiData } from "../api/client";
import type { AiSessionsSnapshot, AppSession } from "../api/types";
import { useAuthStore } from "./auth";

export type WebEvent = {
  id: string;
  type: string;
  createdAt: string;
  payload: unknown;
};

type ConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";
type RecoveryState = "disconnected" | "recovering" | "live";

let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let intentionalClose = false;
let incompatibleProtocol = false;
let aiProjection: AiSessionsState | undefined;
let appProjection: AppSessionsState | undefined;
const advertised = new Map<SessionStreamTopic, SessionStreamDescriptor>();
const recovering = new Map<SessionStreamTopic, Promise<void>>();
const recoveryHighWater = new Map<SessionStreamTopic, { streamId: string; revision: number }>();
let sessionApiLoader: <T>(path: string) => Promise<T> = getApiData;

function eventUrl(token: string) {
  return publicWebSocketUrl("/api/events", token);
}

function queryKeysForEvent(type: string) {
  if (type.startsWith("trigger.")) return [["triggers"], ["status"]];
  return [];
}

function writeAiProjection(queryClient: QueryClient, projection: AiSessionsState) {
  aiProjection = projection;
  queryClient.setQueryData<AiSessionsSnapshot>(["ai-sessions"], projection.snapshot);
  for (const session of projection.snapshot.sessions) queryClient.setQueryData(["ai-session", session.id], session);
}

function writeAppProjection(queryClient: QueryClient, projection: AppSessionsState) {
  appProjection = projection;
  queryClient.setQueryData<AppSession[]>(["app-sessions"], projection.snapshot.sessions as unknown as AppSession[]);
}

function eventStreamPosition(event: WebEvent) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta as Record<string, unknown> : {};
  return {
    streamId: typeof meta.streamId === "string" ? meta.streamId : "",
    revision: typeof meta.revision === "number" ? meta.revision : 0,
  };
}

function raiseRecoveryHighWater(topic: SessionStreamTopic, event: WebEvent) {
  const descriptor = advertised.get(topic);
  const position = eventStreamPosition(event);
  if (!descriptor || position.streamId !== descriptor.streamId) return;
  const current = recoveryHighWater.get(topic);
  recoveryHighWater.set(topic, {
    streamId: descriptor.streamId,
    revision: Math.max(current?.streamId === descriptor.streamId ? current.revision : 0, position.revision),
  });
}

export function applyDomainEvent(queryClient: QueryClient, event: WebEvent) {
  if (event.type === AiSessionEventType.Snapshot || event.type === AiSessionEventType.Patch || event.type === AiSessionEventType.Removed) {
    if (recovering.has("ai.sessions")) {
      raiseRecoveryHighWater("ai.sessions", event);
      return true;
    }
    const result = applyAiSessionStreamEvent(aiProjection, { type: event.type, payload: event.payload } as AiSessionStreamEvent);
    if (result.kind === "applied") writeAiProjection(queryClient, result.projection);
    if (result.kind === "gap" || result.kind === "snapshot-required") void recoverStream("ai.sessions", queryClient);
    return true;
  }
  if (event.type === AppSessionEventType.Snapshot || event.type === AppSessionEventType.Patch || event.type === AppSessionEventType.Removed) {
    if (recovering.has("app.sessions")) {
      raiseRecoveryHighWater("app.sessions", event);
      return true;
    }
    const result = applyAppSessionStreamEvent(appProjection, { type: event.type, payload: event.payload } as AppSessionStreamEvent);
    if (result.kind === "applied") writeAppProjection(queryClient, result.projection);
    if (result.kind === "gap" || result.kind === "snapshot-required") void recoverStream("app.sessions", queryClient);
    return true;
  }
  return false;
}

async function loadSnapshot(topic: SessionStreamTopic, queryClient: QueryClient) {
  if (topic === "ai.sessions") {
    const state = await sessionApiLoader<AiSessionsState>("ai-sessions");
    writeAiProjection(queryClient, state);
    return state.revision;
  }
  const state = await sessionApiLoader<AppSessionsState>("apps/sessions");
  writeAppProjection(queryClient, state);
  return state.revision;
}

async function recoverDelta(topic: SessionStreamTopic, descriptor: SessionStreamDescriptor, queryClient: QueryClient) {
  if (topic === "ai.sessions" && aiProjection?.streamId === descriptor.streamId) {
    const delta = AiSessionDeltaResponseSchema.parse(await sessionApiLoader<AiSessionDeltaResponse>(`ai-sessions?streamId=${encodeURIComponent(descriptor.streamId)}&sinceRevision=${aiProjection.revision}`));
    if (delta.syncRequired) return loadSnapshot(topic, queryClient);
    for (const event of delta.events) {
      const result = applyAiSessionStreamEvent(aiProjection, event);
      if (result.kind !== "applied" && result.kind !== "duplicate") return loadSnapshot(topic, queryClient);
      writeAiProjection(queryClient, result.projection);
    }
    return aiProjection?.revision || 0;
  }
  if (topic === "app.sessions" && appProjection?.streamId === descriptor.streamId) {
    const delta = AppSessionDeltaResponseSchema.parse(await sessionApiLoader<AppSessionDeltaResponse>(`apps/sessions?streamId=${encodeURIComponent(descriptor.streamId)}&sinceRevision=${appProjection.revision}`));
    if (delta.syncRequired) return loadSnapshot(topic, queryClient);
    for (const event of delta.events) {
      const result = applyAppSessionStreamEvent(appProjection, event);
      if (result.kind !== "applied" && result.kind !== "duplicate") return loadSnapshot(topic, queryClient);
      writeAppProjection(queryClient, result.projection);
    }
    return appProjection?.revision || 0;
  }
  return loadSnapshot(topic, queryClient);
}

export function recoverStream(topic: SessionStreamTopic, queryClient: QueryClient) {
  const current = recovering.get(topic);
  if (current) return current;
  const recovery = Promise.resolve().then(async () => {
    try {
      while (true) {
        const descriptor = advertised.get(topic);
        if (!descriptor) return;
        const projection = topic === "ai.sessions" ? aiProjection : appProjection;
        const highWater = recoveryHighWater.get(topic);
        const targetRevision = Math.max(descriptor.latestRevision, highWater?.streamId === descriptor.streamId ? highWater.revision : 0);
        if (projection?.streamId === descriptor.streamId && projection.revision >= targetRevision) {
          if (recoveryHighWater.get(topic)?.streamId === descriptor.streamId) recoveryHighWater.delete(topic);
          return;
        }
        await recoverDelta(topic, descriptor, queryClient);
      }
    } finally {
      recovering.delete(topic);
    }
  });
  recovering.set(topic, recovery);
  return recovery;
}

export function advertiseSessionStream(descriptor: SessionStreamDescriptor, queryClient: QueryClient) {
  const previous = advertised.get(descriptor.topic);
  if (previous && previous.streamId !== descriptor.streamId) recoveryHighWater.delete(descriptor.topic);
  advertised.set(descriptor.topic, descriptor);
  return recoverStream(descriptor.topic, queryClient);
}

export function configureSessionStreamApiLoader(loader: <T>(path: string) => Promise<T>) {
  sessionApiLoader = loader;
}

export function resetSessionStreamRuntime() {
  aiProjection = undefined;
  appProjection = undefined;
  advertised.clear();
  recovering.clear();
  recoveryHighWater.clear();
  sessionApiLoader = getApiData;
}

export function sessionStreamRuntimeState() {
  return {
    aiProjection,
    appProjection,
    recovering: [...recovering.keys()],
  };
}

export const useEventsStore = defineStore("events", {
  state: () => ({
    connectionState: "idle" as ConnectionState,
    streamStates: { "ai.sessions": "disconnected", "app.sessions": "disconnected" } as Record<SessionStreamTopic, RecoveryState>,
    reconnects: 0,
    lastEventAt: "",
    events: [] as WebEvent[],
  }),
  actions: {
    connect(queryClient?: QueryClient) {
      if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
      clearTimeout(reconnectTimer);
      this.connectionState = "connecting";
      const auth = useAuthStore();
      socket = new WebSocket(eventUrl(auth.token));
      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        this.connectionState = "connected";
      });
      socket.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(String(message.data)) as WebEvent;
          this.lastEventAt = event.createdAt;
          this.events = [event, ...this.events].slice(0, 50);
          if (event.type === SessionStreamsHelloEventType && queryClient) {
            const parsed = SessionStreamsHelloSchema.safeParse(event.payload);
            if (!parsed.success) {
              incompatibleProtocol = true;
              this.connectionState = "error";
              console.error("SESSION_STREAM_PROTOCOL_INCOMPATIBLE", parsed.error.issues);
              socket?.close(1002, "Incompatible session stream protocol.");
              return;
            }
            const hello = parsed.data;
            for (const descriptor of hello.streams) {
              this.streamStates[descriptor.topic] = "recovering";
              void advertiseSessionStream(descriptor, queryClient).then(() => { this.streamStates[descriptor.topic] = "live"; });
            }
            return;
          }
          if (queryClient && applyDomainEvent(queryClient, event)) return;
          for (const queryKey of queryKeysForEvent(event.type)) void queryClient?.invalidateQueries({ queryKey });
        } catch {
          this.connectionState = "error";
        }
      });
      socket.addEventListener("close", () => {
        this.streamStates["ai.sessions"] = "disconnected";
        this.streamStates["app.sessions"] = "disconnected";
        if (intentionalClose || incompatibleProtocol) {
          intentionalClose = false;
          this.connectionState = incompatibleProtocol ? "error" : "idle";
          return;
        }
        this.connectionState = "disconnected";
        this.scheduleReconnect(queryClient);
      });
      socket.addEventListener("error", () => { this.connectionState = "error"; });
    },
    disconnect() {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (socket) {
        intentionalClose = true;
        socket.close();
      } else {
        intentionalClose = false;
      }
      socket = undefined;
      advertised.clear();
      incompatibleProtocol = false;
      reconnectAttempt = 0;
      this.connectionState = "idle";
    },
    scheduleReconnect(queryClient?: QueryClient) {
      clearTimeout(reconnectTimer);
      const baseDelay = Math.min(30_000, 1_000 * (2 ** reconnectAttempt));
      const delay = Math.min(30_000, Math.round(baseDelay * (0.75 + Math.random() * 0.5)));
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        this.reconnects += 1;
        socket = undefined;
        this.connect(queryClient);
      }, delay);
    },
  },
});
