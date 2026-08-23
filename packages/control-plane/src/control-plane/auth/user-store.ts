import {
  CONTROL_PLANE_PERMISSION_IDS,
  type ControlPlanePermissionId,
} from "@task-handoff/protocol/control-plane-access";
import { nowIso as now } from "@task-handoff/core/core/time";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import {
  createControlPlaneUserRepository,
  type ControlPlaneUserDatabaseConfigInput,
  type ControlPlaneUserRepository,
} from "./database/index.ts";
import { importV0021AuthJson, legacyAuthDataPresent } from "./database/legacy-import.ts";
import type {
  ExternalIdentityApprovalRecord,
  IdentityProviderRecord,
  LoginIdentityRecord,
  RoleDefinitionRecord,
  UserAccessGrantRecord,
  UserAccountRecord,
  UserSessionRecord,
  UserAuditRecord,
} from "./user-records.ts";
import type { ControlPlaneRecordCollection } from "./database/repository.ts";

export const SYSTEM_ROLE_IDS = {
  admin: "role_admin",
  operator: "role_operator",
  viewer: "role_viewer",
} as const;

const VIEWER_PERMISSIONS = CONTROL_PLANE_PERMISSION_IDS.filter((id) => id.endsWith(":read"));
const OPERATOR_DENIED_PREFIXES = ["users:", "roles:", "identity-providers:", "settings:", "secrets:", "chat-bridges:"];
const OPERATOR_PERMISSIONS = CONTROL_PLANE_PERMISSION_IDS.filter((id) => !OPERATOR_DENIED_PREFIXES.some((prefix) => id.startsWith(prefix)));

function systemRole(id: string, name: string, permissionIds: readonly ControlPlanePermissionId[]): RoleDefinitionRecord {
  const timestamp = now();
  return {
    id,
    name,
    system: true,
    status: "active",
    permissionIds: [...permissionIds],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class ControlPlaneUserStore {
  private repositoryValue: ControlPlaneUserRepository | undefined;
  private stateValue: { initialized: boolean; legacyDataPresent: boolean; databaseDialect: "sqlite" | "postgresql" } | undefined;
  private readonly paths: ControlPlaneStorePaths;
  private readonly database?: ControlPlaneUserDatabaseConfigInput;

  constructor(paths: ControlPlaneStorePaths, options: { database?: ControlPlaneUserDatabaseConfigInput } = {}) {
    this.paths = paths;
    this.database = options.database;
  }

  get users(): ControlPlaneRecordCollection<UserAccountRecord> { return this.repository().users; }
  get identities(): ControlPlaneRecordCollection<LoginIdentityRecord> { return this.repository().identities; }
  get roles(): ControlPlaneRecordCollection<RoleDefinitionRecord> { return this.repository().roles; }
  get grants(): ControlPlaneRecordCollection<UserAccessGrantRecord> { return this.repository().grants; }
  get sessions(): ControlPlaneRecordCollection<UserSessionRecord> { return this.repository().sessions; }
  get providers(): ControlPlaneRecordCollection<IdentityProviderRecord> { return this.repository().providers; }
  get approvals(): ControlPlaneRecordCollection<ExternalIdentityApprovalRecord> { return this.repository().approvals; }
  get audit(): ControlPlaneRecordCollection<UserAuditRecord> { return this.repository().audit; }

  async init() {
    if (this.repositoryValue) return this.state();
    this.repositoryValue = await createControlPlaneUserRepository(this.paths, this.database);
    try {
      if (legacyAuthDataPresent(this.paths)) await importV0021AuthJson(this.repositoryValue, this.paths);
      const metadata = await this.repositoryValue.metadata();
      const state = {
        initialized: Boolean(metadata.initializedAt),
        legacyDataPresent: legacyAuthDataPresent(this.paths),
        databaseDialect: this.repositoryValue.dialect,
      };
      this.stateValue = state;
      if (state.initialized) await this.ensureSystemRoles();
      return state;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  state() {
    if (!this.stateValue) throw Object.assign(new Error("Control Plane user database is not initialized."), { code: "CONTROL_PLANE_DATABASE_NOT_INITIALIZED" });
    return this.stateValue;
  }

  async initializeForBootstrap() {
    await this.repository().transaction(async (transaction) => {
      const metadata = await transaction.metadata();
      if (!metadata.initializedAt) await transaction.putMetadata({ ...metadata, initializedAt: now() });
      await this.ensureSystemRoles(transaction);
    });
    this.stateValue = { ...this.state(), initialized: true };
  }

  transaction<T>(operation: (repository: ControlPlaneUserRepository) => Promise<T>) {
    return this.repository().transaction(operation);
  }

  async close() {
    const repository = this.repositoryValue;
    this.repositoryValue = undefined;
    this.stateValue = undefined;
    await repository?.close();
  }

  private repository() {
    if (!this.repositoryValue) {
      throw Object.assign(new Error("Control Plane user database is not initialized."), {
        code: "CONTROL_PLANE_DATABASE_NOT_INITIALIZED",
      });
    }
    return this.repositoryValue;
  }

  private async ensureSystemRoles(repository = this.repository()) {
    const definitions = [
      systemRole(SYSTEM_ROLE_IDS.admin, "Admin", CONTROL_PLANE_PERMISSION_IDS),
      systemRole(SYSTEM_ROLE_IDS.operator, "Operator", OPERATOR_PERMISSIONS),
      systemRole(SYSTEM_ROLE_IDS.viewer, "Viewer", VIEWER_PERMISSIONS),
    ];
    for (const definition of definitions) {
      const current = await repository.roles.get(definition.id);
      await repository.roles.put(current ? {
        ...definition,
        createdAt: current.createdAt,
        updatedAt: current.permissionIds.join("\0") === definition.permissionIds.join("\0") ? current.updatedAt : definition.updatedAt,
      } : definition);
    }
  }
}
