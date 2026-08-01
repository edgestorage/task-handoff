import { ControlPlaneProxyErrorCode } from "@task-handoff/protocol/control-plane-proxy";
import type { NodeAgentWebSocket } from "../nodes/client.ts";

export type NodeProxyRuntimeLimits = {
  maxConcurrentHttpPerBinding?: number;
  maxConcurrentStreamsPerBinding?: number;
  maxHttpRequestsPerMinutePerBinding?: number;
  maxConcurrentWebSocketsPerBinding?: number;
  maxRequestBodyBytes?: number;
  maxHttpResponseBytes?: number;
  httpStreamIdleTimeoutMs?: number;
  maxWebSocketFrameBytes?: number;
  maxWebSocketBytes?: number;
  webSocketIdleTimeoutMs?: number;
  httpRequestWindowMs?: number;
};

type BindingActivity = {
  controllers: Set<AbortController>;
  streams: Set<AbortController>;
  sockets: Set<NodeAgentWebSocket>;
  cleanup: Set<() => void>;
};

export class NodeProxyRuntimeError extends Error {
  readonly statusCode = 429;
  readonly code = ControlPlaneProxyErrorCode.ResourceLimit;
  readonly retryable = true;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "NodeProxyRuntimeError";
    this.details = details;
  }
}

export class ControlPlaneNodeProxyRuntime {
  readonly maxRequestBodyBytes: number;
  private readonly maxConcurrentHttpPerBinding: number;
  private readonly maxConcurrentStreamsPerBinding: number;
  private readonly maxHttpRequestsPerMinutePerBinding: number;
  private readonly maxConcurrentWebSocketsPerBinding: number;
  private readonly maxHttpResponseBytes: number;
  private readonly httpStreamIdleTimeoutMs: number;
  private readonly maxWebSocketFrameBytes: number;
  private readonly maxWebSocketBytes: number;
  private readonly webSocketIdleTimeoutMs: number;
  private readonly httpRequestWindowMs: number;
  private readonly bindings = new Map<string, BindingActivity>();
  private readonly requestWindows = new Map<string, number[]>();
  private readonly requestWindowTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(limits: NodeProxyRuntimeLimits = {}) {
    this.maxConcurrentHttpPerBinding = limits.maxConcurrentHttpPerBinding ?? 32;
    this.maxConcurrentStreamsPerBinding = limits.maxConcurrentStreamsPerBinding ?? 16;
    this.maxHttpRequestsPerMinutePerBinding = limits.maxHttpRequestsPerMinutePerBinding ?? 600;
    this.maxConcurrentWebSocketsPerBinding = limits.maxConcurrentWebSocketsPerBinding ?? 16;
    this.maxRequestBodyBytes = limits.maxRequestBodyBytes ?? 8 * 1024 * 1024;
    this.maxHttpResponseBytes = limits.maxHttpResponseBytes ?? 256 * 1024 * 1024;
    this.httpStreamIdleTimeoutMs = limits.httpStreamIdleTimeoutMs ?? 2 * 60_000;
    this.maxWebSocketFrameBytes = limits.maxWebSocketFrameBytes ?? 8 * 1024 * 1024;
    this.maxWebSocketBytes = limits.maxWebSocketBytes ?? 256 * 1024 * 1024;
    this.webSocketIdleTimeoutMs = limits.webSocketIdleTimeoutMs ?? 5 * 60_000;
    this.httpRequestWindowMs = limits.httpRequestWindowMs ?? 60_000;
  }

  reserveHttp(bindingId: string) {
    this.consumeRequestRate(bindingId);
    const activity = this.activity(bindingId);
    if (activity.controllers.size >= this.maxConcurrentHttpPerBinding) {
      this.deleteIfEmpty(bindingId, activity);
      throw this.limit("Proxy HTTP concurrency limit exceeded.", bindingId, "http-concurrency", this.maxConcurrentHttpPerBinding);
    }
    const controller = new AbortController();
    activity.controllers.add(controller);
    let released = false;
    let streaming = false;
    let responseBytes = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (!streaming || released) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        controller.abort(Object.assign(new Error("Proxy HTTP stream idle timeout."), {
          code: ControlPlaneProxyErrorCode.ResourceLimit,
        }));
      }, this.httpStreamIdleTimeoutMs);
      idleTimer.unref?.();
    };
    return {
      controller,
      acceptRequestBody: (bodyBytes: number) => {
        if (bodyBytes > this.maxRequestBodyBytes) {
          throw this.limit("Proxy request body limit exceeded.", bindingId, "request-body", this.maxRequestBodyBytes);
        }
      },
      beginResponseStream: () => {
        if (released || streaming) return;
        if (activity.streams.size >= this.maxConcurrentStreamsPerBinding) {
          throw this.limit("Proxy HTTP stream concurrency limit exceeded.", bindingId, "stream-concurrency", this.maxConcurrentStreamsPerBinding);
        }
        streaming = true;
        activity.streams.add(controller);
        resetIdle();
      },
      acceptResponseChunk: (value: unknown) => {
        if (released) return;
        responseBytes += frameBytes(value);
        if (responseBytes > this.maxHttpResponseBytes) {
          const error = this.limit("Proxy HTTP response byte limit exceeded.", bindingId, "response-bytes", this.maxHttpResponseBytes);
          controller.abort(error);
          throw error;
        }
        resetIdle();
      },
      release: () => {
        if (released) return;
        released = true;
        if (idleTimer) clearTimeout(idleTimer);
        activity.controllers.delete(controller);
        activity.streams.delete(controller);
        this.deleteIfEmpty(bindingId, activity);
      },
    };
  }

  openHttp(bindingId: string, bodyBytes: number) {
    const tracked = this.reserveHttp(bindingId);
    try {
      tracked.acceptRequestBody(bodyBytes);
      return tracked;
    } catch (error) {
      tracked.release();
      throw error;
    }
  }

  openWebSocket(bindingId: string, socket: NodeAgentWebSocket, onRelease?: () => void) {
    const activity = this.activity(bindingId);
    if (activity.sockets.size >= this.maxConcurrentWebSocketsPerBinding) {
      throw this.limit("Proxy WebSocket concurrency limit exceeded.", bindingId, "websocket-concurrency", this.maxConcurrentWebSocketsPerBinding);
    }
    let released = false;
    let totalBytes = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      if (idleTimer) clearTimeout(idleTimer);
      activity.sockets.delete(wrapped);
      this.deleteIfEmpty(bindingId, activity);
      onRelease?.();
    };
    const closeForLimit = (reason: string) => {
      release();
      socket.close(1009, reason);
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        release();
        socket.close(1001, "Proxy WebSocket idle timeout.");
      }, this.webSocketIdleTimeoutMs);
      idleTimer.unref?.();
    };
    const acceptFrame = (value: unknown) => {
      const bytes = frameBytes(value);
      if (bytes > this.maxWebSocketFrameBytes) {
        closeForLimit("Proxy WebSocket frame limit exceeded.");
        return false;
      }
      totalBytes += bytes;
      if (totalBytes > this.maxWebSocketBytes) {
        closeForLimit("Proxy WebSocket byte limit exceeded.");
        return false;
      }
      resetIdle();
      return true;
    };
    resetIdle();

    const wrapped: NodeAgentWebSocket = {
      get readyState() { return socket.readyState; },
      send: (data) => {
        if (!released && acceptFrame(data)) socket.send(data);
      },
      close: (code, reason) => {
        release();
        socket.close(code, reason);
      },
      on: (event, listener) => {
        if (event === "message") {
          socket.on(event, (data, ...args) => {
            if (!released && acceptFrame(data)) listener(data, ...args);
          });
          return;
        }
        if (event === "close" || event === "error") {
          socket.on(event, (...args) => {
            release();
            listener(...args);
          });
          return;
        }
        socket.on(event, listener);
      },
    };
    activity.sockets.add(wrapped);
    return wrapped;
  }

  closeBinding(bindingId: string, reason = "Proxy binding was revoked.") {
    const activity = this.bindings.get(bindingId);
    if (!activity) {
      this.clearRequestWindow(bindingId);
      return { abortedRequests: 0, closedSockets: 0 };
    }
    const controllers = [...activity.controllers];
    const sockets = [...activity.sockets];
    const cleanup = [...activity.cleanup];
    this.bindings.delete(bindingId);
    for (const controller of controllers) controller.abort(Object.assign(new Error(reason), { code: ControlPlaneProxyErrorCode.BindingRevoked }));
    for (const callback of cleanup) callback();
    for (const socket of sockets) socket.close(1008, reason);
    activity.controllers.clear();
    activity.streams.clear();
    activity.sockets.clear();
    activity.cleanup.clear();
    this.clearRequestWindow(bindingId);
    return { abortedRequests: controllers.length, closedSockets: sockets.length };
  }

  diagnostics(bindingId?: string) {
    if (bindingId) {
      const activity = this.bindings.get(bindingId);
      return { bindingId, activeHttp: activity?.controllers.size ?? 0, activeStreams: activity?.streams.size ?? 0, activeWebSockets: activity?.sockets.size ?? 0 };
    }
    return [...this.bindings].map(([id, activity]) => ({ bindingId: id, activeHttp: activity.controllers.size, activeStreams: activity.streams.size, activeWebSockets: activity.sockets.size }));
  }

  registerBindingCleanup(bindingId: string, callback: () => void) {
    const activity = this.activity(bindingId);
    activity.cleanup.add(callback);
    return () => {
      activity.cleanup.delete(callback);
      this.deleteIfEmpty(bindingId, activity);
    };
  }

  private activity(bindingId: string) {
    const existing = this.bindings.get(bindingId);
    if (existing) return existing;
    const created = { controllers: new Set<AbortController>(), streams: new Set<AbortController>(), sockets: new Set<NodeAgentWebSocket>(), cleanup: new Set<() => void>() };
    this.bindings.set(bindingId, created);
    return created;
  }

  private deleteIfEmpty(bindingId: string, activity: BindingActivity) {
    if (activity.controllers.size === 0 && activity.streams.size === 0 && activity.sockets.size === 0 && activity.cleanup.size === 0 && this.bindings.get(bindingId) === activity) {
      this.bindings.delete(bindingId);
    }
  }

  private limit(message: string, bindingId: string, resource: string, limit: number) {
    return new NodeProxyRuntimeError(message, { bindingId, resource, limit });
  }

  private consumeRequestRate(bindingId: string) {
    const now = Date.now();
    const threshold = now - this.httpRequestWindowMs;
    const window = (this.requestWindows.get(bindingId) || []).filter((timestamp) => timestamp > threshold);
    if (window.length >= this.maxHttpRequestsPerMinutePerBinding) {
      throw this.limit("Proxy HTTP request rate limit exceeded.", bindingId, "request-rate", this.maxHttpRequestsPerMinutePerBinding);
    }
    window.push(now);
    this.requestWindows.set(bindingId, window);
    this.scheduleRequestWindowCleanup(bindingId);
  }

  private scheduleRequestWindowCleanup(bindingId: string) {
    const existing = this.requestWindowTimers.get(bindingId);
    if (existing) clearTimeout(existing);
    const window = this.requestWindows.get(bindingId);
    if (!window?.length) {
      this.requestWindows.delete(bindingId);
      this.requestWindowTimers.delete(bindingId);
      return;
    }
    const delay = Math.max(1, window[0] + this.httpRequestWindowMs - Date.now() + 1);
    const timer = setTimeout(() => {
      this.requestWindowTimers.delete(bindingId);
      const threshold = Date.now() - this.httpRequestWindowMs;
      const retained = (this.requestWindows.get(bindingId) || []).filter((timestamp) => timestamp > threshold);
      if (!retained.length) {
        this.requestWindows.delete(bindingId);
        return;
      }
      this.requestWindows.set(bindingId, retained);
      this.scheduleRequestWindowCleanup(bindingId);
    }, delay);
    timer.unref?.();
    this.requestWindowTimers.set(bindingId, timer);
  }

  private clearRequestWindow(bindingId: string) {
    this.requestWindows.delete(bindingId);
    const timer = this.requestWindowTimers.get(bindingId);
    if (timer) clearTimeout(timer);
    this.requestWindowTimers.delete(bindingId);
  }
}

function frameBytes(value: unknown) {
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Buffer.byteLength(typeof value === "string" ? value : String(value), "utf8");
}
