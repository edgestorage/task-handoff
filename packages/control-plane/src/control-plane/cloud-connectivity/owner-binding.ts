export type CloudBindingStatus = "unbound" | "pending-claim" | "active" | "pending-revocation" | "clone-conflict";

/**
 * A Cloud binding can change its local owner only after the previous binding is
 * fully removed. While a binding exists, every local administrator sees the
 * same owner; a different administrator must disconnect it and bind again.
 */
export function assertCloudOwnerChangeAllowed(input: {
  bindingStatus: CloudBindingStatus;
  currentOwnerUserId: string | undefined;
  nextOwnerUserId: string;
}) {
  if (input.bindingStatus === "unbound") return;
  if (input.currentOwnerUserId === input.nextOwnerUserId) return;
  throw Object.assign(new Error("Disconnect the existing Cloud binding before another administrator binds it."), {
    code: "CLOUD_BINDING_OWNER_CONFLICT",
    statusCode: 409,
  });
}
