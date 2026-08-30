import type { z } from "zod";
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
} from "../user-records.ts";

export type ControlPlaneUserStoreMetadata = { schemaVersion: 1; initializedAt?: string };
export type ControlPlaneMigrationLedgerRecord = {
  id: string;
  checksum: string;
  appliedAt: string;
  details: Record<string, unknown>;
};

export type ControlPlaneRecordCollection<T extends { id: string }> = {
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  put(record: T): Promise<T>;
  delete(id: string): Promise<boolean>;
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

export type ControlPlaneUserRepository = {
  readonly dialect: "sqlite" | "postgresql";
  readonly users: ControlPlaneRecordCollection<UserAccountRecord>;
  readonly identities: ControlPlaneIdentityCollection;
  readonly roles: ControlPlaneRecordCollection<RoleDefinitionRecord>;
  readonly grants: ControlPlaneGrantCollection;
  readonly sessions: ControlPlaneSessionCollection;
  readonly providers: ControlPlaneRecordCollection<IdentityProviderRecord>;
  readonly approvals: ControlPlaneApprovalCollection;
  readonly audit: ControlPlaneRecordCollection<UserAuditRecord>;
  metadata(): Promise<ControlPlaneUserStoreMetadata>;
  putMetadata(metadata: ControlPlaneUserStoreMetadata): Promise<void>;
  migration(id: string): Promise<ControlPlaneMigrationLedgerRecord | undefined>;
  putMigration(record: ControlPlaneMigrationLedgerRecord): Promise<void>;
  transaction<T>(operation: (repository: ControlPlaneUserRepository) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export const userRecordSchemas = {
  users: UserAccountRecordSchema,
  identities: LoginIdentityRecordSchema,
  roles: RoleDefinitionRecordSchema,
  grants: UserAccessGrantRecordSchema,
  sessions: UserSessionRecordSchema,
  providers: IdentityProviderRecordSchema,
  approvals: ExternalIdentityApprovalRecordSchema,
  audit: UserAuditRecordSchema,
} as const satisfies Record<string, z.ZodType>;

export function rowForDatabase(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value === undefined ? null : value]));
}

export function recordFromDatabase<T>(schema: z.ZodType<T>, row: Record<string, unknown>): T {
  return schema.parse(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)));
}

export function databaseStartupError(dialect: "sqlite" | "postgresql", phase: "connect" | "migrate" | "validate", error: unknown) {
  const cause = error instanceof Error ? error : new Error(String(error));
  return Object.assign(new Error(`Control Plane ${dialect} database ${phase} failed: ${cause.message}`, { cause }), {
    code: `CONTROL_PLANE_DATABASE_${phase.toUpperCase()}_FAILED`,
    dialect,
    phase,
  });
}
