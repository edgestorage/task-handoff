import WebSocket from "ws";
import { EventConnectionRetryTimer } from "../../shared/events/connection-retry.ts";
import { NODE_TUNNEL_API_PATH } from "../../shared/security/node-agent-auth.ts";
import { NodeAgentIdentityService } from "../identity/service.ts";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import { connectReverseTunnel, type ReverseTunnelHost } from "./client.ts";
import { WebSocketConnectionSupervisor } from "../../shared/transport/websocket-connection-supervisor.ts";

export type ReverseTunnelManagerOptions = {
  token?: string;
  remoteSecret?: string;
  remoteKeyId?: string;
  controlPlaneTunnelUrl?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  stableThresholdMs?: number;
};

type ReverseTunnelManagerHost = ReverseTunnelHost & {
  log: {
    info(data: Record<string, unknown>, message: string): void;
    warn(data: Record<string, unknown>, message: string): void;
  };
  nodeAgentState: {
    currentListenerPort: number;
  };
};

function explicitControlPlaneTunnelUrl(options: ReverseTunnelManagerOptions) {
  const value = options.controlPlaneTunnelUrl || process.env.TASK_HANDOFF_CONTROL_PLANE_TUNNEL_URL;
  return value ? new URL(value).toString() : undefined;
}

function bootstrapControlPlaneTunnelUrl() {
  const base = process.env.TASK_HANDOFF_CONTROL_PLANE_URL;
  if (!base) return undefined;
  const url = new URL(NODE_TUNNEL_API_PATH, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function controlPlaneTunnelUrlForBase(controlPlaneUrl: string) {
  const url = new URL(NODE_TUNNEL_API_PATH, controlPlaneUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createReverseTunnelManager(
  app: ReverseTunnelManagerHost,
  options: ReverseTunnelManagerOptions,
  paths: NodeAgentStorePaths,
  nodeId: string,
) {
  const token = options.token || process.env.TASK_HANDOFF_NODE_AGENT_TOKEN;
  const identity = new NodeAgentIdentityService(paths);
  type TunnelConfig = { tunnelUrl: string; keyId?: string; secret?: string };
  type TunnelStatus = "connecting" | "connected" | "reconnecting" | "failed";
  type TunnelEntry = {
    config: TunnelConfig;
    retry: EventConnectionRetryTimer;
    socket?: WebSocket;
    status: TunnelStatus;
    lastConnectedAt?: string;
    lastDisconnectedAt?: string;
    nextRetryAt?: string;
    error?: string;
    supervisor?: WebSocketConnectionSupervisor;
  };
  const tunnels = new Map<string, TunnelEntry>();
  let closing = false;

  const scheduleReconnect = (key: string, entry: TunnelEntry) => {
    if (closing || entry.retry.pending || tunnels.get(key) !== entry) return;
    const scheduled = entry.retry.schedule(() => {
      if (!closing && tunnels.get(key) === entry && !entry.socket) open(key, entry);
    });
    if (scheduled) {
      entry.status = "reconnecting";
      entry.nextRetryAt = new Date(Date.now() + scheduled.delay).toISOString();
      app.log.info({
        nodeId,
        tunnelUrl: new URL(entry.config.tunnelUrl).origin,
        attempt: scheduled.attempt,
        delay: scheduled.delay,
      }, "node agent reverse tunnel reconnect scheduled");
    }
  };

  const open = (key: string, entry: TunnelEntry) => {
    entry.status = entry.lastDisconnectedAt ? "reconnecting" : "connecting";
    entry.error = undefined;
    entry.nextRetryAt = undefined;
    let socket: WebSocket;
    try {
      socket = connectReverseTunnel(app, {
        ...entry.config,
        nodeId,
        port: () => app.nodeAgentState.currentListenerPort,
        token,
      });
    } catch (error) {
      entry.status = "failed";
      entry.lastDisconnectedAt = new Date().toISOString();
      entry.error = error instanceof Error ? error.message : String(error);
      scheduleReconnect(key, entry);
      return undefined;
    }
    entry.socket = socket;
    const supervisor = new WebSocketConnectionSupervisor({
      connectTimeoutMs: options.connectTimeoutMs,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
      stableThresholdMs: options.stableThresholdMs,
      ping: () => socket.ping(),
      onTimeout: (kind) => {
        if (tunnels.get(key) !== entry || entry.socket !== socket) return;
        entry.status = "failed";
        entry.error = `Reverse tunnel ${kind} timeout.`;
        socket.terminate();
      },
      onStable: () => entry.retry.reset(),
    });
    entry.supervisor = supervisor;
    supervisor.start();
    socket.on("open", () => {
      if (tunnels.get(key) === entry && entry.socket === socket) {
        entry.status = "connecting";
        supervisor.opened();
      }
    });
    socket.on("message", (raw) => {
      if (tunnels.get(key) !== entry || entry.socket !== socket || entry.status === "connected") return;
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      const type = message && typeof message === "object" ? (message as { type?: unknown }).type : undefined;
      if (type !== "control-plane.hello" && type !== "control-plane.identified") return;
      supervisor.activity();
      supervisor.healthy();
      entry.status = "connected";
      entry.lastConnectedAt = new Date().toISOString();
      entry.nextRetryAt = undefined;
      entry.error = undefined;
      app.log.info({ nodeId, tunnelUrl: new URL(entry.config.tunnelUrl).origin }, "node agent reverse tunnel connected");
    });
    socket.on("pong", () => supervisor.pong());
    socket.on("close", (code, reason) => {
      if (tunnels.get(key) !== entry || entry.socket !== socket) return;
      supervisor.close();
      entry.socket = undefined;
      entry.lastDisconnectedAt = new Date().toISOString();
      entry.error = `WebSocket closed${code ? ` (${code})` : ""}${reason ? `: ${Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason)}` : ""}`;
      if (!closing) {
        app.log.warn({
          nodeId,
          tunnelUrl: new URL(entry.config.tunnelUrl).origin,
          code,
          reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || ""),
        }, "node agent reverse tunnel disconnected");
        scheduleReconnect(key, entry);
      }
    });
    socket.on("error", (error) => {
      if (tunnels.get(key) === entry && entry.socket === socket) {
        entry.status = "failed";
        entry.error = error instanceof Error ? error.message : String(error);
        socket.terminate();
      }
    });
    return socket;
  };

  const replace = (key: string, config: TunnelConfig) => {
    const current = tunnels.get(key);
    current?.retry.cancel();
    current?.supervisor?.close();
    const entry: TunnelEntry = { config, retry: new EventConnectionRetryTimer(), status: "connecting" };
    tunnels.set(key, entry);
    current?.socket?.close(1000, "Reverse tunnel reconnecting.");
    return open(key, entry);
  };

  const sameConfig = (left: TunnelConfig, right: TunnelConfig) => left.tunnelUrl === right.tunnelUrl
    && left.keyId === right.keyId
    && left.secret === right.secret;

  const reconcile = (configured: Map<string, TunnelConfig>) => {
    for (const [key, entry] of tunnels) {
      if (configured.has(key)) continue;
      entry.retry.cancel();
      entry.supervisor?.close();
      tunnels.delete(key);
      entry.socket?.close(1000, "Reverse tunnel configuration removed.");
    }
    for (const [key, config] of configured) {
      const current = tunnels.get(key);
      if (!current || !sameConfig(current.config, config)) replace(key, config);
    }
  };

  const connectConfigured = () => {
    closing = false;
    const configured = new Map<string, TunnelConfig>();
    const access = identity.resolvedControlPlaneAccess();
    const configuredTunnelUrls = new Set<string>();
    for (const { connection, pairing } of access.connections) {
      if (!connection.enabled) continue;
      if (!pairing) {
        app.log.warn({ nodeId, connectionId: connection.id, pairingKeyId: connection.pairingKeyId }, "node agent control-plane connection has no pairing");
        continue;
      }
      const tunnelUrl = controlPlaneTunnelUrlForBase(connection.url);
      configured.set(connection.id, { tunnelUrl, keyId: pairing.keyId, secret: pairing.secret });
      configuredTunnelUrls.add(tunnelUrl);
    }
    const explicitTunnelUrl = explicitControlPlaneTunnelUrl(options);
    if (explicitTunnelUrl && !configuredTunnelUrls.has(explicitTunnelUrl)) {
      const tunnelSecret = identity.reverseTunnelSecret(
        process.env.TASK_HANDOFF_CONTROL_PLANE_URL,
        options.remoteSecret || process.env.TASK_HANDOFF_NODE_AGENT_REMOTE_SECRET,
        options.remoteKeyId || process.env.TASK_HANDOFF_NODE_AGENT_REMOTE_KEY_ID,
      );
      configured.set(`explicit:${explicitTunnelUrl}`, {
        tunnelUrl: explicitTunnelUrl,
        keyId: tunnelSecret?.keyId,
        secret: tunnelSecret?.secret,
      });
      configuredTunnelUrls.add(explicitTunnelUrl);
    }
    const bootstrapTunnelUrl = access.hasPersistedAccess ? undefined : bootstrapControlPlaneTunnelUrl();
    if (bootstrapTunnelUrl && !configuredTunnelUrls.has(bootstrapTunnelUrl)) {
      const tunnelSecret = identity.reverseTunnelSecret(
        process.env.TASK_HANDOFF_CONTROL_PLANE_URL,
        options.remoteSecret || process.env.TASK_HANDOFF_NODE_AGENT_REMOTE_SECRET,
        options.remoteKeyId || process.env.TASK_HANDOFF_NODE_AGENT_REMOTE_KEY_ID,
      );
      configured.set(`bootstrap:${bootstrapTunnelUrl}`, {
        tunnelUrl: bootstrapTunnelUrl,
        keyId: tunnelSecret?.keyId,
        secret: tunnelSecret?.secret,
      });
    }
    reconcile(configured);
  };

  const state = (connectionId: string) => {
    const entry = tunnels.get(connectionId);
    if (!entry) return undefined;
    const connection = entry.supervisor?.diagnostics();
    return {
      status: entry.status,
      ...(connection?.pingRttMs === undefined ? {} : { pingRttMs: connection.pingRttMs }),
      ...(connection?.pingRttP95Ms === undefined ? {} : { pingRttP95Ms: connection.pingRttP95Ms }),
      consecutiveReconnects: entry.retry.attempts,
      ...(entry.lastConnectedAt ? { lastConnectedAt: entry.lastConnectedAt } : {}),
      ...(entry.lastDisconnectedAt ? { lastDisconnectedAt: entry.lastDisconnectedAt } : {}),
      ...(entry.nextRetryAt ? { nextRetryAt: entry.nextRetryAt } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  };

  const closeAll = () => {
    closing = true;
    for (const entry of tunnels.values()) {
      entry.retry.cancel();
      entry.supervisor?.close();
      entry.socket?.close(1001, "Node agent shutting down.");
    }
    tunnels.clear();
  };

  return { connectConfigured, state, closeAll };
}
