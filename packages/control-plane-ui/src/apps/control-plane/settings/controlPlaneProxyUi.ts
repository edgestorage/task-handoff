import type { Node } from "../../../api/types";

export function normalizeProxyOrigin(input: string) {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("INVALID_PROXY_ORIGIN");
  }
  return url.origin;
}

export function proxyClaimValidation(input: { proxyOrigin: string; inviteToken: string; trusted: boolean }) {
  try {
    normalizeProxyOrigin(input.proxyOrigin);
  } catch {
    return "origin" as const;
  }
  if (input.inviteToken.trim().length < 24) return "token" as const;
  if (!input.trusted) return "trust" as const;
  return undefined;
}

export function proxyForceDeleteAllowed(node: Node, error: unknown) {
  if (node.connectionMode !== "control-plane-proxy" || !error || typeof error !== "object" || !("details" in error)) return false;
  const details = error.details;
  return Boolean(details && typeof details === "object" && !Array.isArray(details)
    && "forceDeleteAllowed" in details
    && details.forceDeleteAllowed === true);
}

export function proxyPathState(node: Node) {
  const state = node.proxyState;
  return {
    source: "ready" as const,
    proxy: state?.reachability || "unknown",
    binding: state?.bindingStatus || "unknown",
    target: state?.target,
    reason: state?.lastError,
    bindingRevision: state?.bindingRevision,
    revision: state?.revision,
    observedAt: state?.observedAt,
  };
}
