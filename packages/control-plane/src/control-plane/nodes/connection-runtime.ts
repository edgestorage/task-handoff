import type { Node } from "@task-handoff/protocol/control-plane";

export type NodeConnectionTransport = "direct-http" | "reverse-wss";
export type NodeConnectionRuntimePhase = "connecting" | "handshaking" | "healthy" | "reconnecting" | "suspect" | "offline";

export type NodeConnectionObservation = {
  nodeId: string;
  transport: NodeConnectionTransport;
  generation: number;
  phase: NodeConnectionRuntimePhase;
  changedAt: string;
  connectedAt?: string;
  lastSeenAt?: string;
  lastPongAt?: string;
  consecutiveFailures: number;
  nextRetryAt?: string;
  closeCode?: number;
  error?: string;
};

export type NodeConnectionProjection = Node & {
  connectionPhase?: NodeConnectionRuntimePhase;
};

type ObservationUpdate = Partial<Omit<NodeConnectionObservation, "nodeId" | "transport" | "generation" | "changedAt">>;

export class NodeConnectionRuntime {
  private readonly observations = new Map<string, NodeConnectionObservation>();
  private readonly listeners = new Set<(observation: NodeConnectionObservation) => void>();

  begin(nodeId: string, transport: NodeConnectionTransport, phase: NodeConnectionRuntimePhase = "connecting") {
    const previous = this.observations.get(nodeId);
    const observation: NodeConnectionObservation = {
      nodeId,
      transport,
      generation: (previous?.generation || 0) + 1,
      phase,
      changedAt: new Date().toISOString(),
      consecutiveFailures: previous?.transport === transport ? previous.consecutiveFailures : 0,
    };
    this.observations.set(nodeId, observation);
    this.publish(observation);
    return observation.generation;
  }

  update(nodeId: string, generation: number, update: ObservationUpdate, notify = true) {
    const current = this.observations.get(nodeId);
    if (!current || current.generation !== generation) return false;
    const observation = {
      ...current,
      ...update,
      changedAt: new Date().toISOString(),
    };
    this.observations.set(nodeId, observation);
    if (notify) this.publish(observation);
    return true;
  }

  connected(nodeId: string, generation: number) {
    const timestamp = new Date().toISOString();
    return this.update(nodeId, generation, {
      phase: "healthy",
      connectedAt: timestamp,
      lastSeenAt: timestamp,
      nextRetryAt: undefined,
      error: undefined,
    });
  }

  pong(nodeId: string, generation: number) {
    const timestamp = new Date().toISOString();
    return this.update(nodeId, generation, { lastSeenAt: timestamp, lastPongAt: timestamp }, false);
  }

  stable(nodeId: string, generation: number) {
    return this.update(nodeId, generation, { consecutiveFailures: 0 }, false);
  }

  observedReachable(node: Node) {
    if (node.connectionMode === "control-plane-proxy") return false;
    const transport: NodeConnectionTransport = node.connectionMode === "reverse-wss" ? "reverse-wss" : "direct-http";
    const current = this.observations.get(node.id);
    const generation = current?.transport === transport
      ? current.generation
      : this.begin(node.id, transport, "handshaking");
    return this.connected(node.id, generation);
  }

  observedFailure(node: Node, error: string) {
    if (node.connectionMode === "control-plane-proxy") return false;
    const transport: NodeConnectionTransport = node.connectionMode === "reverse-wss" ? "reverse-wss" : "direct-http";
    const current = this.observations.get(node.id);
    if (current?.transport === transport && current.phase === "healthy") {
      return true;
    }
    const generation = current?.transport === transport
      ? current.generation
      : this.begin(node.id, transport, "connecting");
    return this.disconnected(node.id, generation, { error });
  }

  disconnected(nodeId: string, generation: number, input: { error?: string; closeCode?: number; nextRetryAt?: string } = {}) {
    const current = this.observations.get(nodeId);
    if (!current || current.generation !== generation) return false;
    return this.update(nodeId, generation, {
      phase: input.nextRetryAt ? "reconnecting" : "offline",
      consecutiveFailures: current.consecutiveFailures + 1,
      closeCode: input.closeCode,
      error: input.error,
      nextRetryAt: input.nextRetryAt,
    });
  }

  observation(nodeId: string) {
    return this.observations.get(nodeId);
  }

  onChange(listener: (observation: NodeConnectionObservation) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  project(node: Node): NodeConnectionProjection {
    if (node.connectionEnabled === false) {
      return { ...node, status: "offline", health: "failed", connectionPhase: "offline" };
    }
    if (node.connectionMode !== "direct-http" && node.connectionMode !== "reverse-wss" && node.connectionMode !== "local-ipc" && node.connectionMode !== "local-loopback") {
      return node;
    }
    const observation = this.observations.get(node.id);
    const expectedTransport: NodeConnectionTransport = node.connectionMode === "reverse-wss" ? "reverse-wss" : "direct-http";
    if (!observation || observation.transport !== expectedTransport) {
      return node;
    }
    // A direct node's HTTP health check is the authority for node reachability.
    // Its event WebSocket is a secondary stream: reconnecting it must not make a
    // node with a healthy control API appear offline.
    if (expectedTransport === "direct-http") {
      return {
        ...node,
        lastSeenAt: observation.lastSeenAt || node.lastSeenAt,
        connectionPhase: observation.phase,
      };
    }
    if (observation.phase === "healthy") {
      return { ...node, status: "online", health: node.health === "unknown" ? "ok" : node.health, lastSeenAt: observation.lastSeenAt || observation.connectedAt, connectionPhase: observation.phase };
    }
    if (observation.phase === "connecting" || observation.phase === "handshaking" || observation.phase === "reconnecting" || observation.phase === "suspect") {
      return { ...node, status: "offline", health: "degraded", lastSeenAt: observation.lastSeenAt, connectionPhase: observation.phase };
    }
    return { ...node, status: "offline", health: "failed", lastSeenAt: observation.lastSeenAt, connectionPhase: observation.phase };
  }

  diagnostics() {
    return [...this.observations.values()].map((observation) => ({ ...observation }));
  }

  private publish(observation: NodeConnectionObservation) {
    for (const listener of this.listeners) listener({ ...observation });
  }
}
