import { assertCan, type ControlPlaneAction, type ControlPlaneActor, type ControlPlaneResource } from "../auth/authorization.ts";
import type { CloudConnectivityService } from "./service.ts";

export type VerifiedCloudAssertion = {
  accountId: string;
  ownerAccountId?: string;
  deviceSessionId: string;
  controlPlaneId: string;
  bindingId: string;
  bindingRevision: number;
  expiresAt: string;
  accessMode?: "owner" | "shared";
  shareGrantId?: string;
  shareRevision?: number;
  shareRole?: "viewer" | "operator";
};

export class CloudAccessIngress {
  private readonly state: CloudConnectivityService;
  private readonly verifyAssertion: (assertion: unknown) => Promise<VerifiedCloudAssertion> | VerifiedCloudAssertion;
  private readonly clock: () => number;

  constructor(options: { state: CloudConnectivityService; verifyAssertion(assertion: unknown): Promise<VerifiedCloudAssertion> | VerifiedCloudAssertion; clock?: () => number }) {
    this.state = options.state;
    this.verifyAssertion = options.verifyAssertion;
    this.clock = options.clock ?? Date.now;
  }

  async actor(assertion: unknown): Promise<ControlPlaneActor> {
    const verified = await this.verifyAssertion(assertion);
    const current = this.state.snapshot();
    const accessMode = verified.accessMode ?? "owner";
    const ownerAccountId = verified.ownerAccountId ?? verified.accountId;
    const sharedAuthorityValid = accessMode === "owner"
      ? verified.shareGrantId === undefined && verified.shareRevision === undefined && verified.shareRole === undefined
      : verified.accountId !== ownerAccountId && Boolean(verified.shareGrantId) && Number.isInteger(verified.shareRevision) && (verified.shareRole === "viewer" || verified.shareRole === "operator");
    if (current.status !== "active" || current.scopes.deviceAccess !== true || current.cloudControlPlaneId !== verified.controlPlaneId || current.accountId !== ownerAccountId || current.bindingId !== verified.bindingId || current.bindingRevision !== verified.bindingRevision || !sharedAuthorityValid || Date.parse(verified.expiresAt) <= this.clock()) throw ingressError("CLOUD_ASSERTION_NOT_AUTHORIZED");
    return {
      type: "cloud-account", accountId: verified.accountId, deviceSessionId: verified.deviceSessionId,
      bindingId: verified.bindingId, bindingRevision: verified.bindingRevision,
      ownerAccountId, accessMode,
      ...(accessMode === "shared" ? { shareGrantId: verified.shareGrantId, shareRevision: verified.shareRevision, shareRole: verified.shareRole } : {}),
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
