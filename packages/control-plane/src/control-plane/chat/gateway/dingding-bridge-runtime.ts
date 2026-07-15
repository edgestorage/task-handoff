import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import { DWClient, TOPIC_CARD, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import {
  type DingdingClientLike,
  type DingdingRuntimeState,
} from "../adapters/dingding.ts";
import type { ChatGatewayProgressStore, ChatGatewayProgressUpdate } from "../adapters/contracts.ts";
import { DingdingProgressStore } from "./dingding-progress-store.ts";

export type DingdingBridgeRuntimeLogger = {
  info: (data: Record<string, unknown>, message: string) => void;
  warn: (data: Record<string, unknown>, message: string) => void;
};

export type DingdingBridgeRuntimeManagerOptions = {
  fetchImpl: typeof fetch;
  createClient?: (input: { clientId: string; clientSecret: string }) => DingdingClientLike;
  logger: DingdingBridgeRuntimeLogger;
  onRobotMessage: (bridge: ChatBridgeConfig, runtime: DingdingRuntimeState, message: DWClientDownStream) => Promise<void>;
  onCardCallback: (bridge: ChatBridgeConfig, runtime: DingdingRuntimeState, message: DWClientDownStream) => Promise<unknown>;
  onError: (bridgeId: string, error: unknown) => void;
  clearError: (bridgeId: string) => void;
  reconnectDelayMs?: number;
};

export function createDingdingStreamClient(input: { clientId: string; clientSecret: string }) {
  const client = new DWClient({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    ua: "task-handoff-control-plane",
    // dingtalk-stream 2.1.5 can throw from its heartbeat timer while the socket
    // is still CONNECTING, so the manager runs without the SDK heartbeat.
    keepAlive: false,
    // Reconnect is manager-owned so stop can cancel every scheduled retry.
    autoReconnect: false,
  } as ConstructorParameters<typeof DWClient>[0] & { autoReconnect: boolean });
  let intentionalDisconnect = false;
  let disconnectListener: ((error?: unknown) => void) | undefined;
  return {
    async connect() {
      intentionalDisconnect = false;
      await client.getEndpoint();
      await client._connect();
      const socket = (client as unknown as { socket?: { once: (event: string, listener: () => void) => void } }).socket;
      socket?.once("close", () => {
        if (!intentionalDisconnect) disconnectListener?.(new Error("DingDing stream connection closed."));
      });
    },
    disconnect() {
      intentionalDisconnect = true;
      client.disconnect();
    },
    onDisconnect(listener: (error?: unknown) => void) {
      disconnectListener = listener;
    },
    getConfig() {
      return client.getConfig();
    },
    registerCallbackListener(topic: string, listener: (message: unknown) => void) {
      client.registerCallbackListener(topic, listener as (message: DWClientDownStream) => void);
    },
    socketCallBackResponse(messageId: string, response: unknown) {
      client.socketCallBackResponse(messageId, response);
    },
  };
}

export class DingdingBridgeRuntimeManager implements ChatGatewayProgressStore {
  private readonly runtimes = new Map<string, DingdingRuntimeState>();
  private readonly connected = new Set<string>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly progress: DingdingProgressStore;
  private readonly options: DingdingBridgeRuntimeManagerOptions;
  private readonly createClient: (input: { clientId: string; clientSecret: string }) => DingdingClientLike;

  constructor(options: DingdingBridgeRuntimeManagerOptions) {
    this.options = options;
    this.createClient = options.createClient || createDingdingStreamClient;
    this.progress = new DingdingProgressStore(options.fetchImpl);
  }

  has(bridgeId: string) {
    return this.runtimes.has(bridgeId);
  }

  isRunning(bridgeId: string) {
    return this.connected.has(bridgeId);
  }

  get(bridgeId: string) {
    return this.runtimes.get(bridgeId);
  }

  ids() {
    return this.runtimes.keys();
  }

  start(bridge: ChatBridgeConfig) {
    const clientSecret = stringSetting(bridge.settings?.clientSecret);
    if (!bridge.token || !clientSecret) {
      this.options.onError(bridge.id, "DingDing client id/secret is not configured.");
      return false;
    }
    const runtime: DingdingRuntimeState = {
      client: this.createClient({ clientId: bridge.token, clientSecret }),
      chatWebhooks: new Map(),
      senderIds: new Map(),
      conversationTypes: new Map(),
      onLog: (level, data, message) => {
        this.options.logger[level === "warn" ? "warn" : "info"]({ bridgeId: bridge.id, ...data }, message);
      },
    };
    runtime.client.onDisconnect?.((error) => {
      if (this.runtimes.get(bridge.id) === runtime) this.handleConnectionFailure(bridge, runtime, error);
    });
    runtime.client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      void this.options.onRobotMessage(bridge, runtime, message as DWClientDownStream).catch((error) => {
        this.options.onError(bridge.id, error);
      });
    });
    runtime.client.registerCallbackListener(TOPIC_CARD, (message) => {
      const downstream = message as DWClientDownStream;
      void this.options.onCardCallback(bridge, runtime, downstream)
        .then((result) => runtime.client.socketCallBackResponse(downstream.headers.messageId, result || {}))
        .catch((error) => {
          this.options.onError(bridge.id, error);
          runtime.client.socketCallBackResponse(downstream.headers.messageId, {});
        });
    });
    this.options.clearError(bridge.id);
    this.runtimes.set(bridge.id, runtime);
    this.connect(bridge, runtime);
    return true;
  }

  private connect(bridge: ChatBridgeConfig, runtime: DingdingRuntimeState) {
    this.reconnectTimers.delete(bridge.id);
    this.connected.add(bridge.id);
    runtime.client.connect()
      .then(() => {
        if (this.runtimes.get(bridge.id) === runtime) {
          this.connected.add(bridge.id);
          this.options.clearError(bridge.id);
        }
      })
      .catch((error: unknown) => {
        if (this.runtimes.get(bridge.id) === runtime) this.handleConnectionFailure(bridge, runtime, error);
      });
  }

  private handleConnectionFailure(bridge: ChatBridgeConfig, runtime: DingdingRuntimeState, error: unknown) {
    this.connected.delete(bridge.id);
    this.progress.clearBridge(bridge.id);
    this.options.onError(bridge.id, error || "DingDing stream connection failed.");
    if (this.reconnectTimers.has(bridge.id)) return;
    const timer = setTimeout(() => {
      if (this.runtimes.get(bridge.id) === runtime) this.connect(bridge, runtime);
    }, this.options.reconnectDelayMs ?? 1_000);
    timer.unref?.();
    this.reconnectTimers.set(bridge.id, timer);
  }

  stop(bridgeId: string) {
    const reconnectTimer = this.reconnectTimers.get(bridgeId);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.reconnectTimers.delete(bridgeId);
    this.connected.delete(bridgeId);
    const runtime = this.runtimes.get(bridgeId);
    if (runtime) {
      try {
        runtime.client.disconnect();
      } catch {
        // Ignore SDK disconnect races.
      }
      this.runtimes.delete(bridgeId);
    }
    this.progress.clearBridge(bridgeId);
  }

  stopAll() {
    for (const bridgeId of [...this.runtimes.keys()]) {
      this.stop(bridgeId);
    }
    this.progress.clear();
  }

  applyUpdate(input: ChatGatewayProgressUpdate) {
    const runtime = this.runtimes.get(input.bridge.id);
    return runtime ? this.progress.applyUpdate(input, runtime) : Promise.resolve(false);
  }

  applyProgressUpdate(input: ChatGatewayProgressUpdate) {
    return this.applyUpdate(input);
  }
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value : "";
}
