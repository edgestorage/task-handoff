import type { z } from "zod";
import { databaseStartupError } from "./migrations.ts";
import {
  p0RecordSchemas,
  type ChatBridgeRecord,
  type ChatSessionRecord,
  type GitAssignmentRecord,
  type GitAuditRecord,
  type GitCredentialRecord,
  type GitProvisioningIntentRecord,
  type ModelRecord,
  type NodeConfigRecord,
  type PairingRevokeRecord,
} from "./p0-records.ts";
import {
  ExternalIdentityApprovalRecordSchema,
  IdentityProviderRecordSchema,
  LoginIdentityRecordSchema,
  RoleDefinitionRecordSchema,
  UserAccessGrantRecordSchema,
  UserAccountRecordSchema,
  UserSessionRecordSchema,
  UserAuditRecordSchema,
  type ExternalIdentityApprovalRecord,
  type IdentityProviderRecord,
  type LoginIdentityRecord,
  type RoleDefinitionRecord,
  type UserAccessGrantRecord,
  type UserAccountRecord,
  type UserSessionRecord,
  type UserAuditRecord,
} from "../../auth/user-records.ts";

export type ControlPlaneUserStoreMetadata = { schemaVersion: 1; initializedAt?: string };
export type ControlPlaneMigrationLedgerRecord = { id: string; checksum: string; appliedAt: string; details: Record<string, unknown> };

export type ControlPlaneRecordCollection<T extends { id: string }> = {
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  put(record: T): Promise<T>;
  delete(id: string): Promise<boolean>;
};

export type ControlPlaneGitAssignmentCollection = ControlPlaneRecordCollection<GitAssignmentRecord> & {
  putIfRevision(record: GitAssignmentRecord, expectedRevision: number | undefined): Promise<boolean>;
};
export type ControlPlaneGitProvisioningCollection = ControlPlaneRecordCollection<GitProvisioningIntentRecord> & {
  insert(record: GitProvisioningIntentRecord): Promise<boolean>;
};
export type ControlPlaneGitAuditCollection = Pick<ControlPlaneRecordCollection<GitAuditRecord>, "list" | "get"> & {
  append(record: GitAuditRecord): Promise<void>;
};
export type ControlPlaneIdentityCollection = ControlPlaneRecordCollection<LoginIdentityRecord> & {
  findByLoginName(normalizedLoginName: string): Promise<LoginIdentityRecord | undefined>;
  findByProviderSubject(providerId: string, subject: string): Promise<LoginIdentityRecord | undefined>;
  listByUser(userId: string): Promise<LoginIdentityRecord[]>;
  existsForProvider(providerId: string): Promise<boolean>;
};
export type ControlPlaneGrantCollection = {
  list(): Promise<UserAccessGrantRecord[]>;
  get(userId: string): Promise<UserAccessGrantRecord | undefined>;
  listByRole(roleId: string): Promise<UserAccessGrantRecord[]>;
  put(record: UserAccessGrantRecord): Promise<UserAccessGrantRecord>;
  delete(userId: string): Promise<boolean>;
};
export type ControlPlaneSessionCollection = ControlPlaneRecordCollection<UserSessionRecord> & {
  listByUser(userId: string): Promise<UserSessionRecord[]>;
};
export type ControlPlaneApprovalCollection = ControlPlaneRecordCollection<ExternalIdentityApprovalRecord> & {
  findActivePending(providerId: string, subject: string, now: string): Promise<ExternalIdentityApprovalRecord | undefined>;
  hasActivePendingForProvider(providerId: string, now: string): Promise<boolean>;
};

export type ControlPlaneDatabaseRepository = {
  readonly dialect: "sqlite" | "postgresql";
  readonly users: ControlPlaneRecordCollection<UserAccountRecord>;
  readonly identities: ControlPlaneIdentityCollection;
  readonly roles: ControlPlaneRecordCollection<RoleDefinitionRecord>;
  readonly grants: ControlPlaneGrantCollection;
  readonly sessions: ControlPlaneSessionCollection;
  readonly providers: ControlPlaneRecordCollection<IdentityProviderRecord>;
  readonly approvals: ControlPlaneApprovalCollection;
  readonly audit: ControlPlaneRecordCollection<UserAuditRecord>;
  readonly nodes: ControlPlaneRecordCollection<NodeConfigRecord>;
  readonly pairingRevocations: ControlPlaneRecordCollection<PairingRevokeRecord>;
  readonly models: ControlPlaneRecordCollection<ModelRecord>;
  readonly chatBridges: ControlPlaneRecordCollection<ChatBridgeRecord>;
  readonly chatSessions: ControlPlaneRecordCollection<ChatSessionRecord>;
  readonly gitCredentials: ControlPlaneRecordCollection<GitCredentialRecord>;
  readonly gitAssignments: ControlPlaneGitAssignmentCollection;
  readonly gitProvisioningIntents: ControlPlaneGitProvisioningCollection;
  readonly gitAudit: ControlPlaneGitAuditCollection;
  metadata(): Promise<ControlPlaneUserStoreMetadata>;
  putMetadata(metadata: ControlPlaneUserStoreMetadata): Promise<void>;
  migration(id: string): Promise<ControlPlaneMigrationLedgerRecord | undefined>;
  putMigration(record: ControlPlaneMigrationLedgerRecord): Promise<void>;
  transaction<T>(operation: (repository: ControlPlaneDatabaseRepository) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

// Compatibility for v0.0.28: auth consumers retain their former type name.
export type ControlPlaneUserRepository = ControlPlaneDatabaseRepository;

export const userRecordSchemas = {
  users: UserAccountRecordSchema, identities: LoginIdentityRecordSchema, roles: RoleDefinitionRecordSchema,
  grants: UserAccessGrantRecordSchema, sessions: UserSessionRecordSchema, providers: IdentityProviderRecordSchema,
  approvals: ExternalIdentityApprovalRecordSchema, audit: UserAuditRecordSchema,
} as const satisfies Record<string, z.ZodType>;

export { p0RecordSchemas, databaseStartupError };
export function rowForDatabase(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value === undefined ? null : value]));
}
export function recordFromDatabase<T>(schema: z.ZodType<T>, row: Record<string, unknown>): T {
  return schema.parse(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)));
}
