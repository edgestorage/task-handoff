import { z } from "zod";
import {
  ControlPlaneLoginIdentitySummarySchema,
  ControlPlanePermissionIdSchema,
  ControlPlaneRoleSummarySchema,
  ControlPlaneUserDetailSchema,
  ControlPlaneUserNodeScopeSchema,
  ControlPlaneUserSummarySchema,
  type ControlPlanePermissionId,
  type ControlPlaneUserNodeScope,
} from "@task-handoff/protocol/control-plane-access";
import { nowIso as now } from "@task-handoff/core/core/time";
import { createId } from "../../shared/persistence/store.ts";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import type { ControlPlaneUserDatabaseConfigInput } from "./database/index.ts";
import type { ControlPlaneUserRepository } from "./database/repository.ts";
import { hashControlPlanePassword, normalizeControlPlaneLoginName } from "./passwords.ts";
import { ControlPlaneUserStore, SYSTEM_ROLE_IDS } from "./user-store.ts";
import type { LoginIdentityRecord, RoleDefinitionRecord, UserAccountRecord } from "./user-records.ts";

const LoginNameSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.@-]+$/);
const PasswordSchema = z.string().min(8).max(4096);
const NodeScopeInputSchema = ControlPlaneUserNodeScopeSchema;

const BootstrapInputSchema = z.object({
  username: LoginNameSchema,
  password: PasswordSchema,
  displayName: z.string().trim().min(1).max(160).optional(),
}).strict();

const CreateLocalUserInputSchema = BootstrapInputSchema.extend({
  roleIds: z.array(z.string().trim().min(1)).min(1).max(100),
  nodeScope: NodeScopeInputSchema,
  requirePasswordChange: z.boolean().optional(),
}).strict();

const UpdateUserInputSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  status: z.enum(["active", "disabled", "archived"]).optional(),
}).strict().refine((input) => input.displayName !== undefined || input.status !== undefined, {
  message: "At least one user field must be updated.",
});

const SetAccessInputSchema = z.object({
  roleIds: z.array(z.string().trim().min(1)).min(1).max(100),
  nodeScope: NodeScopeInputSchema,
  expectedAuthorizationRevision: z.number().int().positive(),
}).strict();

const CreateRoleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  permissionIds: z.array(ControlPlanePermissionIdSchema).min(1),
}).strict();

const UpdateRoleInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  permissionIds: z.array(ControlPlanePermissionIdSchema).min(1).optional(),
}).strict().refine((input) => Object.values(input).some((value) => value !== undefined), {
  message: "At least one role field must be updated.",
});

const BindExternalIdentityInputSchema = z.object({
  providerId: z.string().trim().min(1),
  subject: z.string().trim().min(1).max(500),
  verifiedEmail: z.string().email().optional(),
  kind: z.enum(["oidc", "oauth"]),
}).strict();

const RecoverLocalCredentialsInputSchema = z.object({
  username: LoginNameSchema,
  password: PasswordSchema,
  userId: z.string().trim().min(1).optional(),
  targetUsername: LoginNameSchema.optional(),
}).strict().refine((input) => !(input.userId && input.targetUsername), {
  message: "Select an account by either userId or targetUsername, not both.",
});

const ApproveExternalIdentityInputSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  roleIds: z.array(z.string().trim().min(1)).min(1).max(100),
  nodeScope: NodeScopeInputSchema,
}).strict();

function conflict(code: string, message: string) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function notFound(kind: string) {
  return Object.assign(new Error(`${kind} was not found.`), { code: `CONTROL_PLANE_${kind.toUpperCase()}_NOT_FOUND`, statusCode: 404 });
}

export function normalizeUserNodeScope(scope: ControlPlaneUserNodeScope): ControlPlaneUserNodeScope {
  if (scope.kind === "all") return { kind: "all" };
  return { kind: "selected", nodeIds: [...new Set(scope.nodeIds.map((id) => id.trim()).filter(Boolean))].sort() };
}

export class ControlPlaneUserService {
  readonly store: ControlPlaneUserStore;
  private bootstrapInProgress = false;
  private initPromise: Promise<unknown> | undefined;

  constructor(paths: ControlPlaneStorePaths, options: { database?: ControlPlaneUserDatabaseConfigInput } = {}) {
    this.store = new ControlPlaneUserStore(paths, options);
  }

  init() {
    if (!this.initPromise) {
      this.initPromise = this.store.init().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  state() {
    const store = this.store.state();
    return { ...store, requiresBootstrap: !store.initialized || this.store.users.list().length === 0 };
  }

  async bootstrapAdmin(input: unknown) {
    await this.init();
    if (this.bootstrapInProgress) throw conflict("AUTH_BOOTSTRAP_IN_PROGRESS", "Control Plane admin initialization is already in progress.");
    const parsed = BootstrapInputSchema.parse(input);
    if (this.store.state().initialized && this.store.users.list().length > 0) {
      throw conflict("AUTH_BOOTSTRAP_ALREADY_DONE", "Control Plane user store is already initialized.");
    }
    this.bootstrapInProgress = true;
    let userId: string | undefined;
    let identityId: string | undefined;
    try {
      await this.store.initializeForBootstrap();
      const created = await this.createLocalUserInternal({
        ...parsed,
        roleIds: [SYSTEM_ROLE_IDS.admin],
        nodeScope: { kind: "all" },
      });
      userId = created.user.id;
      identityId = created.identity.id;
      return this.detail(created.user.id);
    } catch (error) {
      if (userId) {
        await this.store.grants.delete(userId);
        await this.store.users.delete(userId);
      }
      if (identityId) await this.store.identities.delete(identityId);
      throw error;
    } finally {
      this.bootstrapInProgress = false;
    }
  }

  list(options: { includeArchived?: boolean; search?: string } = {}) {
    const search = options.search?.trim().toLocaleLowerCase("en-US");
    return this.store.users.list()
      .filter((user) => options.includeArchived || user.status !== "archived")
      .filter((user) => !search || user.displayName.toLocaleLowerCase("en-US").includes(search)
        || this.localIdentity(user.id)?.normalizedLoginName.includes(search))
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map((user) => this.publicUser(user));
  }

  detail(userId: string) {
    const user = this.requireUser(userId);
    const identities = this.store.identities.list().filter((identity) => identity.userId === userId).map((identity) => this.publicIdentity(identity));
    const accessGrant = this.store.grants.get(userId);
    if (!accessGrant) throw conflict("CONTROL_PLANE_USER_ACCESS_REQUIRED", "User has no access grant.");
    return ControlPlaneUserDetailSchema.parse({
      ...this.publicUser(user),
      identities,
      accessGrant: {
        userId: accessGrant.userId,
        roleIds: accessGrant.roleIds,
        nodeScope: accessGrant.nodeScope,
        authorizationRevision: accessGrant.authorizationRevision,
        updatedAt: accessGrant.updatedAt,
      },
    });
  }

  async createLocalUser(input: unknown) {
    const parsed = CreateLocalUserInputSchema.parse(input);
    const created = await this.createLocalUserInternal(parsed);
    return this.detail(created.user.id);
  }

  async updateUser(userId: string, input: unknown) {
    const parsed = UpdateUserInputSchema.parse(input);
    await this.store.transaction(async (repository) => {
      const current = this.requireUser(userId, repository);
      const candidate: UserAccountRecord = {
        ...current,
        ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
        ...(parsed.status === undefined ? {} : {
          status: parsed.status,
          archivedAt: parsed.status === "archived" ? now() : undefined,
        }),
        updatedAt: now(),
      };
      if (candidate.status !== "active" && this.isLastLoginCapableAdmin(userId, repository)) {
        throw conflict("CONTROL_PLANE_LAST_ACTIVE_ADMIN", "At least one active login-capable Admin must remain.");
      }
      await repository.users.put(candidate);
      if (parsed.status !== undefined && parsed.status !== current.status) await this.bumpAuthorizationRevisionIn(repository, userId);
    });
    return this.detail(userId);
  }

  async setAccess(userId: string, input: unknown) {
    const parsed = SetAccessInputSchema.parse(input);
    await this.store.transaction(async (repository) => {
      this.requireUser(userId, repository);
      const current = repository.grants.get(userId);
      if (!current) throw conflict("CONTROL_PLANE_USER_ACCESS_REQUIRED", "User has no access grant.");
      if (current.authorizationRevision !== parsed.expectedAuthorizationRevision) {
        throw conflict("CONTROL_PLANE_AUTHORIZATION_REVISION_CONFLICT", "User authorization changed before this update was applied.");
      }
      this.assertActiveRoles(parsed.roleIds, repository);
      if (this.isLastLoginCapableAdmin(userId, repository) && !parsed.roleIds.includes(SYSTEM_ROLE_IDS.admin)) {
        throw conflict("CONTROL_PLANE_LAST_ACTIVE_ADMIN", "At least one active login-capable Admin must remain.");
      }
      await repository.grants.put({
        ...current,
        roleIds: [...new Set(parsed.roleIds)].sort(),
        nodeScope: normalizeUserNodeScope(parsed.nodeScope),
        authorizationRevision: current.authorizationRevision + 1,
        updatedAt: now(),
      });
      await this.revokeSessionsIn(repository, userId);
    });
    return this.detail(userId);
  }

  authorization(userId: string, repository?: ControlPlaneUserRepository) {
    const collections = repository || this.store;
    const user = this.requireUser(userId, repository);
    if (user.status !== "active") throw Object.assign(new Error("User is not active."), { code: "CONTROL_PLANE_USER_DISABLED", statusCode: 403 });
    const grant = collections.grants.get(userId);
    if (!grant) throw conflict("CONTROL_PLANE_USER_ACCESS_REQUIRED", "User has no access grant.");
    const roles = grant.roleIds.map((roleId) => collections.roles.get(roleId)).filter((role): role is RoleDefinitionRecord => Boolean(role && role.status === "active"));
    if (roles.length !== grant.roleIds.length) throw conflict("CONTROL_PLANE_ROLE_INACTIVE", "User access references an unavailable role.");
    const permissionIds = [...new Set(roles.flatMap((role) => role.permissionIds))].sort() as ControlPlanePermissionId[];
    return { userId, roleIds: grant.roleIds, permissionIds, nodeScope: grant.nodeScope, authorizationRevision: grant.authorizationRevision };
  }

  async resetLocalPassword(userId: string, password: string, requirePasswordChange = true) {
    PasswordSchema.parse(password);
    const passwordHash = await hashControlPlanePassword(password);
    let identityId = "";
    await this.store.transaction(async (repository) => {
      this.requireUser(userId, repository);
      const identity = this.localIdentity(userId, repository);
      if (!identity) throw notFound("identity");
      identityId = identity.id;
      await repository.identities.put({
        ...identity,
        passwordHash,
        requiresPasswordChange: requirePasswordChange,
        updatedAt: now(),
      });
      await this.bumpAuthorizationRevisionIn(repository, userId);
    });
    return this.publicIdentity(this.store.identities.get(identityId)!);
  }

  async recoverLocalCredentials(input: unknown) {
    const parsed = RecoverLocalCredentialsInputSchema.parse(input);
    const normalizedLoginName = normalizeControlPlaneLoginName(parsed.username);
    const passwordHash = await hashControlPlanePassword(parsed.password);
    let targetId = "";
    await this.store.transaction(async (repository) => {
      const users = repository.users.list();
      const target = parsed.userId
        ? users.find((user) => user.id === parsed.userId)
        : parsed.targetUsername
          ? users.find((user) => this.localIdentity(user.id, repository)?.normalizedLoginName === normalizeControlPlaneLoginName(parsed.targetUsername!))
          : users.length === 1 ? users[0] : undefined;
      if (!target && (parsed.userId || parsed.targetUsername)) throw notFound("user");
      if (!target) throw conflict("AUTH_ACCOUNT_AMBIGUOUS", "The account to recover is ambiguous.");
      if (repository.identities.list().some((identity) => identity.kind === "local-password" && identity.userId !== target.id && identity.normalizedLoginName === normalizedLoginName)) {
        throw conflict("CONTROL_PLANE_USERNAME_CONFLICT", "A Control Plane user already uses that username.");
      }
      const identity = this.localIdentity(target.id, repository);
      if (!identity) throw notFound("identity");
      targetId = target.id;
      await repository.identities.put({
        ...identity,
        normalizedLoginName,
        passwordHash,
        requiresPasswordChange: false,
        updatedAt: now(),
      });
      await this.bumpAuthorizationRevisionIn(repository, target.id);
    });
    return this.detail(targetId);
  }

  async bindExternalIdentity(userId: string, input: unknown) {
    const parsed = BindExternalIdentityInputSchema.parse(input);
    const timestamp = now();
    let identityId = "";
    await this.store.transaction(async (repository) => {
      this.requireUser(userId, repository);
      const provider = repository.providers.get(parsed.providerId);
      if (!provider) throw notFound("identity_provider");
      if ((provider.kind === "oidc" ? "oidc" : "oauth") !== parsed.kind) {
        throw conflict("CONTROL_PLANE_IDENTITY_PROVIDER_KIND_CONFLICT", "Identity kind does not match its provider.");
      }
      if (repository.identities.list().some((identity) => identity.providerId === parsed.providerId && identity.subject === parsed.subject)) {
        throw conflict("CONTROL_PLANE_EXTERNAL_IDENTITY_CONFLICT", "External identity is already bound to a user.");
      }
      const identity = await repository.identities.put({
        id: createId("identity"),
        userId,
        kind: parsed.kind,
        providerId: parsed.providerId,
        subject: parsed.subject,
        verifiedEmail: parsed.verifiedEmail,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      identityId = identity.id;
      await this.bumpAuthorizationRevisionIn(repository, userId);
    });
    return this.publicIdentity(this.store.identities.get(identityId)!);
  }

  async unbindIdentity(userId: string, identityId: string) {
    await this.store.transaction(async (repository) => {
      const user = this.requireUser(userId, repository);
      const identity = repository.identities.get(identityId);
      if (!identity || identity.userId !== userId) throw notFound("identity");
      const identities = repository.identities.list().filter((candidate) => candidate.userId === userId);
      if (identities.length <= 1 && user.status === "active") {
        throw conflict("CONTROL_PLANE_LAST_LOGIN_IDENTITY", "An active user must retain at least one login identity.");
      }
      if (this.isLastLoginCapableAdmin(userId, repository) && identities.length <= 1) {
        throw conflict("CONTROL_PLANE_LAST_ACTIVE_ADMIN", "At least one active login-capable Admin must remain.");
      }
      await repository.identities.delete(identityId);
      await this.bumpAuthorizationRevisionIn(repository, userId);
    });
    return { unbound: true };
  }

  async approveExternalIdentity(actorUserId: string, approvalId: string, input: unknown) {
    if (!this.authorization(actorUserId).permissionIds.includes("users:manage")) {
      throw Object.assign(new Error("User management is forbidden."), { code: "CONTROL_PLANE_FORBIDDEN", statusCode: 403 });
    }
    const parsed = ApproveExternalIdentityInputSchema.parse(input);
    this.assertActiveRoles(parsed.roleIds);
    const approval = this.store.approvals.get(approvalId);
    if (!approval || approval.status !== "pending" || approval.expiresAt <= now()) {
      throw conflict("CONTROL_PLANE_EXTERNAL_IDENTITY_APPROVAL_INVALID", "External identity approval is invalid or expired.");
    }
    const provider = this.store.providers.get(approval.providerId);
    if (!provider || provider.status !== "enabled") throw notFound("identity_provider");
    if (this.store.identities.list().some((identity) => identity.providerId === approval.providerId && identity.subject === approval.subject)) {
      throw conflict("CONTROL_PLANE_EXTERNAL_IDENTITY_CONFLICT", "External identity is already bound to a user.");
    }
    const timestamp = now();
    const user: UserAccountRecord = {
      id: createId("user"),
      displayName: parsed.displayName || approval.displayName || approval.verifiedEmail || "External user",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const identity: LoginIdentityRecord = {
      id: createId("identity"),
      userId: user.id,
      kind: provider.kind === "oidc" ? "oidc" : "oauth",
      providerId: provider.id,
      subject: approval.subject,
      verifiedEmail: approval.verifiedEmail,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.transaction(async (repository) => {
      const currentApproval = repository.approvals.get(approvalId);
      if (!currentApproval || currentApproval.status !== "pending" || currentApproval.expiresAt <= now()) {
        throw conflict("CONTROL_PLANE_EXTERNAL_IDENTITY_APPROVAL_INVALID", "External identity approval is invalid or expired.");
      }
      if (repository.identities.list().some((candidate) => candidate.providerId === approval.providerId && candidate.subject === approval.subject)) {
        throw conflict("CONTROL_PLANE_EXTERNAL_IDENTITY_CONFLICT", "External identity is already bound to a user.");
      }
      this.assertActiveRoles(parsed.roleIds, repository);
      await repository.users.put(user);
      await repository.identities.put(identity);
      await repository.grants.put({
        id: user.id,
        userId: user.id,
        roleIds: [...new Set(parsed.roleIds)].sort(),
        nodeScope: normalizeUserNodeScope(parsed.nodeScope),
        authorizationRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await repository.approvals.put({ ...currentApproval, status: "approved", decidedAt: timestamp, decidedByUserId: actorUserId, updatedAt: timestamp });
    });
    return this.detail(user.id);
  }

  async rejectExternalIdentity(actorUserId: string, approvalId: string) {
    if (!this.authorization(actorUserId).permissionIds.includes("users:manage")) {
      throw Object.assign(new Error("User management is forbidden."), { code: "CONTROL_PLANE_FORBIDDEN", statusCode: 403 });
    }
    const timestamp = now();
    await this.store.transaction(async (repository) => {
      const approval = repository.approvals.get(approvalId);
      if (!approval || approval.status !== "pending") throw notFound("external_identity_approval");
      await repository.approvals.put({ ...approval, status: "rejected", decidedAt: timestamp, decidedByUserId: actorUserId, updatedAt: timestamp });
    });
    return { rejected: true };
  }

  async createRole(input: unknown) {
    const parsed = CreateRoleInputSchema.parse(input);
    const timestamp = now();
    return this.store.transaction(async (repository) => {
      if (repository.roles.list().some((role) => role.name.toLocaleLowerCase("en-US") === parsed.name.toLocaleLowerCase("en-US") && role.status === "active")) {
        throw conflict("CONTROL_PLANE_ROLE_NAME_CONFLICT", "An active role already uses that name.");
      }
      return ControlPlaneRoleSummarySchema.parse(await repository.roles.put({
        id: createId("role"), name: parsed.name, description: parsed.description, system: false, status: "active",
        permissionIds: [...new Set(parsed.permissionIds)].sort(), createdAt: timestamp, updatedAt: timestamp,
      }));
    });
  }

  async updateRole(roleId: string, input: unknown) {
    const parsed = UpdateRoleInputSchema.parse(input);
    const updated = await this.store.transaction(async (repository) => {
      const current = repository.roles.get(roleId);
      if (!current) throw notFound("role");
      if (current.system) throw conflict("CONTROL_PLANE_SYSTEM_ROLE_IMMUTABLE", "System roles cannot be edited.");
      if (parsed.name && repository.roles.list().some((role) => role.id !== roleId && role.status === "active" && role.name.toLocaleLowerCase("en-US") === parsed.name!.toLocaleLowerCase("en-US"))) {
        throw conflict("CONTROL_PLANE_ROLE_NAME_CONFLICT", "An active role already uses that name.");
      }
      const changed = await repository.roles.put({
        ...current,
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        ...(parsed.description === undefined ? {} : { description: parsed.description }),
        ...(parsed.permissionIds === undefined ? {} : { permissionIds: [...new Set(parsed.permissionIds)].sort() }),
        updatedAt: now(),
      });
      for (const grant of repository.grants.list().filter((candidate) => candidate.roleIds.includes(roleId))) {
        await repository.grants.put({ ...grant, authorizationRevision: grant.authorizationRevision + 1, updatedAt: now() });
        await this.revokeSessionsIn(repository, grant.userId);
      }
      return changed;
    });
    return ControlPlaneRoleSummarySchema.parse(updated);
  }

  async archiveRole(roleId: string) {
    return this.store.transaction(async (repository) => {
      const current = repository.roles.get(roleId);
      if (!current) throw notFound("role");
      if (current.system) throw conflict("CONTROL_PLANE_SYSTEM_ROLE_IMMUTABLE", "System roles cannot be archived.");
      if (repository.grants.list().some((grant) => grant.roleIds.includes(roleId))) {
        throw conflict("CONTROL_PLANE_ROLE_IN_USE", "Role is assigned to one or more users.");
      }
      return ControlPlaneRoleSummarySchema.parse(await repository.roles.put({ ...current, status: "archived", updatedAt: now() }));
    });
  }

  async revokeSessions(userId: string) {
    return this.store.transaction((repository) => this.revokeSessionsIn(repository, userId));
  }

  private async revokeSessionsIn(repository: ControlPlaneUserRepository, userId: string) {
    let revoked = 0;
    for (const session of repository.sessions.list()) {
      if (session.userId !== userId) continue;
      if (await repository.sessions.delete(session.id)) revoked += 1;
    }
    return revoked;
  }

  private async bumpAuthorizationRevisionIn(repository: ControlPlaneUserRepository, userId: string) {
    const grant = repository.grants.get(userId);
    if (!grant) throw conflict("CONTROL_PLANE_USER_ACCESS_REQUIRED", "User has no access grant.");
    await repository.grants.put({ ...grant, authorizationRevision: grant.authorizationRevision + 1, updatedAt: now() });
    await this.revokeSessionsIn(repository, userId);
  }

  private async createLocalUserInternal(input: z.infer<typeof CreateLocalUserInputSchema>) {
    const normalizedLoginName = normalizeControlPlaneLoginName(input.username);
    const timestamp = now();
    const user: UserAccountRecord = {
      id: createId("user"),
      displayName: input.displayName || input.username,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const identity: LoginIdentityRecord = {
      id: createId("identity"),
      userId: user.id,
      kind: "local-password",
      normalizedLoginName,
      passwordHash: await hashControlPlanePassword(input.password),
      requiresPasswordChange: input.requirePasswordChange || false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.store.transaction(async (repository) => {
      if (repository.identities.list().some((candidate) => candidate.kind === "local-password" && candidate.normalizedLoginName === normalizedLoginName)) {
        throw conflict("CONTROL_PLANE_USERNAME_CONFLICT", "A Control Plane user already uses that username.");
      }
      this.assertActiveRoles(input.roleIds, repository);
      await repository.users.put(user);
      await repository.identities.put(identity);
      await repository.grants.put({
        id: user.id,
        userId: user.id,
        roleIds: [...new Set(input.roleIds)].sort(),
        nodeScope: normalizeUserNodeScope(input.nodeScope),
        authorizationRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return { user, identity };
    });
  }

  private requireUser(userId: string, repository?: ControlPlaneUserRepository) {
    const user = (repository?.users || this.store.users).get(userId);
    if (!user) throw notFound("user");
    return user;
  }

  private localIdentity(userId: string, repository?: ControlPlaneUserRepository) {
    return (repository?.identities || this.store.identities).list().find((identity) => identity.userId === userId && identity.kind === "local-password");
  }

  private publicUser(user: UserAccountRecord) {
    return ControlPlaneUserSummarySchema.parse({
      ...user,
      primaryUsername: this.localIdentity(user.id)?.normalizedLoginName,
    });
  }

  private publicIdentity(identity: LoginIdentityRecord) {
    return ControlPlaneLoginIdentitySummarySchema.parse({
      id: identity.id,
      userId: identity.userId,
      kind: identity.kind,
      providerId: identity.providerId,
      loginName: identity.normalizedLoginName,
      subject: identity.subject,
      verifiedEmail: identity.verifiedEmail,
      requiresPasswordChange: identity.requiresPasswordChange,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
      lastUsedAt: identity.lastUsedAt,
    });
  }

  private assertActiveRoles(roleIds: readonly string[], repository?: ControlPlaneUserRepository) {
    const unique = [...new Set(roleIds)];
    if (unique.length !== roleIds.length) throw conflict("CONTROL_PLANE_ROLE_DUPLICATE", "Role assignments must be unique.");
    for (const roleId of unique) {
      const role = (repository?.roles || this.store.roles).get(roleId);
      if (!role || role.status !== "active") throw notFound("role");
    }
  }

  private isLastLoginCapableAdmin(userId: string, repository?: ControlPlaneUserRepository) {
    const collections = repository || this.store;
    const targetGrant = collections.grants.get(userId);
    if (!targetGrant?.roleIds.includes(SYSTEM_ROLE_IDS.admin)) return false;
    return collections.users.list().filter((user) => user.status === "active").filter((user) => {
      const grant = collections.grants.get(user.id);
      const hasIdentity = collections.identities.list().some((identity) => identity.userId === user.id && (
        identity.kind === "local-password" || collections.providers.get(identity.providerId || "")?.status === "enabled"
      ));
      return grant?.roleIds.includes(SYSTEM_ROLE_IDS.admin) && hasIdentity;
    }).length <= 1;
  }

  roleSummaries() {
    return this.store.roles.list().map((role) => ControlPlaneRoleSummarySchema.parse(role));
  }
}
