import { AiSessionTransientSubscriptionSchema, aiSessionTransientSubscriptionAccepts, eventTopic, type AiSessionTransientSubscription, type EventEnvelope } from "@task-handoff/protocol/events";

export type WebEvent<T = unknown> = {
  v: 1;
  id: string;
  seq: number;
  type: string;
  topic: string;
  createdAt: string;
  payload: T;
};

type WebEventClient = {
  readyState: number;
  OPEN: number;
  bufferedAmount?: number;
  send: (value: string) => void;
  close?: (code?: number, reason?: string) => void;
  on: (event: "close" | "message", listener: (value?: unknown) => void) => void;
  topics?: Set<string>;
  aiSessionTransient?: AiSessionTransientSubscription;
};

const MAX_EVENT_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_TRANSIENT_REPLAY_BYTES = 32 * 1024 * 1024;
const MAX_TRANSIENT_REPLAY_EVENTS = 20_000;

type RetainedTransientEvent = { event: WebEvent; encoded: string; bytes: number };

function eventId() {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

export class WebEventBus {
  private readonly clients = new Set<WebEventClient>();
  private readonly transientReplay: RetainedTransientEvent[] = [];
  private transientReplayBytes = 0;
  private seq = 0;

  connect(socket: { readyState: number; OPEN: number; send: (value: string) => void; on: (event: "close" | "message", listener: (value?: unknown) => void) => void }, options: { expectsTransientSubscription?: boolean } = {}) {
    const client = socket as WebEventClient;
    client.topics = new Set(["*"]);
    if (options.expectsTransientSubscription) client.aiSessionTransient = AiSessionTransientSubscriptionSchema.parse({});
    this.clients.add(socket);
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("message", (value) => {
      const message = parseClientMessage(value);
      if (message?.type === "subscribe") {
        client.topics = new Set(message.topics === undefined ? ["*"] : message.topics);
        client.aiSessionTransient = message.aiSessionTransient;
        if (message.aiSessionTransient?.replaySince) this.replayTransient(client, message.aiSessionTransient.replaySince);
      }
    });
  }

  publish<T>(type: string, payload: T): WebEvent<T> {
    this.pruneSettledMessageReplay(type, payload);
    const event = this.createEvent(type, payload);
    const topic = event.topic;
    const encoded = JSON.stringify(event);
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    this.retainTransient(event, encoded, encodedBytes);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN && subscribed(client.topics, topic, type) && aiSessionTransientSubscriptionAccepts(client.aiSessionTransient, event)) {
        this.sendClient(client, encoded, encodedBytes);
      }
    }
    return event;
  }

  private retainTransient(event: WebEvent, encoded: string, bytes: number) {
    if (event.type !== "ai-session.message-delta" && event.type !== "ai-session.timeline-item") return;
    this.transientReplay.push({ event, encoded, bytes });
    this.transientReplayBytes += bytes;
    while (this.transientReplay.length > MAX_TRANSIENT_REPLAY_EVENTS || this.transientReplayBytes > MAX_TRANSIENT_REPLAY_BYTES) {
      this.transientReplayBytes -= this.transientReplay.shift()!.bytes;
    }
  }

  private replayTransient(client: WebEventClient, replaySince: string) {
    for (const retained of this.transientReplay) {
      // A running message snapshot does not necessarily contain its streamed
      // prefix. Retain/replay the whole active item until a terminal authority
      // event settles it; Timeline history is recoverable over HTTP and uses
      // the connection-scoped cursor.
      if (retained.event.type !== "ai-session.message-delta" && retained.event.createdAt < replaySince) continue;
      if (!subscribed(client.topics, retained.event.topic, retained.event.type)) continue;
      if (!aiSessionTransientSubscriptionAccepts(client.aiSessionTransient, retained.event)) continue;
      const replay = JSON.stringify({ ...retained.event, replay: true });
      if (!this.sendClient(client, replay, Buffer.byteLength(replay, "utf8"))) break;
    }
  }

  private pruneSettledMessageReplay(type: string, payload: unknown) {
    if (type !== "ai-session.snapshot" && type !== "ai-session.patch" && type !== "ai-session.removed") return;
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const removedSessionIds = new Set<string>(type === "ai-session.removed" && Array.isArray(record.sessionIds)
      ? record.sessionIds.map(String)
      : []);
    const snapshot = record.snapshot && typeof record.snapshot === "object" && !Array.isArray(record.snapshot)
      ? record.snapshot as Record<string, unknown>
      : undefined;
    const sessions = Array.isArray(snapshot?.sessions)
      ? snapshot.sessions
      : Array.isArray(record.upserted) ? record.upserted : [];
    const settledTurns = new Set<string>();
    for (const value of sessions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const session = value as Record<string, unknown>;
      const sessionId = String(session.id || "");
      const turns = Array.isArray(session.turns) ? session.turns : [];
      for (const turnValue of turns) {
        if (!turnValue || typeof turnValue !== "object" || Array.isArray(turnValue)) continue;
        const turn = turnValue as Record<string, unknown>;
        if (turn.status === "completed" || turn.status === "failed") {
          settledTurns.add(`${sessionId}\0${String(turn.id || "")}`);
          if (turn.providerTurnId) settledTurns.add(`${sessionId}\0${String(turn.providerTurnId)}`);
        }
      }
      if (!turns.length && sessionId && session.status !== "running" && session.status !== "waiting") removedSessionIds.add(sessionId);
    }
    if (!removedSessionIds.size && !settledTurns.size) return;
    const retained = this.transientReplay.filter((entry) => {
      if (entry.event.type !== "ai-session.message-delta") return true;
      const eventPayload = entry.event.payload && typeof entry.event.payload === "object" && !Array.isArray(entry.event.payload)
        ? entry.event.payload as Record<string, unknown>
        : {};
      const sessionId = String(eventPayload.sessionId || "");
      return !removedSessionIds.has(sessionId) && !settledTurns.has(`${sessionId}\0${String(eventPayload.turnId || "")}`);
    });
    if (retained.length === this.transientReplay.length) return;
    this.transientReplay.splice(0, this.transientReplay.length, ...retained);
    this.transientReplayBytes = retained.reduce((total, entry) => total + entry.bytes, 0);
  }

  private sendClient(client: WebEventClient, encoded: string, bytes: number) {
    if (client.readyState !== client.OPEN) return false;
    if ((client.bufferedAmount ?? 0) + bytes > MAX_EVENT_CLIENT_BUFFERED_BYTES) {
      this.clients.delete(client);
      try { client.close?.(1013, "Event consumer is too slow."); } catch { /* Consumer cleanup is already complete. */ }
      return false;
    }
    try {
      client.send(encoded);
      return true;
    } catch {
      this.clients.delete(client);
      try { client.close?.(1011, "Event delivery failed."); } catch { /* Consumer cleanup is already complete. */ }
      return false;
    }
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

function parseClientMessage(value: unknown): { type?: string; topics?: string[]; aiSessionTransient?: AiSessionTransientSubscription } | undefined {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const message = parsed as { type?: string; topics?: string[]; aiSessionTransient?: unknown };
    const transient = message.aiSessionTransient === undefined ? undefined : AiSessionTransientSubscriptionSchema.safeParse(message.aiSessionTransient);
    if (transient && !transient.success) return undefined;
    return {
      type: message.type,
      topics: Array.isArray(message.topics) ? message.topics.map(String).filter(Boolean) : undefined,
      ...(transient?.success ? { aiSessionTransient: transient.data } : {}),
    };
  } catch {
    return undefined;
  }
}
