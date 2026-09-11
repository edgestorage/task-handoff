import { NodeSchema, type Node } from "@task-handoff/protocol/control-plane";
import type { ControlPlaneDatabase } from "../persistence/database/index.ts";
import type { NodeConfigRecord, PairingRevokeRecord } from "../persistence/database/p0-records.ts";
import type { SecretEnvelopeService } from "../persistence/secret-envelope.ts";
import { PendingPairingRevokeSchema, type PendingPairingRevoke } from "./connection-manager.ts";

function nodeSecretContext(nodeId: string) {
  return `node:${nodeId}:auth`;
}

function revokeSecretContext(id: string) {
  return `node-pairing-revoke:${id}:secret`;
}

export class ControlPlaneNodeRepository {
  private readonly database: ControlPlaneDatabase;
  private readonly secrets: SecretEnvelopeService;

  constructor(database: ControlPlaneDatabase, secrets: SecretEnvelopeService) {
    this.database = database;
    this.secrets = secrets;
  }

  async list() {
    return Promise.all((await this.database.nodes.list()).map((record) => this.fromRecord(record)));
  }

  async get(id: string) {
    const record = await this.database.nodes.get(id);
    return record ? this.fromRecord(record) : undefined;
  }

  async put(input: Node) {
    const node = NodeSchema.parse(input);
    await this.database.nodes.put(this.toRecord(node));
    return this.fromRecord(this.toRecord(node));
  }

  delete(id: string) {
    return this.database.nodes.delete(id);
  }

  transaction<T>(operation: (repository: ControlPlaneNodeRepository) => Promise<T>) {
    return this.database.transaction((database) => operation(new ControlPlaneNodeRepository(database, this.secrets)));
  }

  private toRecord(node: Node): NodeConfigRecord {
    return {
      id: node.id,
      name: node.name,
      connectionMode: node.connectionMode,
      connectionPath: node.connectionPath,
      connectionEnabled: node.connectionEnabled,
      authMode: node.auth.mode,
      ...(node.auth.keyId ? { authKeyId: node.auth.keyId } : {}),
      ...(node.auth.secret ? { authSecretCiphertext: this.secrets.seal(node.auth.secret, nodeSecretContext(node.id)) } : {}),
      ...(node.auth.pairedAt ? { authPairedAt: node.auth.pairedAt } : {}),
      ...(node.auth.pairing?.status === "paired" || node.auth.pairing?.status === "expired" ? { authPairingStatus: node.auth.pairing.status } : {}),
      ...(node.endpoint ? { endpoint: node.endpoint } : {}),
      ...(node.controlEndpoint ? { controlEndpoint: node.controlEndpoint } : {}),
      ...(node.containerEndpoint ? { containerEndpoint: node.containerEndpoint } : {}),
      ...(node.publicWebBase ? { publicWebBase: node.publicWebBase } : {}),
      labels: node.labels,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }

  private fromRecord(record: NodeConfigRecord) {
    return NodeSchema.parse({
      id: record.id,
      name: record.name,
      connectionMode: record.connectionMode,
      connectionPath: record.connectionPath,
      connectionEnabled: record.connectionEnabled,
      auth: {
        mode: record.authMode,
        ...(record.authKeyId ? { keyId: record.authKeyId } : {}),
        ...(record.authSecretCiphertext ? { secret: this.secrets.open(record.authSecretCiphertext, nodeSecretContext(record.id)) } : {}),
        ...(record.authPairedAt ? { pairedAt: record.authPairedAt } : {}),
        ...(record.authPairingStatus ? { pairing: { status: record.authPairingStatus } } : {}),
      },
      endpoint: record.endpoint,
      controlEndpoint: record.controlEndpoint,
      containerEndpoint: record.containerEndpoint,
      publicWebBase: record.publicWebBase,
      status: "unknown",
      health: "unknown",
      capabilities: {},
      labels: record.labels,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}

const runtimeNodeFields = ["status", "health", "capabilities", "proxyState", "appInventory", "lastSeenAt"] as const;
type NodeRuntimeOverlay = Pick<Node, (typeof runtimeNodeFields)[number]>;

export type ControlPlaneNodeStorage = {
  list(): Node[];
  get(id: string): Node | undefined;
  put(node: Node): Node | Promise<Node>;
  delete(id: string): boolean | Promise<boolean>;
  observe?(node: Node): Node;
  commitPairing?(node: Node, revokeId: string): Promise<Node>;
};

export class ControlPlaneNodeStore implements ControlPlaneNodeStorage {
  private readonly repository: ControlPlaneNodeRepository;
  private readonly commitPairingOperation: ((node: Node, revokeId: string) => Promise<Node>) | undefined;
  private readonly configurations = new Map<string, Node>();
  private readonly observations = new Map<string, Partial<NodeRuntimeOverlay>>();

  constructor(repository: ControlPlaneNodeRepository, options: { commitPairing?: (node: Node, revokeId: string) => Promise<Node> } = {}) {
    this.repository = repository;
    this.commitPairingOperation = options.commitPairing;
  }

  async init() {
    this.configurations.clear();
    this.observations.clear();
    for (const node of await this.repository.list()) this.configurations.set(node.id, node);
  }

  list() {
    return [...this.configurations.keys()].sort().map((id) => this.get(id)!);
  }

  get(id: string) {
    const configuration = this.configurations.get(id);
    if (!configuration) return undefined;
    return NodeSchema.parse({ ...configuration, ...this.observations.get(id) });
  }

  async put(node: Node) {
    const stored = await this.repository.put(node);
    this.configurations.set(stored.id, stored);
    return this.get(stored.id)!;
  }

  async delete(id: string) {
    const deleted = await this.repository.delete(id);
    if (deleted) {
      this.configurations.delete(id);
      this.observations.delete(id);
    }
    return deleted;
  }

  async commitPairing(node: Node, revokeId: string) {
    const stored = this.commitPairingOperation
      ? await this.commitPairingOperation(node, revokeId)
      : await this.repository.put(node);
    this.configurations.set(stored.id, stored);
    return this.get(stored.id)!;
  }

  observe(node: Node) {
    if (!this.configurations.has(node.id)) throw new Error(`Node ${node.id} configuration is not initialized.`);
    this.observations.set(node.id, Object.fromEntries(runtimeNodeFields.flatMap((field) => (
      node[field] === undefined ? [] : [[field, node[field]]]
    ))) as Partial<NodeRuntimeOverlay>);
    return this.get(node.id)!;
  }
}

export class ControlPlanePairingRevokeRepository {
  private readonly database: ControlPlaneDatabase;
  private readonly secrets: SecretEnvelopeService;

  constructor(database: ControlPlaneDatabase, secrets: SecretEnvelopeService) {
    this.database = database;
    this.secrets = secrets;
  }

  async list() {
    return Promise.all((await this.database.pairingRevocations.list()).map((record) => this.fromRecord(record)));
  }

  async get(id: string) {
    const record = await this.database.pairingRevocations.get(id);
    return record ? this.fromRecord(record) : undefined;
  }

  async put(input: PendingPairingRevoke) {
    const record = PendingPairingRevokeSchema.parse(input);
    await this.database.pairingRevocations.put(this.toRecord(record));
    return record;
  }

  delete(id: string) {
    return this.database.pairingRevocations.delete(id);
  }

  private toRecord(record: PendingPairingRevoke): PairingRevokeRecord {
    const { secret, ...metadata } = record;
    return { ...metadata, secretCiphertext: this.secrets.seal(secret, revokeSecretContext(record.id)) };
  }

  private fromRecord(record: PairingRevokeRecord) {
    const { secretCiphertext, ...metadata } = record;
    return PendingPairingRevokeSchema.parse({
      ...metadata,
      secret: this.secrets.open(secretCiphertext, revokeSecretContext(record.id)),
    });
  }
}

export type ControlPlanePairingRevokeStorage = {
  list(): PendingPairingRevoke[];
  get(id: string): PendingPairingRevoke | undefined;
  put(record: PendingPairingRevoke): PendingPairingRevoke | Promise<PendingPairingRevoke>;
  delete(id: string): boolean | Promise<boolean>;
};

export class ControlPlanePairingRevokeStore implements ControlPlanePairingRevokeStorage {
  private readonly repository: ControlPlanePairingRevokeRepository;
  private readonly records = new Map<string, PendingPairingRevoke>();

  constructor(repository: ControlPlanePairingRevokeRepository) {
    this.repository = repository;
  }

  async init() {
    this.records.clear();
    for (const record of await this.repository.list()) this.records.set(record.id, record);
  }

  list() { return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  get(id: string) { return this.records.get(id); }
  async put(record: PendingPairingRevoke) { const stored = await this.repository.put(record); this.records.set(stored.id, stored); return stored; }
  async delete(id: string) { const deleted = await this.repository.delete(id); this.records.delete(id); return deleted; }
}
