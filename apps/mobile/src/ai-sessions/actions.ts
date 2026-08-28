import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { AiSessionForkResult, AiSessionMessageAttachmentRef, AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort, AiSessionSendMode } from '@task-handoff/protocol/ai-sessions';

import type { ValueStore } from '../platform/secure-storage';
import type { MobileAiSessionStore } from './store';
import { mobileMetrics } from '../observability/mobile-metrics';

export type MobileAiSessionAction = 'send' | 'approval' | 'interrupt' | 'close' | 'fork' | 'model-selection' | 'reasoning-effort' | 'queue-steer' | 'queue-retry' | 'queue-remove' | 'queue-edit' | 'queue-reorder';
export type MobileActionState = { phase: 'idle' | 'busy' | 'result-unknown' | 'failed'; error?: string };
export type MobileActionResult<T> =
  | { disposition: 'accepted'; result: T }
  | { disposition: 'duplicate-blocked' }
  | { disposition: 'failed' | 'result-unknown'; error: string };

export function mobileAiSessionBusyKey(controlPlaneId: string, instanceId: string, sessionId: string, action: MobileAiSessionAction, queueId?: string) {
  return JSON.stringify([controlPlaneId, instanceId, sessionId, action, queueId || '']);
}

export class MobileAiSessionActionCoordinator {
  private readonly states = new Map<string, MobileActionState>();
  private readonly listeners = new Set<() => void>();
  private readonly forkRequestIds = new Map<string, string>();
  private readonly storeGeneration: number;

  constructor(
    private readonly controlPlaneId: string,
    private readonly client: ControlPlaneClient,
    private readonly store: MobileAiSessionStore,
  ) {
    this.storeGeneration = store.generation(controlPlaneId);
  }

  state(key: string) { return this.states.get(key) ?? { phase: 'idle' as const }; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  send(instanceId: string, sessionId: string, message: string, permissionMode?: AiSessionPermissionMode, attachments: AiSessionMessageAttachmentRef[] = [], mode: AiSessionSendMode = 'auto') {
    return this.run(instanceId, sessionId, 'send', undefined, () => this.client.aiSessions.sendMessage(instanceId, sessionId, {
      message, mode, permissionMode, attachments,
    }));
  }
  approval(instanceId: string, sessionId: string, decision: 'allow' | 'deny' | 'skip') {
    return this.run(instanceId, sessionId, 'approval', undefined, () => this.client.aiSessions.approval(instanceId, sessionId, decision));
  }
  interrupt(instanceId: string, sessionId: string) {
    return this.run(instanceId, sessionId, 'interrupt', undefined, () => this.client.aiSessions.interrupt(instanceId, sessionId));
  }
  close(instanceId: string, sessionId: string, clientRequestId: string) {
    return this.run(instanceId, sessionId, 'close', undefined, () => this.client.aiSessions.close(instanceId, sessionId, clientRequestId));
  }
  updateModelSelection(instanceId: string, sessionId: string, clientRequestId: string, selection: AiSessionModelSelection) {
    return this.run(instanceId, sessionId, 'model-selection', undefined, () => this.client.aiSessions.updateModelSelection(instanceId, sessionId, clientRequestId, selection));
  }
  updateReasoningEffort(instanceId: string, sessionId: string, clientRequestId: string, effort: AiSessionReasoningEffort) {
    return this.run(instanceId, sessionId, 'reasoning-effort', undefined, () => this.client.aiSessions.updateReasoningEffort(instanceId, sessionId, clientRequestId, effort));
  }
  async fork(instanceId: string, sessionId: string, throughTurnId: string, proposedClientRequestId: string) {
    const requestKey = JSON.stringify([instanceId, sessionId, throughTurnId]);
    const clientRequestId = this.forkRequestIds.get(requestKey) ?? proposedClientRequestId;
    this.forkRequestIds.set(requestKey, clientRequestId);
    const input = { clientRequestId, throughTurnId, workspace: { mode: 'current' as const } };
    const knownForkIds = new Set(this.matchingForks(instanceId, sessionId, throughTurnId).map((session) => session.id));
    const result = await this.run<AiSessionForkResult>(instanceId, sessionId, 'fork', throughTurnId, async () => {
      try {
        return await this.client.aiSessions.fork(instanceId, sessionId, input);
      } catch (cause) {
        if (!isUncertainFailure(cause)) throw cause;
        await this.recover().catch(() => undefined);
        const recovered = this.matchingForks(instanceId, sessionId, throughTurnId)
          .find((session) => !knownForkIds.has(session.id) && session.providerSessionId);
        if (recovered?.providerSessionId) return {
          disposition: 'already-created',
          aiSessionId: recovered.id,
          providerSessionId: recovered.providerSessionId,
          creationSource: 'ai-session',
        };
        // Fork is idempotent by clientRequestId. Replaying the same request is
        // the only safe way to distinguish a lost response from no commit.
        return this.client.aiSessions.fork(instanceId, sessionId, input);
      }
    }, () => JSON.stringify(this.matchingForks(instanceId, sessionId, throughTurnId).map((session) => session.id).sort()), true);
    if (result.disposition === 'accepted') this.forkRequestIds.delete(requestKey);
    return result;
  }
  queue(instanceId: string, sessionId: string, queueId: string, action: 'steer' | 'retry' | 'remove') {
    const kind = `queue-${action}` as const;
    return this.run<unknown>(instanceId, sessionId, kind, queueId, () => (
      action === 'steer' ? this.client.aiSessions.steerQueue(instanceId, sessionId, queueId)
        : action === 'retry' ? this.client.aiSessions.retryQueue(instanceId, sessionId, queueId)
          : this.client.aiSessions.removeQueue(instanceId, sessionId, queueId)
    ));
  }
  editQueue(instanceId: string, sessionId: string, queueId: string, expectedRevision: number, message: string) {
    return this.run(instanceId, sessionId, 'queue-edit', queueId, () => this.client.aiSessions.editQueue(instanceId, sessionId, queueId, { expectedRevision, message }));
  }
  reorderQueue(instanceId: string, sessionId: string, expectedRevision: number, queueIds: string[]) {
    return this.run(instanceId, sessionId, 'queue-reorder', undefined, () => this.client.aiSessions.reorderQueue(instanceId, sessionId, { expectedRevision, queueIds }));
  }

  private async run<T>(instanceId: string, sessionId: string, action: MobileAiSessionAction, queueId: string | undefined, operation: () => Promise<T>, fingerprint?: () => string, allowResultUnknownRetry = false): Promise<MobileActionResult<T>> {
    const key = mobileAiSessionBusyKey(this.controlPlaneId, instanceId, sessionId, action, queueId);
    const phase = this.state(key).phase;
    if (phase === 'busy' || (phase === 'result-unknown' && !allowResultUnknownRetry)) return { disposition: 'duplicate-blocked' as const };
    const authoritativeFingerprint = fingerprint ?? (() => this.authoritativeFingerprint(instanceId, sessionId, queueId));
    const before = authoritativeFingerprint();
    this.set(key, { phase: 'busy' });
    let result: T;
    try {
      result = await operation();
    } catch (cause) {
      const uncertain = isUncertainFailure(cause);
      const error = uncertain
        ? 'The result is unknown. The request will not be sent again; refresh the authoritative session state.'
        : cause instanceof Error ? cause.message : 'The action failed.';
      this.set(key, {
        phase: uncertain ? 'result-unknown' : 'failed',
        error,
      });
      mobileMetrics.record('action.error', { action, result: uncertain ? 'unknown' : 'failed' });
      if (uncertain) {
        await this.recover().then(() => {
          if (!this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
          if (authoritativeFingerprint() !== before) this.set(key, { phase: 'idle' });
        }).catch(() => undefined);
      }
      return { disposition: uncertain ? 'result-unknown' : 'failed', error };
    }
    this.set(key, { phase: 'idle' });
    return { disposition: 'accepted' as const, result };
  }

  private async recover() {
    const snapshot = await this.client.aiSessions.list();
    if (this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) this.store.replaceSnapshot(this.controlPlaneId, snapshot);
  }

  private set(key: string, state: MobileActionState) {
    this.states.set(key, state);
    for (const listener of this.listeners) listener();
  }

  private authoritativeFingerprint(instanceId: string, sessionId: string, queueId?: string) {
    const session = this.store.session(this.controlPlaneId, instanceId, sessionId);
    if (!session) return 'missing';
    if (queueId) return JSON.stringify(session.queue.items.find((item) => item.id === queueId) ?? null);
    return JSON.stringify({ status: session.status, phase: session.phase, updatedAt: session.updatedAt, actions: session.actions, queue: session.queue, modelSelection: session.modelSelection });
  }

  private matchingForks(instanceId: string, sessionId: string, throughTurnId: string) {
    const source = this.store.session(this.controlPlaneId, instanceId, sessionId);
    if (!source?.providerSessionId) return [];
    return this.store.snapshot(this.controlPlaneId)?.instances
      .find((instance) => instance.instanceId === instanceId)
      ?.aiSessions.sessions.filter((session) => (
        session.lineage?.kind === 'fork'
        && session.lineage.parentProviderSessionId === source.providerSessionId
        && session.lineage.throughTurnId === throughTurnId
      )) ?? [];
  }
}

function isUncertainFailure(cause: unknown) {
  if (!cause || typeof cause !== 'object') return false;
  const value = cause as { code?: unknown; retryable?: unknown; status?: unknown };
  return value.retryable === true || value.code === 'DIRECT_NETWORK_FAILED' || value.status === undefined;
}

const DRAFT_VERSION = 1;
export class MobileAiSessionDraftStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly storage: ValueStore) {}
  async read(controlPlaneId: string, instanceId: string, sessionId: string) {
    await this.pending;
    const raw = await this.storage.get(draftKey(controlPlaneId, instanceId, sessionId));
    if (!raw) return '';
    try {
      const value = JSON.parse(raw);
      return value?.version === DRAFT_VERSION && typeof value.text === 'string' ? value.text.slice(0, 20_000) : '';
    } catch { return ''; }
  }
  write(controlPlaneId: string, instanceId: string, sessionId: string, text: string) {
    return this.enqueue(async () => {
      const key = draftKey(controlPlaneId, instanceId, sessionId);
      const indexKey = draftIndexKey(controlPlaneId);
      const index = await this.index(indexKey);
      if (!text) {
        await this.storage.remove(key);
        const next = index.filter((candidate) => candidate !== key);
        if (next.length) await this.storage.set(indexKey, JSON.stringify(next));
        else await this.storage.remove(indexKey);
        return;
      }
      await this.storage.set(key, JSON.stringify({ version: DRAFT_VERSION, text: text.slice(0, 20_000), updatedAt: new Date().toISOString() }));
      if (!index.includes(key)) await this.storage.set(indexKey, JSON.stringify([...index, key]));
    });
  }
  clearProfile(controlPlaneId: string) {
    return this.enqueue(async () => {
      const indexKey = draftIndexKey(controlPlaneId);
      for (const key of await this.index(indexKey)) await this.storage.remove(key);
      await this.storage.remove(indexKey);
    });
  }
  private async index(key: string) {
    const raw = await this.storage.get(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && value.startsWith(`draft.v${DRAFT_VERSION}.`)) : [];
    } catch { return []; }
  }
  private enqueue(operation: () => Promise<void>) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}

function draftKey(...identity: string[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `draft.v${DRAFT_VERSION}.${globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function draftIndexKey(controlPlaneId: string) {
  const bytes = new TextEncoder().encode(controlPlaneId);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `draft-index.v${DRAFT_VERSION}.${globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}
