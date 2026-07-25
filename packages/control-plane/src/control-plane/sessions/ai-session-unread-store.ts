import crypto from "node:crypto";
import { z } from "zod";
import {
  AiSessionUnreadStateSchema,
  type AiSessionLifecycle,
  type AiSessionSummary,
  type AiSessionUnreadState,
  type AiSessionsSnapshot,
} from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import { JsonCollection } from "../../shared/persistence/store.ts";

const AiSessionUnreadRecordSchema = z.object({
  id: z.string().trim().min(1),
  instanceId: z.string().trim().min(1).max(160),
  sessionId: z.string().trim().min(1).max(120),
  unread: z.boolean(),
  lastStatus: z.enum(["running", "waiting", "idle", "failed"]),
  sessionUpdatedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

type AiSessionUnreadRecord = z.infer<typeof AiSessionUnreadRecordSchema>;
type UnreadListener = (state: AiSessionUnreadState) => void;

export class AiSessionUnreadStore {
  private readonly records: JsonCollection<AiSessionUnreadRecord>;
  private readonly bySession = new Map<string, AiSessionUnreadRecord>();
  private readonly listener?: UnreadListener;

  constructor(paths: ControlPlaneStorePaths, options: { onChanged?: UnreadListener } = {}) {
    this.records = new JsonCollection(paths.aiSessionUnreadDir, { schema: AiSessionUnreadRecordSchema });
    this.listener = options.onChanged;
  }

  init() {
    this.records.init();
    this.bySession.clear();
    for (const record of this.records.list()) this.bySession.set(sessionKey(record.instanceId, record.sessionId), record);
  }

  reconcile(instanceId: string, snapshot: AiSessionsSnapshot) {
    const present = new Set<string>();
    for (const session of snapshot.sessions) {
      present.add(session.id);
      this.reconcileSession(instanceId, session);
    }
    for (const record of [...this.bySession.values()]) {
      if (record.instanceId === instanceId && !present.has(record.sessionId)) this.deleteRecord(record);
    }
  }

  decorate(instanceId: string, snapshot: AiSessionsSnapshot) {
    return {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        unread: this.bySession.get(sessionKey(instanceId, session.id))?.unread || false,
      })),
    };
  }

  markRead(instanceId: string, sessionId: string, sessionUpdatedAt: string) {
    const current = this.bySession.get(sessionKey(instanceId, sessionId));
    if (!current || current.sessionUpdatedAt !== sessionUpdatedAt || !current.unread) {
      return current ? publicState(current) : undefined;
    }
    return publicState(this.store({ ...current, unread: false, updatedAt: new Date().toISOString() }, false));
  }

  removeInstance(instanceId: string) {
    for (const record of [...this.bySession.values()]) {
      if (record.instanceId === instanceId) this.deleteRecord(record);
    }
  }

  private reconcileSession(instanceId: string, session: AiSessionSummary) {
    const key = sessionKey(instanceId, session.id);
    const current = this.bySession.get(key);
    const timestamp = new Date().toISOString();
    if (!current) {
      this.store({
        id: recordId(instanceId, session.id),
        instanceId,
        sessionId: session.id,
        unread: false,
        lastStatus: session.status,
        sessionUpdatedAt: session.updatedAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, false);
      return;
    }
    const unread = nextUnread(current.unread, current.lastStatus, session.status);
    const changed = unread !== current.unread;
    if (!changed && current.lastStatus === session.status && current.sessionUpdatedAt === session.updatedAt) return;
    this.store({
      ...current,
      unread,
      lastStatus: session.status,
      sessionUpdatedAt: session.updatedAt,
      updatedAt: timestamp,
    }, changed);
  }

  private store(record: AiSessionUnreadRecord, notify: boolean) {
    const stored = this.records.put(record);
    this.bySession.set(sessionKey(stored.instanceId, stored.sessionId), stored);
    if (notify) this.listener?.(publicState(stored));
    return stored;
  }

  private deleteRecord(record: AiSessionUnreadRecord) {
    this.records.delete(record.id);
    this.bySession.delete(sessionKey(record.instanceId, record.sessionId));
  }
}

function nextUnread(current: boolean, previousStatus: AiSessionLifecycle, status: AiSessionLifecycle) {
  if (status === "running" || status === "waiting") return false;
  if (previousStatus === "running" || previousStatus === "waiting") return true;
  return current;
}

function publicState(record: AiSessionUnreadRecord) {
  return AiSessionUnreadStateSchema.parse({
    instanceId: record.instanceId,
    sessionId: record.sessionId,
    unread: record.unread,
    sessionUpdatedAt: record.sessionUpdatedAt,
    updatedAt: record.updatedAt,
  });
}

function sessionKey(instanceId: string, sessionId: string) {
  return `${instanceId}\u0000${sessionId}`;
}

function recordId(instanceId: string, sessionId: string) {
  return `ais_unread_${crypto.createHash("sha256").update(sessionKey(instanceId, sessionId)).digest("hex").slice(0, 32)}`;
}
