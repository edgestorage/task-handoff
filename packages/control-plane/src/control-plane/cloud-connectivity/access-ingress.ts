import { assertCan, type ControlPlaneAction, type ControlPlaneActor, type ControlPlaneResource } from "../auth/authorization.ts";
import type { CloudConnectivityService } from "./service.ts";

export type VerifiedCloudAssertion = {
  accountId: string;
  ownerAccountId: string;
  deviceSessionId: string;
  controlPlaneId: string;
  bindingId: string;
  bindingRevision: number;
  expiresAt: string;
  accessMode: "owner" | "shared";
  shareGrantId?: string;
  shareRevision?: number;
  accessRoleId: string;
};

export class CloudAccessIngress {
  private readonly state: CloudConnectivityService;
  private readonly verifyAssertion: (assertion: unknown) => Promise<VerifiedCloudAssertion> | VerifiedCloudAssertion;
  private readonly roleResolver: (roleId: string) => Promise<{ roleIds: string[]; permissionIds: import("@task-handoff/protocol/control-plane-access").ControlPlanePermissionId[]; authorizationRevision: number }>;
  private readonly clock: () => number;

  constructor(options: { state: CloudConnectivityService; verifyAssertion(assertion: unknown): Promise<VerifiedCloudAssertion> | VerifiedCloudAssertion; resolveRole(roleId: string): Promise<{ roleIds: string[]; permissionIds: import("@task-handoff/protocol/control-plane-access").ControlPlanePermissionId[]; authorizationRevision: number }>; clock?: () => number }) {
    this.state = options.state;
    this.verifyAssertion = options.verifyAssertion;
    this.roleResolver = options.resolveRole;
    this.clock = options.clock ?? Date.now;
  }

  async actor(assertion: unknown): Promise<ControlPlaneActor> {
    const verified = await this.verifyAssertion(assertion);
    const current = this.state.snapshot();
    const { accessMode, ownerAccountId, accessRoleId } = verified;
    const sharedAuthorityValid = accessMode === "owner"
      ? verified.shareGrantId === undefined && verified.shareRevision === undefined
      : verified.accountId !== ownerAccountId && Boolean(verified.shareGrantId) && Number.isInteger(verified.shareRevision);
    if (current.status !== "active" || current.scopes.deviceAccess !== true || current.cloudControlPlaneId !== verified.controlPlaneId || current.accountId !== ownerAccountId || current.bindingId !== verified.bindingId || current.bindingRevision !== verified.bindingRevision || !sharedAuthorityValid || Date.parse(verified.expiresAt) <= this.clock()) throw ingressError("CLOUD_ASSERTION_NOT_AUTHORIZED");
    const role = await this.roleResolver(accessRoleId);
    return {
      type: "cloud-account", accountId: verified.accountId, deviceSessionId: verified.deviceSessionId,
      bindingId: verified.bindingId, bindingRevision: verified.bindingRevision,
      ownerAccountId, accessMode, accessRoleId,
      roleIds: role.roleIds, permissionIds: role.permissionIds,
      nodeScope: { kind: "all" }, instanceScope: { kind: "inherit-node-scope" },
      authorizationRevision: role.authorizationRevision,
      ...(accessMode === "shared" ? { shareGrantId: verified.shareGrantId, shareRevision: verified.shareRevision } : {}),
    };
  }

  async authorize(assertion: unknown, action: ControlPlaneAction, resource: ControlPlaneResource) {
    const actor = await this.actor(assertion);
    assertCan(actor, action, resource);
    return actor;
  }

  async dispatch<T>(assertion: unknown, action: ControlPlaneAction, resource: ControlPlaneResource, operation: (actor: ControlPlaneActor) => Promise<T> | T) {
    const actor = await this.authorize(assertion, action, resource);
    return operation(actor);
  }
}

function ingressError(code: string) {
  return Object.assign(new Error("Cloud access assertion is not authorized."), { code, statusCode: 401 });
}
