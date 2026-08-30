import { z } from "zod";
import {
  ControlPlaneLoginIdentitySummarySchema,
  ControlPlanePermissionIdSchema,
  ControlPlaneRoleSummarySchema,
  ControlPlaneUserDetailSchema,
  ControlPlaneUserInstanceScopeSchema,
  ControlPlaneUserLoginNameSchema,
  ControlPlaneUserNodeScopeSchema,
  ControlPlaneUserSummarySchema,
  ControlPlaneUpdateUserInputSchema,
  type ControlPlanePermissionId,
  type ControlPlaneUserInstanceScope,
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

type LoginCapabilityProjection = {
  userStatus?: { userId: string; status: UserAccountRecord["status"] };
  roleIds?: { userId: string; roleIds: readonly string[] };
  removedIdentityId?: string;
  providerStatus?: { providerId: string; status: "enabled" | "disabled" };
};

const LoginNameSchema = ControlPlaneUserLoginNameSchema;
const PasswordSchema = z.string().min(8).max(4096);
const NodeScopeInputSchema = ControlPlaneUserNodeScopeSchema;
const InstanceScopeInputSchema = ControlPlaneUserInstanceScopeSchema;

const BootstrapInputSchema = z.object({
  username: LoginNameSchema,
  password: PasswordSchema,
  displayName: z.string().trim().min(1).max(160).optional(),
}).strict();

const CreateLocalUserInputSchema = BootstrapInputSchema.extend({
  roleIds: z.array(z.string().trim().min(1)).min(1).max(100),
  nodeScope: NodeScopeInputSchema,
  instanceScope: InstanceScopeInputSchema.optional(),
  requirePasswordChange: z.boolean().optional(),
}).strict();

const SetAccessInputSchema = z.object({
  roleIds: z.array(z.string().trim().min(1)).min(1).max(100),
  nodeScope: NodeScopeInputSchema,
  instanceScope: InstanceScopeInputSchema.optional(),
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
  instanceScope: InstanceScopeInputSchema.optional(),
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

export function normalizeUserInstanceScope(scope: ControlPlaneUserInstanceScope): ControlPlaneUserInstanceScope {
  if (scope.kind === "inherit-node-scope") return { kind: "inherit-node-scope" };
  return { kind: "selected", instanceIds: [...new Set(scope.instanceIds.map((id) => id.trim()).filter(Boolean))].sort() };
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

  async state() {
    const store = this.store.state();
    return { ...store, requiresBootstrap: !store.initialized || (await this.store.users.list()).length === 0 };
  }

  async bootstrapAdmin(input: unknown) {
    await this.init();
    if (this.bootstrapInProgress) throw conflict("AUTH_BOOTSTRAP_IN_PROGRESS", "Control Plane admin initialization is already in progress.");
    const parsed = BootstrapInputSchema.parse(input);
    if (this.store.state().initialized && (await this.store.users.list()).length > 0) {
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
        instanceScope: { kind: "inherit-node-scope" },
      });
      userId = created.user.id;
      identityId = created.identity.id;
      return await this.detail(created.user.id);
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

  async list(options: { includeArchived?: boolean; search?: string } = {}) {
    const search = options.search?.trim().toLocaleLowerCase("en-US");
    const [users, identities] = await Promise.all([this.store.users.list(), this.store.identities.list()]);
    const localIdentityByUser = new Map(identities.filter((identity) => identity.kind === "local-password").map((identity) => [identity.userId, identity]));
    return users
      .filter((user) => options.includeArchived || user.status !== "archived")
      .filter((user) => !search || user.displayName.toLocaleLowerCase("en-US").includes(search)
        || localIdentityByUser.get(user.id)?.normalizedLoginName?.includes(search))
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map((user) => this.publicUser(user, localIdentityByUser.get(user.id)));
  }

  async detail(userId: string) {
    const user = await this.requireUser(userId);
    const [identityRecords, accessGrant] = await Promise.all([
      this.store.identities.listByUser(userId),
      this.store.grants.get(userId),
    ]);
    if (!accessGrant) throw conflict("CONTROL_PLANE_USER_ACCESS_REQUIRED", "User has no access grant.");
    const identities = identityRecords.map((identity) => this.publicIdentity(identity));
    return ControlPlaneUserDetailSchema.parse({
      ...this.publicUser(user, identityRecords.find((identity) => identity.kind === "local-password")),
      identities,
      accessGrant: {
        userId: accessGrant.userId,
        roleIds: accessGrant.roleIds,
        nodeScope: accessGrant.nodeScope,
        instanceScope: accessGrant.instanceScope,
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
    const parsed = ControlPlaneUpdateUserInputSchema.parse(input);
    await this.store.transaction(async (repository) => {
      const current = await this.requireUser(userId, repository);
      const timestamp = now();
      if (parsed.username !== undefined) {
        const identity = await this.localIdentity(userId, repository);
        if (!identity) throw notFound("identity");
        const normalizedLoginName = normalizeControlPlaneLoginName(parsed.username);
        const conflictingIdentity = await repository.identities.findByLoginName(normalizedLoginName);
        if (conflictingIdentity && conflictingIdentity.id !== identity.id) {
          throw conflict("CONTROL_PLANE_USERNAME_CONFLICT", "A Control Plane user already uses that username.");
        }
        await repository.identities.put({ ...identity, normalizedLoginName, updatedAt: timestamp });
      }
      const candidate: UserAccountRecord = {
        ...current,
        ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
        ...(parsed.status === undefined ? {} : {
          status: parsed.status,
          archivedAt: parsed.status === "archived" ? now() : undefined,
        }),
        updatedAt: timestamp,
      };
      await this.assertLoginCapableAdminRemains(repository, { userStatus: { userId, status: candidate.status } });
      await repository.users.put(candidate);
      if (parsed.status !== undefined && parsed.status !== current.status) await this.bumpAuthorizationRevisionIn(repository, userId);
    });
    return this.detail(userId);
  }

  async setAccess(userId: string, input: unknown) {
    const parsed = SetAccessInputSchema.parse(input);
    await this.store.transaction(async (repository) => {
      await this.requireUser(userId, repository);
      const current = await repository.grants.get(userId);
      if (!current) throw conflict("CONTROL_PLANE_USER_ACCESS_REQUIRED", "User has no access grant.");
      if (current.authorizationRevision !== parsed.expectedAuthorizationRevision) {
        throw conflict("CONTROL_PLANE_AUTHORIZATION_REVISION_CONFLICT", "User authorization changed before this update was applied.");
      }
      await this.assertActiveRoles(parsed.roleIds, repository);
      await this.assertLoginCapableAdminRemains(repository, { roleIds: { userId, roleIds: parsed.roleIds } });
      await repository.grants.put({
        ...current,
        roleIds: [...new Set(parsed.roleIds)].sort(),
        nodeScope: normalizeUserNodeScope(parsed.nodeScope),
        instanceScope: parsed.instanceScope ? normalizeUserInstanceScope(parsed.instanceScope) : current.instanceScope,
        authorizationRevision: current.authorizationRevision + 1,
        updatedAt: now(),
      });
      await this.revokeSessionsIn(repository, userId);
    });
    return this.detail(userId);
  }

  async authorization(userId: string, repository?: ControlPlaneUserRepository) {
    const collections = repository || this.store;
    const user = await this.requireUser(userId, repository);
    if (user.status !== "active") throw Object.assign(new Error("User is not active."), { code: "CONTROL_PLANE_USER_DISABLED", statusCode: 403 });
    const grant = await collections.grants.get(userId);
    if (!grant) throw conflict("CONTROL_PLANE_USER_ACCESS_REQUIRED", "User has no access grant.");
    const roleRecords = await Promise.all(grant.roleIds.map((roleId) => collections.roles.get(roleId)));
    const roles = roleRecords.filter((role): role is RoleDefinitionRecord => Boolean(role && role.status === "active"));
    if (roles.length !== grant.roleIds.length) throw conflict("CONTROL_PLANE_ROLE_INACTIVE", "User access references an unavailable role.");
    const permissionIds = [...new Set(roles.flatMap((role) => role.permissionIds))].sort() as ControlPlanePermissionId[];
    return {
      userId,
      roleIds: grant.roleIds,
      permissionIds,
      nodeScope: grant.nodeScope,
      instanceScope: grant.instanceScope,
      authorizationRevision: grant.authorizationRevision,
    };
  }

  async resetLocalPassword(userId: string, password: string, requirePasswordChange = true) {
    PasswordSchema.parse(password);
    const passwordHash = await hashControlPlanePassword(password);
    let identityId = "";
    await this.store.transaction(async (repository) => {
      await this.requireUser(userId, repository);
      const identity = await this.localIdentity(userId, repository);
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
    return this.publicIdentity((await this.store.identities.get(identityId))!);
  }

  async recoverLocalCredentials(input: unknown) {
    const parsed = RecoverLocalCredentialsInputSchema.parse(input);
    const normalizedLoginName = normalizeControlPlaneLoginName(parsed.username);
    const passwordHash = await hashControlPlanePassword(parsed.password);
    let targetId = "";
    await this.store.transaction(async (repository) => {
      const users = await repository.users.list();
      const target = parsed.userId
        ? users.find((user) => user.id === parsed.userId)
        : parsed.targetUsername
          ? (await Promise.all(users.map(async (user) => ({ user, identity: await this.localIdentity(user.id, repository) }))))
            .find(({ identity }) => identity?.normalizedLoginName === normalizeControlPlaneLoginName(parsed.targetUsername!))?.user
          : users.length === 1 ? users[0] : undefined;
      if (!target && (parsed.userId || parsed.targetUsername)) throw notFound("user");
      if (!target) throw conflict("AUTH_ACCOUNT_AMBIGUOUS", "The account to recover is ambiguous.");
      const conflictingIdentity = await repository.identities.findByLoginName(normalizedLoginName);
      if (conflictingIdentity && conflictingIdentity.userId !== target.id) {
        throw conflict("CONTROL_PLANE_USERNAME_CONFLICT", "A Control Plane user already uses that username.");
      }
      const identity = await this.localIdentity(target.id, repository);
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

  async unbindExternalIdentity(userId: string, identityId: string) {
    await this.store.transaction(async (repository) => {
      const user = await this.requireUser(userId, repository);
      const identity = await repository.identities.get(identityId);
      if (!identity || identity.userId !== userId) throw notFound("identity");
      if (identity.kind === "local-password") {
        throw conflict("CONTROL_PLANE_LOCAL_IDENTITY_IMMUTABLE", "Local password identities cannot be unbound.");
      }
      const projection = { removedIdentityId: identityId };
      await this.assertLoginCapableAdminRemains(repository, projection);
      if (user.status === "active" && !await this.hasLoginCapableIdentity(userId, repository, projection)) {
        throw conflict("CONTROL_PLANE_LAST_LOGIN_IDENTITY", "An active user must retain at least one login identity.");
      }
      await repository.identities.delete(identityId);
      await this.bumpAuthorizationRevisionIn(repository, userId);
    });
    return { unbound: true };
  }

  async approveExternalIdentity(actorUserId: string, approvalId: string, input: unknown) {
    if (!(await this.authorization(actorUserId)).permissionIds.includes("users:manage")) {
      throw Object.assign(new Error("User management is forbidden."), { code: "CONTROL_PLANE_FORBIDDEN", statusCode: 403 });
    }
    const parsed = ApproveExternalIdentityInputSchema.parse(input);
    await this.assertActiveRoles(parsed.roleIds);
    const approval = await this.store.approvals.get(approvalId);
    if (!approval || approval.status !== "pending" || approval.expiresAt <= now()) {
      throw conflict("CONTROL_PLANE_EXTERNAL_IDENTITY_APPROVAL_INVALID", "External identity approval is invalid or expired.");
    }
    const provider = await this.store.providers.get(approval.providerId);
    if (!provider || provider.status !== "enabled") throw notFound("identity_provider");
    if (await this.store.identities.findByProviderSubject(approval.providerId, approval.subject)) {
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
      const currentApproval = await repository.approvals.get(approvalId);
      if (!currentApproval || currentApproval.status !== "pending" || currentApproval.expiresAt <= now()) {
        throw conflict("CONTROL_PLANE_EXTERNAL_IDENTITY_APPROVAL_INVALID", "External identity approval is invalid or expired.");
      }
      if (await repository.identities.findByProviderSubject(approval.providerId, approval.subject)) {
        throw conflict("CONTROL_PLANE_EXTERNAL_IDENTITY_CONFLICT", "External identity is already bound to a user.");
      }
      await this.assertActiveRoles(parsed.roleIds, repository);
      await repository.users.put(user);
      await repository.identities.put(identity);
      await repository.grants.put({
        userId: user.id,
        roleIds: [...new Set(parsed.roleIds)].sort(),
        nodeScope: normalizeUserNodeScope(parsed.nodeScope),
        instanceScope: normalizeUserInstanceScope(parsed.instanceScope || { kind: "inherit-node-scope" }),
        authorizationRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await repository.approvals.put({ ...currentApproval, status: "approved", decidedAt: timestamp, decidedByUserId: actorUserId, updatedAt: timestamp });
    });
    return this.detail(user.id);
  }

  async rejectExternalIdentity(actorUserId: string, approvalId: string) {
    if (!(await this.authorization(actorUserId)).permissionIds.includes("users:manage")) {
      throw Object.assign(new Error("User management is forbidden."), { code: "CONTROL_PLANE_FORBIDDEN", statusCode: 403 });
    }
    const timestamp = now();
    await this.store.transaction(async (repository) => {
      const approval = await repository.approvals.get(approvalId);
      if (!approval || approval.status !== "pending") throw notFound("external_identity_approval");
      await repository.approvals.put({ ...approval, status: "rejected", decidedAt: timestamp, decidedByUserId: actorUserId, updatedAt: timestamp });
    });
    return { rejected: true };
  }

  async createRole(input: unknown) {
    const parsed = CreateRoleInputSchema.parse(input);
    const timestamp = now();
    return this.store.transaction(async (repository) => {
      if ((await repository.roles.list()).some((role) => role.name.toLocaleLowerCase("en-US") === parsed.name.toLocaleLowerCase("en-US") && role.status === "active")) {
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
      const current = await repository.roles.get(roleId);
      if (!current) throw notFound("role");
      if (current.system) throw conflict("CONTROL_PLANE_SYSTEM_ROLE_IMMUTABLE", "System roles cannot be edited.");
      if (parsed.name && (await repository.roles.list()).some((role) => role.id !== roleId && role.status === "active" && role.name.toLocaleLowerCase("en-US") === parsed.name!.toLocaleLowerCase("en-US"))) {
        throw conflict("CONTROL_PLANE_ROLE_NAME_CONFLICT", "An active role already uses that name.");
      }
      const changed = await repository.roles.put({
        ...current,
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        ...(parsed.description === undefined ? {} : { description: parsed.description }),
        ...(parsed.permissionIds === undefined ? {} : { permissionIds: [...new Set(parsed.permissionIds)].sort() }),
        updatedAt: now(),
      });
      for (const grant of await repository.grants.listByRole(roleId)) {
        await repository.grants.put({ ...grant, authorizationRevision: grant.authorizationRevision + 1, updatedAt: now() });
        await this.revokeSessionsIn(repository, grant.userId);
      }
      return changed;
    });
    return ControlPlaneRoleSummarySchema.parse(updated);
  }

  async archiveRole(roleId: string) {
    return this.store.transaction(async (repository) => {
      const current = await repository.roles.get(roleId);
      if (!current) throw notFound("role");
      if (current.system) throw conflict("CONTROL_PLANE_SYSTEM_ROLE_IMMUTABLE", "System roles cannot be archived.");
      if ((await repository.grants.listByRole(roleId)).length > 0) {
        throw conflict("CONTROL_PLANE_ROLE_IN_USE", "Role is assigned to one or more users.");
      }
      return ControlPlaneRoleSummarySchema.parse(await repository.roles.put({ ...current, status: "archived", updatedAt: now() }));
    });
  }

  async revokeSessions(userId: string) {
    return this.store.transaction((repository) => this.revokeSessionsIn(repository, userId));
  }

  async removeInstanceFromAccessScopes(instanceId: string) {
    return this.store.transaction(async (repository) => {
      const affectedUserIds: string[] = [];
      for (const grant of await repository.grants.list()) {
        if (grant.instanceScope.kind !== "selected" || !grant.instanceScope.instanceIds.includes(instanceId)) continue;
        await repository.grants.put({
          ...grant,
          instanceScope: {
            kind: "selected",
            instanceIds: grant.instanceScope.instanceIds.filter((candidate) => candidate !== instanceId),
          },
          authorizationRevision: grant.authorizationRevision + 1,
          updatedAt: now(),
        });
        await this.revokeSessionsIn(repository, grant.userId);
        affectedUserIds.push(grant.userId);
      }
      return affectedUserIds;
    });
  }

  private async revokeSessionsIn(repository: ControlPlaneUserRepository, userId: string) {
    let revoked = 0;
    for (const session of await repository.sessions.listByUser(userId)) {
      if (await repository.sessions.delete(session.id)) revoked += 1;
    }
    return revoked;
  }

  private async bumpAuthorizationRevisionIn(repository: ControlPlaneUserRepository, userId: string) {
    const grant = await repository.grants.get(userId);
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
      if (await repository.identities.findByLoginName(normalizedLoginName)) {
        throw conflict("CONTROL_PLANE_USERNAME_CONFLICT", "A Control Plane user already uses that username.");
      }
      await this.assertActiveRoles(input.roleIds, repository);
      await repository.users.put(user);
      await repository.identities.put(identity);
      await repository.grants.put({
        userId: user.id,
        roleIds: [...new Set(input.roleIds)].sort(),
        nodeScope: normalizeUserNodeScope(input.nodeScope),
        instanceScope: normalizeUserInstanceScope(input.instanceScope || { kind: "inherit-node-scope" }),
        authorizationRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return { user, identity };
    });
  }

  private async requireUser(userId: string, repository?: ControlPlaneUserRepository) {
    const user = await (repository?.users || this.store.users).get(userId);
    if (!user) throw notFound("user");
    return user;
  }

  private async localIdentity(userId: string, repository?: ControlPlaneUserRepository) {
    return (await (repository?.identities || this.store.identities).listByUser(userId)).find((identity) => identity.kind === "local-password");
  }

  private publicUser(user: UserAccountRecord, localIdentity?: LoginIdentityRecord) {
    return ControlPlaneUserSummarySchema.parse({
      id: user.id,
      displayName: user.displayName,
      primaryUsername: localIdentity?.normalizedLoginName,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
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

  private async assertActiveRoles(roleIds: readonly string[], repository?: ControlPlaneUserRepository) {
    const unique = [...new Set(roleIds)];
    if (unique.length !== roleIds.length) throw conflict("CONTROL_PLANE_ROLE_DUPLICATE", "Role assignments must be unique.");
    for (const roleId of unique) {
      const role = await (repository?.roles || this.store.roles).get(roleId);
      if (!role || role.status !== "active") throw notFound("role");
    }
  }

  async assertProviderStatusChangeAllowed(providerId: string, status: "enabled" | "disabled", repository?: ControlPlaneUserRepository) {
    if (status === "enabled") return;
    await this.assertLoginCapableAdminRemains(repository || this.store, {
      providerStatus: { providerId, status },
    });
  }

  private async assertLoginCapableAdminRemains(
    repository: ControlPlaneUserRepository | ControlPlaneUserStore,
    projection: LoginCapabilityProjection = {},
  ) {
    let remains = false;
    for (const user of await repository.users.list()) {
      const status = projection.userStatus?.userId === user.id ? projection.userStatus.status : user.status;
      if (status !== "active") continue;
      const grant = await repository.grants.get(user.id);
      const roleIds = projection.roleIds?.userId === user.id ? projection.roleIds.roleIds : grant?.roleIds;
      if (roleIds?.includes(SYSTEM_ROLE_IDS.admin) === true
        && await this.hasLoginCapableIdentity(user.id, repository, projection)) {
        remains = true;
        break;
      }
    }
    if (!remains) {
      throw conflict("CONTROL_PLANE_LAST_ACTIVE_ADMIN", "At least one active login-capable Admin must remain.");
    }
  }

  private async hasLoginCapableIdentity(
    userId: string,
    repository: ControlPlaneUserRepository | ControlPlaneUserStore,
    projection: LoginCapabilityProjection,
  ) {
    for (const identity of await repository.identities.listByUser(userId)) {
      if (identity.id === projection.removedIdentityId) continue;
      if (identity.kind === "local-password") return true;
      const provider = await repository.providers.get(identity.providerId || "");
      const status = projection.providerStatus?.providerId === provider?.id ? projection.providerStatus.status : provider?.status;
      if (status === "enabled") return true;
    }
    return false;
  }

  async roleSummaries() {
    return (await this.store.roles.list()).map((role) => ControlPlaneRoleSummarySchema.parse(role));
  }
}
