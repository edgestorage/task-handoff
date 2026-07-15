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
};

function eventId() {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

export class ControlPlaneEventBus {
  private readonly clients = new Set<EventSocket>();
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private seq = 0;

  connect(socket: EventSocket) {
    socket.topics = new Set(["*"]);
    this.clients.add(socket);
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("message", (value) => {
      const message = parseClientMessage(value);
      if (message?.type === "subscribe") {
        socket.topics = new Set(message.topics?.length ? message.topics : ["*"]);
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
      if (client.readyState === client.OPEN && subscribed(client.topics, topic, type)) {
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

function parseClientMessage(value: unknown): { type?: string; topics?: string[] } | undefined {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed as { type?: string; topics?: string[] } : undefined;
  } catch {
    return undefined;
  }
}
