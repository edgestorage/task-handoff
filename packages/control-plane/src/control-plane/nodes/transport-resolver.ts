import type { Node } from "@task-handoff/protocol/control-plane";
import type { NodeAgentTransport } from "./client.ts";

export type NodeAgentTransportResolverOptions = {
  direct: NodeAgentTransport;
  tunnel?: NodeAgentTransport;
  proxy?: NodeAgentTransport;
};

export class NodeAgentTransportResolver {
  private readonly direct: NodeAgentTransport;
  private tunnel: NodeAgentTransport | undefined;
  private proxy: NodeAgentTransport | undefined;

  constructor(options: NodeAgentTransportResolverOptions) {
    this.direct = options.direct;
    this.tunnel = options.tunnel;
    this.proxy = options.proxy;
  }

  setTunnel(transport: NodeAgentTransport) {
    this.tunnel = transport;
  }

  setProxy(transport: NodeAgentTransport) {
    this.proxy = transport;
  }

  resolve(node: Node): NodeAgentTransport {
    if (node.connectionEnabled === false) {
      const error = new Error("Node agent connection is disabled locally.");
      Object.assign(error, { statusCode: 409, code: "NODE_AGENT_CONNECTION_DISABLED" });
      throw error;
    }
    if (node.connectionMode === "control-plane-proxy") {
      if (!this.proxy) {
        const error = new Error("Control-plane proxy transport is not available.");
        Object.assign(error, { statusCode: 503, code: "CONTROL_PLANE_PROXY_TRANSPORT_UNAVAILABLE" });
        throw error;
      }
      return this.proxy;
    }
    if (node.connectionMode !== "reverse-wss") {
      return this.direct;
    }
    if (!this.tunnel) {
      const error = new Error("Reverse node agent transport is not available.");
      Object.assign(error, { statusCode: 503, code: "NODE_AGENT_REVERSE_TRANSPORT_UNAVAILABLE" });
      throw error;
    }
    return this.tunnel;
  }
}
