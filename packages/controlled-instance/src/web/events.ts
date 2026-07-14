import { eventTopic, type EventEnvelope } from "@task-handoff/protocol/events";

export type WebEvent<T = unknown> = {
  v: 1;
  id: string;
  seq: number;
  type: string;
  topic: string;
  createdAt: string;
  payload: T;
};

function eventId() {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

export class WebEventBus {
  private readonly clients = new Set<{ readyState: number; OPEN: number; send: (value: string) => void; on: (event: "close" | "message", listener: (value?: unknown) => void) => void; topics?: Set<string> }>();
  private seq = 0;

  connect(socket: { readyState: number; OPEN: number; send: (value: string) => void; on: (event: "close" | "message", listener: (value?: unknown) => void) => void }) {
    const client = socket as typeof socket & { topics?: Set<string> };
    client.topics = new Set(["*"]);
    this.clients.add(socket);
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("message", (value) => {
      const message = parseClientMessage(value);
      if (message?.type === "subscribe") {
        client.topics = new Set(message.topics?.length ? message.topics : ["*"]);
      }
    });
  }

  publish<T>(type: string, payload: T): WebEvent<T> {
    const event = this.createEvent(type, payload);
    const topic = event.topic;
    const encoded = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN && subscribed(client.topics, topic, type)) {
        client.send(encoded);
      }
    }
    return event;
  }

  send<T>(socket: { send: (value: string) => void }, type: string, payload: T) {
    const event = this.createEvent(type, payload);
    socket.send(JSON.stringify(event));
    return event;
  }

  private createEvent<T>(type: string, payload: T): EventEnvelope<T> {
    return {
      v: 1,
      id: eventId(),
      seq: ++this.seq,
      type,
      topic: eventTopic(type),
      createdAt: new Date().toISOString(),
      payload,
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
