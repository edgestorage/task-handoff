import net from "node:net";
import type { FastifyInstance } from "fastify";
import {
  NodeAgentExternalListenerSchema,
  UpdateNodeAgentExternalListenerSchema,
  type NodeAgentExternalListener,
  type NodeAgentExternalListenerConfig,
} from "@task-handoff/protocol/control-plane";
import { JsonFile } from "../shared/persistence/store.ts";
import {
  externalListenerHost,
  type NodeAgentRuntimeSettings,
} from "./external-listener-settings.ts";

type ListenerState = {
  runningInstanceCount(): number;
  setListenerPort(port: number): void;
};

type ListenerSnapshot = {
  config: NodeAgentExternalListenerConfig;
  source: NodeAgentExternalListener["source"];
  status: NodeAgentExternalListener["status"];
  error?: string;
};

async function listenerPortAvailable(config: NodeAgentExternalListenerConfig) {
  const host = externalListenerHost(config.bindScope);
  const occupied = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: config.port });
    const finish = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
  if (occupied) return false;
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port: config.port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function allocateNodeAgentExternalListener(preferred: NodeAgentExternalListenerConfig, attempts = 20) {
  for (let offset = 0; offset < attempts && preferred.port + offset <= 65535; offset += 1) {
    const candidate = { ...preferred, port: preferred.port + offset };
    if (await listenerPortAvailable(candidate)) return candidate;
  }
  throw Object.assign(
    new Error(`No available node-agent port found starting at ${preferred.port}.`),
    { statusCode: 503, code: "NODE_AGENT_LISTENER_PORT_UNAVAILABLE" },
  );
}

export class NodeAgentExternalListenerManager {
  private readonly app: FastifyInstance;
  private readonly state: ListenerState;
  private readonly settings: JsonFile<NodeAgentRuntimeSettings>;
  private readonly sockets = new Set<net.Socket>();
  private config: NodeAgentExternalListenerConfig;
  private source: NodeAgentExternalListener["source"];
  private status: NodeAgentExternalListener["status"] = "error";
  private error?: string;
  private readonly onActiveListener?: (listener: NodeAgentExternalListener) => void;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(input: {
    app: FastifyInstance;
    state: ListenerState;
    settings: JsonFile<NodeAgentRuntimeSettings>;
    config: NodeAgentExternalListenerConfig;
    source: NodeAgentExternalListener["source"];
    onActiveListener?: (listener: NodeAgentExternalListener) => void;
  }) {
    this.app = input.app;
    this.state = input.state;
    this.settings = input.settings;
    this.config = input.config;
    this.source = input.source;
    this.onActiveListener = input.onActiveListener;
    this.app.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  current() {
    return NodeAgentExternalListenerSchema.parse({
      ...this.config,
      host: externalListenerHost(this.config.bindScope),
      status: this.status,
      source: this.source,
      ...(this.error ? { error: this.error } : {}),
    });
  }

  async start() {
    try {
      await this.listen(this.config);
      this.status = "listening";
      this.error = undefined;
      this.state.setListenerPort(this.config.port);
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.app.log.error(
        { host: externalListenerHost(this.config.bindScope), port: this.config.port, error: this.error },
        "node agent TCP listener failed to start",
      );
      throw Object.assign(
        new Error(`Failed to bind node agent TCP listener at ${externalListenerHost(this.config.bindScope)}:${this.config.port}: ${this.error}`),
        { statusCode: 409, code: "NODE_AGENT_LISTENER_BIND_FAILED" },
      );
    }
    const current = this.current();
    this.onActiveListener?.(current);
    return current;
  }

  update(input: unknown) {
    const operation = this.updateQueue.then(() => this.updateOnce(input));
    this.updateQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async updateOnce(input: unknown) {
    const candidate = UpdateNodeAgentExternalListenerSchema.parse(input);
    if (candidate.bindScope === this.config.bindScope && candidate.port === this.config.port) return this.current();
    if (candidate.port !== this.config.port) {
      const blockingInstanceCount = this.state.runningInstanceCount();
      if (blockingInstanceCount > 0) {
        throw Object.assign(
          new Error(`Cannot change the node agent port while ${blockingInstanceCount} controlled instance(s) are running.`),
          { statusCode: 409, code: "NODE_AGENT_LISTENER_PORT_IN_USE_BY_INSTANCES", blockingInstanceCount },
        );
      }
    }

    const previous = this.snapshot();
    await this.stop();
    try {
      await this.listen(candidate);
    } catch (error) {
      await this.restore(previous);
      throw Object.assign(
        new Error(`Failed to bind node agent TCP listener at ${externalListenerHost(candidate.bindScope)}:${candidate.port}: ${error instanceof Error ? error.message : String(error)}`),
        { statusCode: 409, code: "NODE_AGENT_LISTENER_BIND_FAILED" },
      );
    }

    try {
      this.settings.put({ version: 1, externalListener: candidate });
    } catch (error) {
      await this.stop();
      await this.restore(previous);
      throw Object.assign(
        new Error(`Failed to persist node agent TCP listener: ${error instanceof Error ? error.message : String(error)}`),
        { statusCode: 500, code: "NODE_AGENT_LISTENER_PERSIST_FAILED" },
      );
    }

    this.config = candidate;
    this.source = "persisted";
    this.status = "listening";
    this.error = undefined;
    this.state.setListenerPort(candidate.port);
    const current = this.current();
    this.onActiveListener?.(current);
    return current;
  }

  async shutdown() {
    await this.updateQueue;
    await this.stop();
  }

  private snapshot(): ListenerSnapshot {
    return { config: this.config, source: this.source, status: this.status, error: this.error };
  }

  private async restore(previous: ListenerSnapshot) {
    this.config = previous.config;
    this.source = previous.source;
    this.status = previous.status;
    this.error = previous.error;
    if (previous.status === "listening") {
      try {
        await this.listen(previous.config);
      } catch (error) {
        this.status = "error";
        this.error = `Failed to restore previous listener: ${error instanceof Error ? error.message : String(error)}`;
        this.app.log.error({ error: this.error }, "node agent TCP listener rollback failed");
      }
    }
    this.state.setListenerPort(previous.config.port);
    if (this.status === "listening") this.onActiveListener?.(this.current());
  }

  private async listen(config: NodeAgentExternalListenerConfig) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.app.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.app.server.off("error", onError);
        resolve();
      };
      this.app.server.once("error", onError);
      this.app.server.once("listening", onListening);
      this.app.server.listen({ host: externalListenerHost(config.bindScope), port: config.port });
    });
  }

  private async stop() {
    if (!this.app.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.app.server.close((error) => error ? reject(error) : resolve());
      for (const socket of this.sockets) socket.destroy();
    });
  }
}

type ListenerRequest = {
  ip?: string;
  socket: { remoteAddress?: string; remoteFamily?: string };
};

export function registerExternalListenerSettingsRoutes(
  app: FastifyInstance,
  requireManager: (request: ListenerRequest) => NodeAgentExternalListenerManager,
) {
  app.get("/api/node-agent/settings/external-listener", async (request) => ({
    data: requireManager(request).current(),
  }));
  app.patch("/api/node-agent/settings/external-listener", async (request) => ({
    data: await requireManager(request).update(request.body),
  }));
}
