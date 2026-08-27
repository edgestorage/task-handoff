import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { ControlPlaneInstanceDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';
import { AiAgentKindSchema, type AiSessionGitSelection, type AiSessionMessageAttachmentRef, type AiSessionModelSelection, type AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';
import type { ValueStore } from '../platform/secure-storage';

const CREATE_REQUEST_VERSION = 1;

export async function createMobileAiSession(client: ControlPlaneClient, input: {
  instance: ControlPlaneInstanceDirectoryEntry;
  agent: string;
  cwdFolderId?: string;
  gitSelection?: AiSessionGitSelection;
  message: string;
  attachments?: AiSessionMessageAttachmentRef[];
  permissionMode?: AiSessionPermissionMode;
  modelSelection?: AiSessionModelSelection;
  clientRequestId: string;
}) {
  if (!input.instance.ready || input.instance.connectionStatus !== 'online') throw lifecycleError('INSTANCE_OFFLINE', 'The instance is offline. Start or repair it from the desktop app.');
  if (!input.instance.availableAgents.some((agent) => agent.id === input.agent)) throw lifecycleError('AGENT_UNAVAILABLE', 'The selected agent is unavailable. Install or repair it from the desktop app.');
  const agent = AiAgentKindSchema.safeParse(input.agent);
  if (!agent.success) throw lifecycleError('AGENT_UNSUPPORTED', 'The selected application does not provide an AI Session agent. Choose Codex or Claude.');
  return client.aiSessions.create(input.instance.id, {
    agent: agent.data,
    ...(input.cwdFolderId ? { cwdFolderId: input.cwdFolderId } : {}),
    ...(input.gitSelection ? { gitSelection: input.gitSelection } : {}),
    clientRequestId: input.clientRequestId,
    message: input.message,
    mode: 'auto',
    permissionMode: agent.data === 'codex' ? input.permissionMode ?? input.instance.config.defaultCodexPermissionMode : undefined,
    modelSelection: input.modelSelection,
    attachments: input.attachments ?? [],
    references: [],
  });
}

export function lifecycleGuidance(cause: unknown) {
  const value = cause as { code?: unknown; message?: unknown } | undefined;
  const message = typeof value?.message === 'string' ? value.message : 'The operation failed.';
  const code = typeof value?.code === 'string' ? value.code : 'AI_SESSION_OPERATION_FAILED';
  const desktop = /OFFLINE|UNAVAILABLE|UNSUPPORTED|PROVIDER|AGENT/.test(code) ? ' Use the desktop app to repair the instance or provider configuration.' : '';
  return { code, message: `${message}${desktop}` };
}

export class MobileAiSessionCreateRequestStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly storage: ValueStore) {}

  getOrCreate(
    controlPlaneId: string,
    instanceId: string,
    input: { agent: string; cwdFolderId?: string; gitSelection?: AiSessionGitSelection; message: string; permissionMode?: AiSessionPermissionMode; modelSelection?: AiSessionModelSelection; attachments?: readonly { kind: string; name: string; size: number }[] },
    createId: () => string,
  ) {
    return this.enqueue(async () => {
      const key = createRequestKey(controlPlaneId, instanceId);
      const fingerprint = JSON.stringify(input);
      const current = await this.readRecord(key);
      if (current?.fingerprint === fingerprint) return current.clientRequestId;
      const clientRequestId = createId();
      await this.storage.set(key, JSON.stringify({ version: CREATE_REQUEST_VERSION, fingerprint, clientRequestId }));
      const indexKey = createRequestIndexKey(controlPlaneId);
      const index = await this.index(indexKey);
      if (!index.includes(key)) await this.storage.set(indexKey, JSON.stringify([...index, key]));
      return clientRequestId;
    });
  }

  clear(controlPlaneId: string, instanceId: string, clientRequestId: string) {
    return this.enqueue(async () => {
      const key = createRequestKey(controlPlaneId, instanceId);
      if ((await this.readRecord(key))?.clientRequestId !== clientRequestId) return;
      await this.storage.remove(key);
      const indexKey = createRequestIndexKey(controlPlaneId);
      const next = (await this.index(indexKey)).filter((candidate) => candidate !== key);
      if (next.length) await this.storage.set(indexKey, JSON.stringify(next));
      else await this.storage.remove(indexKey);
    });
  }

  clearProfile(controlPlaneId: string) {
    return this.enqueue(async () => {
      const indexKey = createRequestIndexKey(controlPlaneId);
      for (const key of await this.index(indexKey)) await this.storage.remove(key);
      await this.storage.remove(indexKey);
    });
  }

  private async readRecord(key: string) {
    const raw = await this.storage.get(key);
    if (!raw) return undefined;
    try {
      const record = JSON.parse(raw) as Record<string, unknown>;
      if (record.version !== CREATE_REQUEST_VERSION || typeof record.fingerprint !== 'string' || typeof record.clientRequestId !== 'string') return undefined;
      return { fingerprint: record.fingerprint, clientRequestId: record.clientRequestId };
    } catch {
      return undefined;
    }
  }

  private async index(key: string) {
    const raw = await this.storage.get(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && value.startsWith(`create-request.v${CREATE_REQUEST_VERSION}.`)) : [];
    } catch {
      return [];
    }
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

function createRequestKey(controlPlaneId: string, instanceId: string) {
  return encodedStorageKey(`create-request.v${CREATE_REQUEST_VERSION}`, [controlPlaneId, instanceId]);
}

function createRequestIndexKey(controlPlaneId: string) {
  return encodedStorageKey(`create-request-index.v${CREATE_REQUEST_VERSION}`, [controlPlaneId]);
}

function encodedStorageKey(prefix: string, identity: string[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}.${globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function lifecycleError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
