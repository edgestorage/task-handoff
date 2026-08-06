import { AiSessionPermissionModeSchema, type AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';

import type { ValueStore } from '../platform/secure-storage';

const PERMISSION_VERSION = 1;
export const MOBILE_AI_SESSION_PERMISSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type StoredPermission = {
  version: typeof PERMISSION_VERSION;
  permissionMode: AiSessionPermissionMode;
  updatedAt: number;
};

export class MobileAiSessionPermissionStore {
  private pending = Promise.resolve();

  constructor(private readonly storage: ValueStore) {}

  read(controlPlaneId: string, instanceId: string, sessionId: string, fallback: AiSessionPermissionMode, now = Date.now()) {
    return this.enqueue(async () => {
      const key = permissionKey(controlPlaneId, instanceId, sessionId);
      const stored = parseStoredPermission(await this.storage.get(key), now);
      if (stored) return stored.permissionMode;
      await this.writeRecord(controlPlaneId, key, fallback, now);
      return fallback;
    });
  }

  write(controlPlaneId: string, instanceId: string, sessionId: string, permissionMode: AiSessionPermissionMode, now = Date.now()) {
    return this.enqueue(() => this.writeRecord(controlPlaneId, permissionKey(controlPlaneId, instanceId, sessionId), permissionMode, now));
  }

  clearProfile(controlPlaneId: string) {
    return this.enqueue(async () => {
      const indexKey = permissionIndexKey(controlPlaneId);
      for (const key of await this.index(indexKey)) await this.storage.remove(key);
      await this.storage.remove(indexKey);
    });
  }

  private async writeRecord(controlPlaneId: string, key: string, permissionMode: AiSessionPermissionMode, now: number) {
    const parsed = AiSessionPermissionModeSchema.parse(permissionMode);
    await this.storage.set(key, JSON.stringify({ version: PERMISSION_VERSION, permissionMode: parsed, updatedAt: now } satisfies StoredPermission));
    const indexKey = permissionIndexKey(controlPlaneId);
    const index = await this.index(indexKey);
    if (!index.includes(key)) await this.storage.set(indexKey, JSON.stringify([...index, key]));
  }

  private async index(key: string) {
    const raw = await this.storage.get(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && value.startsWith(`session-permission.v${PERMISSION_VERSION}.`)) : [];
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

function parseStoredPermission(raw: string | undefined, now: number): StoredPermission | undefined {
  if (!raw) return undefined;
  try {
    const record = JSON.parse(raw) as Partial<StoredPermission>;
    const permissionMode = AiSessionPermissionModeSchema.safeParse(record.permissionMode);
    if (record.version !== PERMISSION_VERSION || !permissionMode.success || !Number.isFinite(record.updatedAt)) return undefined;
    if (now - Number(record.updatedAt) >= MOBILE_AI_SESSION_PERMISSION_TTL_MS) return undefined;
    return { version: PERMISSION_VERSION, permissionMode: permissionMode.data, updatedAt: Number(record.updatedAt) };
  } catch {
    return undefined;
  }
}

function permissionKey(controlPlaneId: string, instanceId: string, sessionId: string) {
  return encodedStorageKey(`session-permission.v${PERMISSION_VERSION}`, [controlPlaneId, instanceId, sessionId]);
}

function permissionIndexKey(controlPlaneId: string) {
  return encodedStorageKey(`session-permission-index.v${PERMISSION_VERSION}`, [controlPlaneId]);
}

function encodedStorageKey(prefix: string, identity: string[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}.${globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}
