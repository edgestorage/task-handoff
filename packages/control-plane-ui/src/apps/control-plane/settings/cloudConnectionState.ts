export type CloudConnectionStatus = "unbound" | "pending-claim" | "active" | "pending-revocation" | "clone-conflict";

export type CloudConnectionStage =
  | "signed-out"
  | "awaiting-sign-in"
  | "signed-in-unbound"
  | "awaiting-binding"
  | "active"
  | "revoking"
  | "conflict";

export type CloudLoginIntent = "sign-in" | "bind";

export function resolveCloudConnectionStage(input: {
  status?: CloudConnectionStatus;
  signedIn: boolean;
  pendingScope?: string;
}): CloudConnectionStage {
  if (input.status === "clone-conflict") return "conflict";
  if (input.status === "pending-revocation") return "revoking";
  if (input.status === "active") return "active";
  if (input.pendingScope === "account:sign-in") return "awaiting-sign-in";
  if (input.pendingScope === "control-plane:bind") return "awaiting-binding";
  if (input.signedIn) return "signed-in-unbound";
  return "signed-out";
}
