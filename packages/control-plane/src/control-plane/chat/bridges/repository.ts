import { ChatBridgeConfigSchema, ChatSessionBindingSchema, type ChatBridgeConfig, type ChatSessionBinding } from "@task-handoff/protocol/control-plane";
import type { ControlPlaneDatabase } from "../../persistence/database/index.ts";
import type { ChatBridgeRecord, ChatSessionRecord } from "../../persistence/database/p0-records.ts";
import type { SecretEnvelopeService } from "../../persistence/secret-envelope.ts";
import { ChatBridgeCredentialSchema, joinChatBridgeCredential, splitChatBridgeCredential } from "./credential-codec.ts";

function credentialContext(bridgeId: string) {
  return `chat-bridge:${bridgeId}:credential`;
}

export class ControlPlaneChatRepository {
  private readonly database: ControlPlaneDatabase;
  private readonly secrets: SecretEnvelopeService;

  constructor(database: ControlPlaneDatabase, secrets: SecretEnvelopeService) {
    this.database = database;
    this.secrets = secrets;
  }

  async listBridges() {
    return Promise.all((await this.database.chatBridges.list()).map((record) => this.bridgeFromRecord(record)));
  }

  listBridgeRecords() {
    return this.database.chatBridges.list();
  }

  getBridgeRecord(id: string) {
    return this.database.chatBridges.get(id);
  }

  publicBridge(record: ChatBridgeRecord) {
    return {
      id: record.id,
      channel: record.channel,
      name: record.name,
      enabled: record.enabled,
      defaultChatId: record.defaultChatId,
      allowedUserIds: record.allowedUserIds,
      pollIntervalMs: record.pollIntervalMs,
      settings: {
        ...record.settings,
        ...(record.credentialMetadata.clientSecretSet ? { clientSecretSet: true } : {}),
        ...(record.credentialMetadata.appSecretSet ? { appSecretSet: true } : {}),
      },
      tokenSet: record.credentialMetadata.tokenSet,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  resolveBridge(record: ChatBridgeRecord) {
    return this.bridgeFromRecord(record);
  }

  async getBridge(id: string) {
    const record = await this.database.chatBridges.get(id);
    return record ? this.bridgeFromRecord(record) : undefined;
  }

  async putBridge(input: ChatBridgeConfig) {
    const bridge = ChatBridgeConfigSchema.parse(input);
    await this.database.chatBridges.put(this.bridgeToRecord(bridge));
    return bridge;
  }

  async deleteBridge(id: string) {
    return this.database.transaction(async (database) => {
      for (const session of await database.chatSessions.list()) {
        if (session.bridgeId === id) await database.chatSessions.delete(session.id);
      }
      return database.chatBridges.delete(id);
    });
  }

  async listSessions() {
    return (await this.database.chatSessions.list()).map(sessionFromRecord);
  }

  async getSession(id: string) {
    const record = await this.database.chatSessions.get(id);
    return record ? sessionFromRecord(record) : undefined;
  }

  async putSession(input: ChatSessionBinding) {
    const session = ChatSessionBindingSchema.parse(input);
    await this.database.chatSessions.put(sessionToRecord(session));
    return session;
  }

  deleteSession(id: string) {
    return this.database.chatSessions.delete(id);
  }

  transaction<T>(operation: (repository: ControlPlaneChatRepository) => Promise<T>) {
    return this.database.transaction((database) => operation(new ControlPlaneChatRepository(database, this.secrets)));
  }

  private bridgeToRecord(bridge: ChatBridgeConfig): ChatBridgeRecord {
    const { publicSettings, credential } = splitChatBridgeCredential(bridge);
    return {
      id: bridge.id,
      channel: bridge.channel,
      name: bridge.name,
      enabled: bridge.enabled,
      ...(credential ? { credentialCiphertext: this.secrets.seal(JSON.stringify(credential), credentialContext(bridge.id)) } : {}),
      credentialMetadata: {
        tokenSet: Boolean(credential?.token),
        clientSecretSet: Boolean(credential?.settings.clientSecret),
        appSecretSet: Boolean(credential?.settings.appSecret),
      },
      ...(bridge.defaultChatId ? { defaultChatId: bridge.defaultChatId } : {}),
      allowedUserIds: bridge.allowedUserIds,
      pollIntervalMs: bridge.pollIntervalMs,
      settings: publicSettings,
      createdAt: bridge.createdAt,
      updatedAt: bridge.updatedAt,
    };
  }

  private bridgeFromRecord(record: ChatBridgeRecord) {
    const credential = record.credentialCiphertext
      ? ChatBridgeCredentialSchema.parse(JSON.parse(this.secrets.open(record.credentialCiphertext, credentialContext(record.id))))
      : undefined;
    return ChatBridgeConfigSchema.parse({
      id: record.id,
      channel: record.channel,
      name: record.name,
      enabled: record.enabled,
      ...joinChatBridgeCredential(record.channel, record.settings, credential),
      defaultChatId: record.defaultChatId,
      allowedUserIds: record.allowedUserIds,
      pollIntervalMs: record.pollIntervalMs,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}

export class ControlPlaneChatStore {
  private readonly repository: ControlPlaneChatRepository;
  private readonly bridges = new Map<string, ChatBridgeRecord>();
  private readonly sessions = new Map<string, ChatSessionBinding>();

  constructor(repository: ControlPlaneChatRepository) {
    this.repository = repository;
  }

  async init() {
    this.bridges.clear();
    this.sessions.clear();
    for (const bridge of await this.repository.listBridgeRecords()) this.bridges.set(bridge.id, bridge);
    for (const session of await this.repository.listSessions()) this.sessions.set(session.id, session);
  }

  listBridges() { return [...this.bridges.values()].sort((a, b) => a.id.localeCompare(b.id)).map((bridge) => this.repository.publicBridge(bridge)); }
  getPublicBridge(id: string) { const record = this.bridges.get(id); return record ? this.repository.publicBridge(record) : undefined; }
  resolveBridge(id: string) { const record = this.bridges.get(id); return record ? this.repository.resolveBridge(record) : undefined; }
  async putBridge(bridge: ChatBridgeConfig) {
    const stored = await this.repository.putBridge(bridge);
    const record = await this.repository.getBridgeRecord(stored.id);
    if (!record) throw new Error(`Chat bridge ${stored.id} was not committed.`);
    this.bridges.set(record.id, record);
    return stored;
  }
  async deleteBridge(id: string) {
    const deleted = await this.repository.deleteBridge(id);
    if (deleted) {
      this.bridges.delete(id);
      for (const session of this.sessions.values()) if (session.bridgeId === id) this.sessions.delete(session.id);
    }
    return deleted;
  }
  listSessions() { return [...this.sessions.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  getSession(id: string) { return this.sessions.get(id); }
  async putSession(session: ChatSessionBinding) { const stored = await this.repository.putSession(session); this.sessions.set(stored.id, stored); return stored; }
  async deleteSession(id: string) { const deleted = await this.repository.deleteSession(id); if (deleted) this.sessions.delete(id); return deleted; }
}

function sessionToRecord(session: ChatSessionBinding): ChatSessionRecord {
  return {
    ...session,
    routeScope: session.bridgeId || session.channel,
  };
}

function sessionFromRecord(record: ChatSessionRecord) {
  const { routeScope: _routeScope, ...session } = record;
  return ChatSessionBindingSchema.parse(session);
}
