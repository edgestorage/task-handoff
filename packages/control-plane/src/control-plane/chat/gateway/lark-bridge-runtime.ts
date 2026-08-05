import {
  createLarkChannel,
  Domain,
  type LarkChannelOptions,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import type { LarkChannelLike, LarkRuntimeState } from "../adapters/lark.ts";
import type { ChatGatewayProgressStore, ChatGatewayProgressUpdate } from "../adapters/contracts.ts";
import { LarkProgressStore } from "./lark-progress-store.ts";

export type LarkBridgeRuntimeLogger = {
  info: (data: Record<string, unknown>, message: string) => void;
  warn: (data: Record<string, unknown>, message: string) => void;
};

export type LarkChannelFactoryInput = {
  appId: string;
  appSecret: string;
  domain: Domain;
};

export type LarkBridgeRuntimeManagerOptions = {
  createChannel?: (input: LarkChannelFactoryInput) => LarkChannelLike;
  logger: LarkBridgeRuntimeLogger;
  onMessage: (bridge: ChatBridgeConfig, runtime: LarkRuntimeState, message: NormalizedMessage) => Promise<void>;
  onError: (bridgeId: string, error: unknown) => void;
  clearError: (bridgeId: string) => void;
  reconnectDelayMs?: number;
  progressUpdateIntervalMs?: number;
};

export function createLarkSdkChannel(input: LarkChannelFactoryInput) {
  const options: LarkChannelOptions = {
    appId: input.appId,
    appSecret: input.appSecret,
    domain: input.domain,
    transport: "websocket",
    source: "task-handoff-control-plane",
    handshakeTimeoutMs: 15_000,
    policy: {
      requireMention: true,
      dmMode: "open",
      respondToMentionAll: false,
    },
  };
  return createLarkChannel(options);
}

export class LarkBridgeRuntimeManager implements ChatGatewayProgressStore {
  private readonly runtimes = new Map<string, LarkRuntimeState>();
  private readonly connected = new Set<string>();
  private readonly unsubscribe = new Map<string, () => void>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly options: LarkBridgeRuntimeManagerOptions;
  private readonly createChannel: (input: LarkChannelFactoryInput) => LarkChannelLike;
  private readonly progress: LarkProgressStore;

  constructor(options: LarkBridgeRuntimeManagerOptions) {
    this.options = options;
    this.createChannel = options.createChannel || createLarkSdkChannel;
    this.progress = new LarkProgressStore(options.progressUpdateIntervalMs);
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
    const appSecret = stringSetting(bridge.settings?.appSecret);
    if (!bridge.token || !appSecret) {
      this.options.onError(bridge.id, "Lark app id/secret is not configured.");
      return false;
    }
    const runtime: LarkRuntimeState = {
      channel: this.createChannel({
        appId: bridge.token,
        appSecret,
        domain: larkDomain(bridge.settings?.domain),
      }),
    };
    const stopListening = runtime.channel.on({
      message: (message) => {
        void this.options.onMessage(bridge, runtime, message).catch((error) => {
          this.options.onError(bridge.id, error);
        });
      },
      error: (error) => {
        this.options.onError(bridge.id, error);
        this.options.logger.warn({ bridgeId: bridge.id, error: error.message }, "lark channel error");
      },
      reconnecting: () => {
        this.connected.delete(bridge.id);
        this.options.onError(bridge.id, "Lark WebSocket is reconnecting.");
        this.options.logger.info({ bridgeId: bridge.id }, "lark channel reconnecting");
      },
      reconnected: () => {
        if (this.runtimes.get(bridge.id) !== runtime) return;
        this.connected.add(bridge.id);
        this.options.clearError(bridge.id);
        this.options.logger.info({ bridgeId: bridge.id }, "lark channel reconnected");
      },
    });
    this.options.clearError(bridge.id);
    this.runtimes.set(bridge.id, runtime);
    this.unsubscribe.set(bridge.id, stopListening);
    this.connect(bridge, runtime);
    return true;
  }

  private connect(bridge: ChatBridgeConfig, runtime: LarkRuntimeState) {
    this.reconnectTimers.delete(bridge.id);
    void runtime.channel.connect()
      .then(() => {
        if (this.runtimes.get(bridge.id) !== runtime) return;
        this.connected.add(bridge.id);
        this.options.clearError(bridge.id);
        this.options.logger.info({ bridgeId: bridge.id }, "lark channel connected");
      })
      .catch((error: unknown) => {
        if (this.runtimes.get(bridge.id) !== runtime) return;
        this.connected.delete(bridge.id);
        this.options.onError(bridge.id, error);
        // Once the WebSocket exists, the SDK owns reconnection. Retry here
        // only when setup failed earlier, such as bot identity resolution.
        if (runtime.channel.rawWsClient || this.reconnectTimers.has(bridge.id)) return;
        const timer = setTimeout(() => {
          if (this.runtimes.get(bridge.id) === runtime) this.connect(bridge, runtime);
        }, this.options.reconnectDelayMs ?? 1_000);
        timer.unref?.();
        this.reconnectTimers.set(bridge.id, timer);
      });
  }

  stop(bridgeId: string) {
    const reconnectTimer = this.reconnectTimers.get(bridgeId);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.reconnectTimers.delete(bridgeId);
    this.unsubscribe.get(bridgeId)?.();
    this.unsubscribe.delete(bridgeId);
    this.connected.delete(bridgeId);
    const runtime = this.runtimes.get(bridgeId);
    this.runtimes.delete(bridgeId);
    this.progress.clearBridge(bridgeId);
    if (!runtime) return;
    try {
      runtime.channel.rawWsClient?.close({ force: true });
    } catch {
      // Ignore SDK disconnect races.
    }
    void runtime.channel.disconnect().catch(() => undefined);
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

function larkDomain(value: unknown) {
  return String(value || "").trim().toLowerCase() === "lark" ? Domain.Lark : Domain.Feishu;
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
