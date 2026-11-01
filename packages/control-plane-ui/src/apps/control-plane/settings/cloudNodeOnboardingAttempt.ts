import { computed, ref } from "vue";
import type { CloudAccountNodes, CloudNodeBindingToken, CloudNodeRelayTrust } from "../../../api/types";

export type CloudNodeOnboardingSource = "existing" | "new";
export type CloudNodeOnboardingPhase =
  | "submitting"
  | "waiting-node-trust"
  | "approved-connecting"
  | "complete"
  | "rejected"
  | "expired"
  | "failed";

export type CloudNodeOnboardingAttempt = {
  id: number;
  source: CloudNodeOnboardingSource;
  phase: CloudNodeOnboardingPhase;
  displayName: string;
  nodeHandle?: string;
  nodeId?: string;
  token?: CloudNodeBindingToken;
  trust?: CloudNodeRelayTrust;
  error?: string;
  ignoredTrustRequestId?: string;
  reapplyDeadlineAt?: string;
  startedAt: string;
  updatedAt: string;
};

const attempt = ref<CloudNodeOnboardingAttempt>();
let nextId = 1;

function terminal(phase: CloudNodeOnboardingPhase | undefined) {
  return phase === "complete" || phase === "rejected" || phase === "expired";
}

function update(patch: Partial<CloudNodeOnboardingAttempt>) {
  if (!attempt.value) return;
  attempt.value = {
    ...attempt.value,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export function beginCloudNodeOnboarding(source: CloudNodeOnboardingSource, displayName = "") {
  if (attempt.value && !terminal(attempt.value.phase)) return attempt.value;
  const timestamp = new Date().toISOString();
  attempt.value = {
    id: nextId++,
    source,
    phase: "submitting",
    displayName,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
  return attempt.value;
}

export function setCloudNodeOnboardingToken(token: CloudNodeBindingToken) {
  if (!attempt.value) beginCloudNodeOnboarding("new");
  update({ token, phase: "submitting", error: undefined });
}

export function setCloudNodeOnboardingNodeHandle(nodeHandle: string) {
  update({ nodeHandle });
}

export function completeCloudNodeOnboarding(node: { id: string; name?: string }) {
  update({ phase: "complete", nodeId: node.id, displayName: node.name || attempt.value?.displayName || "", error: undefined, reapplyDeadlineAt: undefined });
}

export function failCloudNodeOnboarding(error: string) {
  update({ phase: "failed", error, reapplyDeadlineAt: undefined });
}

export function resumeCloudNodeOnboarding() {
  update({ phase: "submitting", trust: undefined, error: undefined, ignoredTrustRequestId: undefined, reapplyDeadlineAt: undefined });
}

export function reapplyCloudNodeOnboarding(now = Date.now(), timeoutMs = 30_000) {
  update({
    phase: "submitting",
    trust: undefined,
    error: undefined,
    ignoredTrustRequestId: attempt.value?.trust?.requestId ?? attempt.value?.ignoredTrustRequestId,
    reapplyDeadlineAt: new Date(now + timeoutMs).toISOString(),
  });
}

/** Preserve the retry entry point when a reapply request itself is refused. */
export function rejectCloudNodeOnboarding(error: string) {
  update({
    phase: "rejected",
    error,
    reapplyDeadlineAt: undefined,
    trust: undefined,
    ignoredTrustRequestId: attempt.value?.ignoredTrustRequestId ?? attempt.value?.trust?.requestId,
  });
}

/** A queued instruction is not a delivered one; never leave the UI submitting forever. */
export function expireCloudNodeReapplyWait(now: number, error: string) {
  if (!attempt.value || attempt.value.phase !== "submitting" || !attempt.value.reapplyDeadlineAt) return false;
  if (Date.parse(attempt.value.reapplyDeadlineAt) > now) return false;
  update({
    phase: "rejected",
    error,
    reapplyDeadlineAt: undefined,
    trust: undefined,
    ignoredTrustRequestId: attempt.value.ignoredTrustRequestId ?? attempt.value.trust?.requestId,
  });
  return true;
}

export function resetCloudNodeOnboarding() {
  attempt.value = undefined;
}

/**
 * Applies the authoritative cloud-relay snapshot to this onboarding attempt.
 * A trust outcome is only explanatory; completion still requires a connected channel.
 */
export function syncCloudNodeOnboarding(snapshot: CloudAccountNodes | undefined, queryError?: string) {
  if (!attempt.value || terminal(attempt.value.phase)) return attempt.value;
  if (queryError) {
    if (attempt.value.trust?.state === "pending") update({ error: queryError });
    else failCloudNodeOnboarding(queryError);
    return attempt.value;
  }
  if (!snapshot) return attempt.value;
  const relay = snapshot.nodeRelay;
  const hint = attempt.value.token
    ? relay.onboarding.find((item) => item.tokenId === attempt.value?.token?.tokenId)
    : undefined;
  const nodeHandle = attempt.value.nodeHandle || hint?.nodeHandle;
  if (nodeHandle && nodeHandle !== attempt.value.nodeHandle) update({ nodeHandle });
  if (!nodeHandle) return attempt.value;
  const channel = relay.channels.find((item) => item.nodeHandle === nodeHandle && item.connected);
  if (channel) {
    update({ phase: "complete", nodeId: channel.nodeId, error: undefined, trust: undefined, reapplyDeadlineAt: undefined });
    return attempt.value;
  }
  const candidates = relay.trust.filter((item) => item.nodeHandle === nodeHandle);
  const channelError = relay.errors.find((item) => item.nodeHandle === nodeHandle);
  const claim = relay.claims.find((item) => item.nodeHandle === nodeHandle);
  const trust = attempt.value.trust?.requestId
    ? candidates.find((item) => item.requestId === attempt.value?.trust?.requestId)
      || candidates.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0]
    : candidates.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
  if (!trust && !claim) {
    if (channelError) {
      update({ phase: "failed", trust, error: channelError.message });
      return attempt.value;
    }
    if (attempt.value.phase === "waiting-node-trust" || attempt.value.phase === "approved-connecting") {
      // A revoked or cancelled join drops the trust request and the claim in the
      // same snapshot. Without the claim there is no evidence that the node
      // approved anything, so the attempt must end instead of claiming it is
      // connecting.
      resetCloudNodeOnboarding();
      return undefined;
    }
    return attempt.value;
  }
  if (trust) {
    // Reapply always creates a new request ID. Ignore only the exact terminal
    // request that was replaced; wall-clock comparison is unsafe across hosts.
    if (attempt.value.ignoredTrustRequestId === trust.requestId && (trust.state === "rejected" || trust.state === "expired")) {
      return attempt.value;
    }
    if (attempt.value.ignoredTrustRequestId) update({ ignoredTrustRequestId: undefined });
    if (trust.state === "rejected") update({ phase: "rejected", trust, error: undefined });
    else if (trust.state === "expired") update({ phase: "expired", trust, error: undefined });
    else update({ phase: "waiting-node-trust", trust, error: channelError?.message, reapplyDeadlineAt: undefined });
    return attempt.value;
  }
  if (claim && (attempt.value.phase === "waiting-node-trust" || attempt.value.phase === "approved-connecting")) {
    // A surviving claim is the authoritative signal that the Control Plane has
    // requested the channel; the trust entry disappears only once it is used.
    update({ phase: "approved-connecting", trust: undefined, error: undefined, reapplyDeadlineAt: undefined });
    return attempt.value;
  }
  return attempt.value;
}

export function useCloudNodeOnboardingAttempt() {
  return {
    attempt,
    active: computed(() => Boolean(attempt.value && !terminal(attempt.value.phase))),
    terminal: computed(() => Boolean(attempt.value && terminal(attempt.value.phase))),
    waitingForTrust: computed(() => attempt.value?.phase === "waiting-node-trust"),
  };
}
