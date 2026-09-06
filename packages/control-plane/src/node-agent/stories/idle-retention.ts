import crypto from "node:crypto";
import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import type { NodeAgentState } from "../state.ts";
import type { NodeStoryStore } from "./store.ts";

// Compatibility for v0.0.28 controlled instances: updatedAt may be absent.
// Candidates without either timestamp are not safe to order for deletion.
type IdleCandidate = { sessionId: string; storyId: string; status: "idle"; completedAt?: string; updatedAt?: string };
type InstanceIdleCandidate = { sessionId: string; status: "idle"; completedAt?: string; updatedAt?: string };

const INSTANCE_MAX_IDLE_AI_SESSIONS = 100;

/** Enforces Story's idle-session budget without owning Session state. */
export class StoryIdleSessionRetentionCoordinator {
  private readonly closed = new Set<string>();
  private readonly pending = new Set<string>();
  private reconciliation?: Promise<void>;
  private readonly state: NodeAgentState;
  private readonly stories: NodeStoryStore;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;
  private readonly warn: (data: Record<string, unknown>, message: string) => void;

  constructor(
    state: NodeAgentState,
    stories: NodeStoryStore,
    fetchImpl: typeof fetch,
    resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>,
    warn: (data: Record<string, unknown>, message: string) => void,
  ) {
    this.state = state;
    this.stories = stories;
    this.fetchImpl = fetchImpl;
    this.resolveInstanceWeb = resolveInstanceWeb;
    this.warn = warn;
  }

  reconcile() {
    if (this.reconciliation) return this.reconciliation;
    const reconciliation = this.reconcileOnce().finally(() => {
      if (this.reconciliation === reconciliation) this.reconciliation = undefined;
    });
    this.reconciliation = reconciliation;
    return reconciliation;
  }

  private async reconcileOnce() {
    const candidatesByStory = new Map<string, Array<IdleCandidate & { instance: ControlledInstance }>>();
    const observed = new Set<string>();
    const closing: Promise<void>[] = [];
    for (const instance of this.state.listInstances()) {
      if (!instance.registrationToken) continue;
      let response: Response;
      try {
        response = await this.fetchImpl(`${await this.resolveInstanceWeb(instance)}/api/internal/node-agent/ai-sessions/idle-retention`, {
          headers: { authorization: `Bearer ${instance.registrationToken}` },
        });
      } catch (error) {
        this.warn({ instanceId: instance.id, error: error instanceof Error ? error.message : String(error) }, "could not inspect Story idle sessions");
        continue;
      }
      if (!response.ok) continue;
      const payload = await response.json().catch(() => ({})) as { data?: unknown };
      if (!Array.isArray(payload.data)) continue;
      for (const value of payload.data) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as Partial<IdleCandidate>;
        if (typeof candidate.sessionId !== "string" || typeof candidate.storyId !== "string" || candidate.status !== "idle") continue;
        if (retentionTimestamp(candidate) === undefined) continue;
        if (!await this.stories.exists(candidate.storyId)) continue;
        const key = `${instance.id}:${candidate.sessionId}`;
        observed.add(key);
        if (this.closed.has(key)) continue;
        const group = candidatesByStory.get(candidate.storyId) || [];
        group.push({ instance, sessionId: candidate.sessionId, storyId: candidate.storyId, status: "idle", completedAt: candidate.completedAt, updatedAt: candidate.updatedAt });
        candidatesByStory.set(candidate.storyId, group);
      }
    }
    for (const [storyId, candidates] of candidatesByStory) {
      const limit = (await this.stories.retentionSettings(storyId)).maxIdleAiSessions;
      while (candidates.length > limit) {
        candidates.sort((a, b) => (retentionTimestamp(a)! - retentionTimestamp(b)!) || `${a.instance.id}:${a.sessionId}`.localeCompare(`${b.instance.id}:${b.sessionId}`));
        const target = candidates.shift()!;
        const key = `${target.instance.id}:${target.sessionId}`;
        if (this.pending.has(key)) continue;
        this.pending.add(key);
        closing.push(this.close(target, key).catch((error) => {
          this.warn({ storyId, instanceId: target.instance.id, sessionId: target.sessionId, error: error instanceof Error ? error.message : String(error) }, "Story idle Session retention close failed");
          setTimeout(() => { void this.reconcile(); }, 5_000).unref?.();
        }));
      }
    }
    await Promise.all(closing);
    for (const key of this.closed) if (!observed.has(key)) this.closed.delete(key);
  }

  private async close(target: IdleCandidate & { instance: ControlledInstance }, key: string) {
    try {
      const response = await this.fetchImpl(`${await this.resolveInstanceWeb(target.instance)}/api/internal/node-agent/ai-sessions/${encodeURIComponent(target.sessionId)}/close`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.instance.registrationToken}` },
        body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
      });
      if (response.status === 204) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.closed.add(key);
    } finally {
      this.pending.delete(key);
    }
  }
}

/** Enforces the per-instance idle-session budget without owning Session state. */
export class InstanceIdleSessionRetentionCoordinator {
  private readonly closed = new Set<string>();
  private readonly pending = new Set<string>();
  private reconciliation?: Promise<void>;
  private readonly state: NodeAgentState;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;
  private readonly warn: (data: Record<string, unknown>, message: string) => void;

  constructor(
    state: NodeAgentState,
    fetchImpl: typeof fetch,
    resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>,
    warn: (data: Record<string, unknown>, message: string) => void,
  ) {
    this.state = state;
    this.fetchImpl = fetchImpl;
    this.resolveInstanceWeb = resolveInstanceWeb;
    this.warn = warn;
  }

  reconcile() {
    if (this.reconciliation) return this.reconciliation;
    const reconciliation = this.reconcileOnce().finally(() => {
      if (this.reconciliation === reconciliation) this.reconciliation = undefined;
    });
    this.reconciliation = reconciliation;
    return reconciliation;
  }

  private async reconcileOnce() {
    const candidatesByInstance = new Map<string, Array<InstanceIdleCandidate & { instance: ControlledInstance }>>();
    const observed = new Set<string>();
    const closing: Promise<void>[] = [];
    for (const instance of this.state.listInstances()) {
      if (!instance.registrationToken) continue;
      let response: Response;
      try {
        response = await this.fetchImpl(`${await this.resolveInstanceWeb(instance)}/api/internal/node-agent/ai-sessions/instance-idle-retention`, {
          headers: { authorization: `Bearer ${instance.registrationToken}` },
        });
      } catch (error) {
        this.warn({ instanceId: instance.id, error: error instanceof Error ? error.message : String(error) }, "could not inspect instance idle sessions");
        continue;
      }
      if (!response.ok) continue;
      const payload = await response.json().catch(() => ({})) as { data?: unknown };
      if (!Array.isArray(payload.data)) continue;
      for (const value of payload.data) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as Partial<InstanceIdleCandidate>;
        if (typeof candidate.sessionId !== "string" || candidate.status !== "idle") continue;
        if (retentionTimestamp(candidate) === undefined) continue;
        const key = `${instance.id}:${candidate.sessionId}`;
        observed.add(key);
        if (this.closed.has(key)) continue;
        const group = candidatesByInstance.get(instance.id) || [];
        group.push({ instance, sessionId: candidate.sessionId, status: "idle", completedAt: candidate.completedAt, updatedAt: candidate.updatedAt });
        candidatesByInstance.set(instance.id, group);
      }
    }
    for (const [instanceId, candidates] of candidatesByInstance) {
      while (candidates.length > INSTANCE_MAX_IDLE_AI_SESSIONS) {
        candidates.sort((a, b) => (retentionTimestamp(a)! - retentionTimestamp(b)!) || `${a.instance.id}:${a.sessionId}`.localeCompare(`${b.instance.id}:${b.sessionId}`));
        const target = candidates.shift()!;
        const key = `${target.instance.id}:${target.sessionId}`;
        if (this.pending.has(key)) continue;
        this.pending.add(key);
        closing.push(this.close(target, key).catch((error) => {
          this.warn({ instanceId, sessionId: target.sessionId, error: error instanceof Error ? error.message : String(error) }, "Instance idle Session retention close failed");
          setTimeout(() => { void this.reconcile(); }, 5_000).unref?.();
        }));
      }
    }
    await Promise.all(closing);
    for (const key of this.closed) if (!observed.has(key)) this.closed.delete(key);
  }

  private async close(target: InstanceIdleCandidate & { instance: ControlledInstance }, key: string) {
    try {
      const response = await this.fetchImpl(`${await this.resolveInstanceWeb(target.instance)}/api/internal/node-agent/ai-sessions/${encodeURIComponent(target.sessionId)}/close`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.instance.registrationToken}` },
        body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
      });
      if (response.status === 204) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.closed.add(key);
    } finally {
      this.pending.delete(key);
    }
  }
}

function retentionTimestamp(candidate: { completedAt?: string; updatedAt?: string }) {
  return timestamp(candidate.completedAt) ?? timestamp(candidate.updatedAt);
}

function timestamp(value: string | undefined) {
  const parsed = value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  return Number.isFinite(parsed) ? parsed : undefined;
}
