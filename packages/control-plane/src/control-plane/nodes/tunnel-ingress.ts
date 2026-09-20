import { NODE_TUNNEL_PROTOCOL_VERSION } from "@task-handoff/protocol/control-plane";
import type { ControlPlaneNodeAgentTunnelTransport } from "./tunnel.ts";

export type NodeAgentTunnelSocket = {
  send: (data: string | Buffer, options?: { binary?: boolean }) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  readyState: number;
};

type NodeTunnelIngressOptions = {
  onIdentified?: (nodeId: string) => void | Promise<void>;
};

export class NodeTunnelIngress {
  private readonly transport: ControlPlaneNodeAgentTunnelTransport;
  private readonly onIdentified?: (nodeId: string) => void | Promise<void>;

  constructor(transport: ControlPlaneNodeAgentTunnelTransport, options: NodeTunnelIngressOptions = {}) {
    this.transport = transport;
    this.onIdentified = options.onIdentified;
  }

  attachMain(nodeId: string, socket: NodeAgentTunnelSocket) {
    this.transport.attach(nodeId, socket);
    socket.send(JSON.stringify({
      type: "control-plane.hello",
      protocolVersion: NODE_TUNNEL_PROTOCOL_VERSION,
      nodeId,
      serverTime: new Date().toISOString(),
      capabilities: {
        reverseTunnel: "request-response",
        auxiliaryChannels: true,
        httpResponseStreaming: true,
        lifecycleCommands: true,
        instanceApiProxy: true,
      },
    }));
    socket.on("message", (raw) => this.handleMainMessage(nodeId, socket, raw));
  }

  attachAuxiliary(nodeId: string, channelId: string, socket: NodeAgentTunnelSocket) {
    return this.transport.attachAuxiliary(nodeId, channelId, socket);
  }

  private handleMainMessage(nodeId: string, socket: NodeAgentTunnelSocket, raw: unknown) {
    if (!this.transport.isCurrentSocket(nodeId, socket)) return;
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      socket.send(JSON.stringify({ type: "control-plane.error", code: "INVALID_JSON" }));
      return;
    }
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    const handled = this.transport.handleSocketMessage(nodeId, socket, record);
    if (handled === undefined || handled) return;
    if (record.type === "node-agent.ping") {
      socket.send(JSON.stringify({ type: "control-plane.pong", nodeId, serverTime: new Date().toISOString() }));
      return;
    }
    if (record.type === "node-agent.identify") {
      socket.send(JSON.stringify({ type: "control-plane.identified", nodeId, serverTime: new Date().toISOString() }));
      if (this.transport.markHealthy(nodeId, socket) && this.onIdentified) {
        try {
          void Promise.resolve(this.onIdentified(nodeId)).catch(() => undefined);
        } catch {
          // Identification remains healthy when post-handshake refresh work fails.
        }
      }
      return;
    }
    socket.send(JSON.stringify({ type: "control-plane.error", code: "UNSUPPORTED_MESSAGE" }));
  }
}
