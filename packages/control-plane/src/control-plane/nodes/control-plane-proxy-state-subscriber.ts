import {
  ControlPlaneProxyErrorCode,
  ControlPlaneProxyErrorSchema,
  ProxyEventStreamMessageSchema,
  ProxyTargetSnapshotSchema,
  type ControlPlaneProxyError,
  type ProxyNodeCredential,
  type ProxyTargetEvent,
  type ProxyTargetSnapshot,
} from "@task-handoff/protocol/control-plane-proxy";
import type { Node } from "@task-handoff/protocol/control-plane";
import { parseResponse, safeParseResponse } from "@task-handoff/protocol/response-validation";
import { WebSocket as WsClient } from "ws";
import { controlPlaneProxyAuthenticationHeaders } from "./control-plane-proxy-transport.ts";

type EventSocket = {
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  close(): void;
};

export type ControlPlaneProxyStateSubscriberService = {
  listNodes(): Node[];
  proxyPrivateStore: { nodeCredential(nodeId: string): ProxyNodeCredential | undefined };
  applyProxyTargetSnapshot(nodeId: string, snapshot: ProxyTargetSnapshot): Node;
  applyProxyTargetEvent(nodeId: string, event: ProxyTargetEvent): Node;
  markProxyUnavailable(nodeId: string, error: ControlPlaneProxyError): Node;
  markProxyBindingRevoked(nodeId: string, error: ControlPlaneProxyError): Node;
};

export type ControlPlaneProxyStateSubscriberOptions = {
  fetchImpl?: typeof fetch;
  openWebSocket?: (url: string, headers: Record<string, string>) => EventSocket;
  reconnectDelayMs?: number;
  onStateChanged?: (node: Node) => void;
  logger?: { warn?: (details: unknown, message?: string) => void };
};

type Subscription = {
  generation: number;
  identity: string;
  socket?: EventSocket;
  reconnect?: ReturnType<typeof setTimeout>;
};

const unavailableError = (message: string): ControlPlaneProxyError => ControlPlaneProxyErrorSchema.parse({
  code: ControlPlaneProxyErrorCode.Unavailable,
  message,
  retryable: true,
});

export class ControlPlaneProxyStateSubscriber {
  private readonly service: ControlPlaneProxyStateSubscriberService;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly fetchImpl: typeof fetch;
  private readonly openWebSocket: NonNullable<ControlPlaneProxyStateSubscriberOptions["openWebSocket"]>;
  private readonly reconnectDelayMs: number;
  private readonly onStateChanged: (node: Node) => void;
  private readonly logger: ControlPlaneProxyStateSubscriberOptions["logger"];
  private running = false;

  constructor(service: ControlPlaneProxyStateSubscriberService, options: ControlPlaneProxyStateSubscriberOptions = {}) {
    this.service = service;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.openWebSocket = options.openWebSocket ?? ((url, headers) => new WsClient(url, { headers }));
    this.reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? 2_000);
    this.onStateChanged = options.onStateChanged ?? (() => undefined);
    this.logger = options.logger;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.syncNow();
  }

  syncNow() {
    if (!this.running) return;
    const desired = new Map(this.service.listNodes()
      .filter((node) => node.connectionMode === "control-plane-proxy" && node.connectionEnabled !== false)
      .map((node) => [node.id, node]));
    for (const nodeId of this.subscriptions.keys()) if (!desired.has(nodeId)) this.remove(nodeId);
    for (const node of desired.values()) {
      const identity = this.subscriptionIdentity(node);
      const existing = this.subscriptions.get(node.id);
      if (existing?.identity === identity) continue;
      if (existing) this.remove(node.id);
      const subscription = { generation: 1, identity };
      this.subscriptions.set(node.id, subscription);
      void this.connect(node.id, subscription.generation);
    }
  }

  stop() {
    this.running = false;
    for (const nodeId of [...this.subscriptions.keys()]) this.remove(nodeId);
  }

  private remove(nodeId: string) {
    const subscription = this.subscriptions.get(nodeId);
    if (!subscription) return;
    subscription.generation += 1;
    if (subscription.reconnect) clearTimeout(subscription.reconnect);
    subscription.socket?.close();
    this.subscriptions.delete(nodeId);
  }

  private async connect(nodeId: string, generation: number) {
    const subscription = this.current(nodeId, generation);
    if (!subscription) return;
    const credential = this.service.proxyPrivateStore.nodeCredential(nodeId);
    if (!credential) {
      this.fail(nodeId, generation, unavailableError("Control-plane proxy credential is unavailable."), false);
      return;
    }
    try {
      const response = await this.fetchImpl(snapshotUrl(credential), {
        headers: controlPlaneProxyAuthenticationHeaders(credential),
      });
      if (!this.current(nodeId, generation)) return;
      const payload = await response.json().catch(() => undefined) as { data?: unknown; error?: unknown } | undefined;
      if (!response.ok) {
        const parsedError = safeParseResponse(ControlPlaneProxyErrorSchema, payload?.error);
        const error = parsedError.success ? parsedError.data : unavailableError(`Proxy snapshot failed with HTTP ${response.status}.`);
        if (error.code === ControlPlaneProxyErrorCode.BindingRevoked) {
          this.onStateChanged(this.service.markProxyBindingRevoked(nodeId, error));
          return;
        }
        this.fail(nodeId, generation, error, error.retryable);
        return;
      }
      const snapshot = parseResponse(ProxyTargetSnapshotSchema, payload?.data);
      this.validateIdentity(credential, snapshot.binding.id, snapshot.binding.targetNodeId);
      this.onStateChanged(this.service.applyProxyTargetSnapshot(nodeId, snapshot));
      if (snapshot.binding.status === "revoked") {
        this.onStateChanged(this.service.markProxyBindingRevoked(nodeId, {
          code: ControlPlaneProxyErrorCode.BindingRevoked,
          message: "Control-plane proxy binding was revoked.",
          retryable: false,
        }));
        return;
      }
      this.openEvents(nodeId, generation, credential, snapshot);
    } catch (cause) {
      if (!this.current(nodeId, generation)) return;
      this.logger?.warn?.({ nodeId, error: proxyFailureLog(cause) }, "control-plane proxy state bootstrap failed");
      this.fail(nodeId, generation, unavailableError("Trusted control-plane proxy is unavailable."), true);
    }
  }

  private openEvents(nodeId: string, generation: number, credential: ProxyNodeCredential, snapshot: ProxyTargetSnapshot) {
    const subscription = this.current(nodeId, generation);
    if (!subscription) return;
    const socket = this.openWebSocket(eventsUrl(credential, snapshot.revision), controlPlaneProxyAuthenticationHeaders(credential));
    subscription.socket = socket;
    let failed = false;
    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      this.fail(nodeId, generation, unavailableError(message), true);
    };
    socket.on("message", (raw) => {
      if (!this.current(nodeId, generation)) return;
      try {
        const parsed = parseResponse(ProxyEventStreamMessageSchema, JSON.parse(String(raw)));
        if (parsed.bindingId !== credential.proxyBindingId
          || parsed.sourceControlPlaneId !== credential.sourceControlPlaneId
          || parsed.targetNodeId !== credential.targetNodeId
          || parsed.streamId !== snapshot.streamId) {
          throw new Error("Proxy event stream identity changed.");
        }
        if (parsed.type === "control-plane-proxy.snapshot-required") {
          this.restart(nodeId, generation);
          return;
        }
        if (parsed.type === "control-plane-proxy.events.ready") return;
        this.onStateChanged(this.service.applyProxyTargetEvent(nodeId, parsed));
      } catch (cause) {
        this.logger?.warn?.({ nodeId, error: proxyFailureLog(cause) }, "control-plane proxy event requires a new snapshot");
        this.restart(nodeId, generation);
      }
    });
    socket.on("error", () => fail("Control-plane proxy event stream failed."));
    socket.on("close", () => fail("Control-plane proxy event stream disconnected."));
  }

  private restart(nodeId: string, generation: number) {
    const subscription = this.current(nodeId, generation);
    if (!subscription) return;
    subscription.generation += 1;
    subscription.socket?.close();
    subscription.socket = undefined;
    void this.connect(nodeId, subscription.generation);
  }

  private fail(nodeId: string, generation: number, error: ControlPlaneProxyError, retry: boolean) {
    const subscription = this.current(nodeId, generation);
    if (!subscription) return;
    this.onStateChanged(this.service.markProxyUnavailable(nodeId, error));
    if (!retry) {
      subscription.generation += 1;
      subscription.socket?.close();
      this.subscriptions.delete(nodeId);
      return;
    }
    subscription.generation += 1;
    subscription.socket?.close();
    subscription.socket = undefined;
    subscription.reconnect = setTimeout(() => {
      subscription.reconnect = undefined;
      void this.connect(nodeId, subscription.generation);
    }, this.reconnectDelayMs);
    subscription.reconnect.unref?.();
  }

  private current(nodeId: string, generation: number) {
    const subscription = this.subscriptions.get(nodeId);
    return this.running && subscription?.generation === generation ? subscription : undefined;
  }

  private validateIdentity(credential: ProxyNodeCredential, bindingId: string, targetNodeId: string) {
    if (bindingId !== credential.proxyBindingId || targetNodeId !== credential.targetNodeId) {
      const error = new Error("Proxy snapshot identity does not match the private binding credential.");
      Object.assign(error, { code: ControlPlaneProxyErrorCode.BindingIdentityConflict });
      throw error;
    }
  }

  private subscriptionIdentity(node: Node) {
    const credential = this.service.proxyPrivateStore.nodeCredential(node.id);
    return JSON.stringify({
      connectionMode: node.connectionMode,
      connectionPath: node.connectionPath,
      credential: credential && {
        id: credential.id,
        proxyOrigin: credential.proxyOrigin,
        proxyBindingId: credential.proxyBindingId,
        targetNodeId: credential.targetNodeId,
        sourceControlPlaneId: credential.sourceControlPlaneId,
        bindingKeyId: credential.bindingKeyId,
        updatedAt: credential.updatedAt,
      },
    });
  }
}

function snapshotUrl(credential: ProxyNodeCredential) {
  return new URL(`/api/node-proxy/bindings/${encodeURIComponent(credential.proxyBindingId)}/snapshot`, credential.proxyOrigin);
}

function eventsUrl(credential: ProxyNodeCredential, revision: number) {
  const url = new URL(`/api/node-proxy/bindings/${encodeURIComponent(credential.proxyBindingId)}/events`, credential.proxyOrigin);
  url.protocol = "wss:";
  url.searchParams.set("sinceRevision", String(revision));
  return url.toString();
}

function proxyFailureLog(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
  };
}
