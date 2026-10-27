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
  update({ phase: "complete", nodeId: node.id, displayName: node.name || attempt.value?.displayName || "", error: undefined });
}

export function failCloudNodeOnboarding(error: string) {
  update({ phase: "failed", error });
}

export function resumeCloudNodeOnboarding() {
  update({ phase: "submitting", trust: undefined, error: undefined });
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
    failCloudNodeOnboarding(queryError);
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
    update({ phase: "complete", nodeId: channel.nodeId, error: undefined, trust: undefined });
    return attempt.value;
  }
  const candidates = relay.trust.filter((item) => item.nodeHandle === nodeHandle);
  const channelError = relay.errors.find((item) => item.nodeHandle === nodeHandle);
  const trust = attempt.value.trust?.requestId
    ? candidates.find((item) => item.requestId === attempt.value?.trust?.requestId)
      || candidates.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0]
    : candidates.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
  if (channelError && (!trust || channelError.at >= trust.observedAt)) {
    update({ phase: "failed", trust, error: channelError.message });
    return attempt.value;
  }
  if (trust) {
    if (trust.state === "rejected") update({ phase: "rejected", trust, error: undefined });
    else if (trust.state === "expired") update({ phase: "expired", trust, error: undefined });
    else update({ phase: "waiting-node-trust", trust, error: undefined });
    return attempt.value;
  }
  if (attempt.value.phase === "waiting-node-trust" || attempt.value.phase === "approved-connecting") {
    update({ phase: "approved-connecting", trust: undefined, error: undefined });
    return attempt.value;
  }
  if (channelError) {
    update({ phase: "failed", trust: undefined, error: channelError.message });
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
