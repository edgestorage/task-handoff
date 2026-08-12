import { eventTopic, type EventEnvelope, type EventScope } from "@task-handoff/protocol/events";

export type ControlPlaneEvent<T = unknown> = {
  v: 1;
  id: string;
  seq: number;
  type: string;
  topic: string;
  createdAt: string;
  payload: T;
  scope?: EventScope;
};

type EventSocket = {
  readyState: number;
  OPEN: number;
  send: (value: string) => void;
  on: (event: "close" | "message", listener: (value?: unknown) => void) => void;
  topics?: Set<string>;
  instanceIds?: Set<string>;
};

function eventId() {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

export class ControlPlaneEventBus {
  private readonly clients = new Set<EventSocket>();
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private seq = 0;

  connect(socket: EventSocket, options: { instanceIds?: string[] } = {}) {
    socket.topics = new Set(["*"]);
    socket.instanceIds = options.instanceIds?.length ? new Set(options.instanceIds) : undefined;
    this.clients.add(socket);
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("message", (value) => {
      const message = parseClientMessage(value);
      if (message?.type === "subscribe") {
        socket.topics = new Set(message.topics?.length ? message.topics : ["*"]);
        socket.instanceIds = message.instanceIds?.length ? new Set(message.instanceIds) : undefined;
      }
    });
  }

  publish<T>(type: string, payload: T, options: { scope?: EventScope; topic?: string } = {}): ControlPlaneEvent<T> {
    const event = this.createEvent(type, payload, options);
    const topic = event.topic;
    const encoded = JSON.stringify(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
    for (const client of this.clients) {
      if (client.readyState === client.OPEN && subscribed(client.topics, topic, type) && subscribedInstance(client.instanceIds, event.scope)) {
        try {
          client.send(encoded);
        } catch {
          this.clients.delete(client);
        }
      }
    }
    return event;
  }

  on(listener: (event: EventEnvelope) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  send<T>(socket: { send: (value: string) => void }, type: string, payload: T, options: { scope?: EventScope; topic?: string } = {}) {
    const event = this.createEvent(type, payload, options);
    socket.send(JSON.stringify(event));
    return event;
  }

  private createEvent<T>(type: string, payload: T, options: { scope?: EventScope; topic?: string } = {}): EventEnvelope<T> {
    return {
      v: 1,
      id: eventId(),
      seq: ++this.seq,
      type,
      topic: options.topic || eventTopic(type),
      createdAt: new Date().toISOString(),
      payload,
      scope: options.scope,
    };
  }
}

function subscribed(topics: Set<string> | undefined, topic: string, type: string) {
  return !topics || topics.has("*") || topics.has(topic) || topics.has(type);
}

function subscribedInstance(instanceIds: Set<string> | undefined, scope: EventScope | undefined) {
  return !instanceIds || !scope?.instanceId || instanceIds.has(scope.instanceId);
}

function parseClientMessage(value: unknown): { type?: string; topics?: string[]; instanceIds?: string[] } | undefined {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const message = parsed as { type?: string; topics?: unknown; instanceIds?: unknown };
    return {
      type: message.type,
      topics: Array.isArray(message.topics) ? message.topics.map(String).filter(Boolean) : undefined,
      instanceIds: Array.isArray(message.instanceIds) ? message.instanceIds.map(String).map((id) => id.trim()).filter(Boolean) : undefined,
    };
  } catch {
    return undefined;
  }
}
