import { CLOUD_RELAY_CLAIM_DISABLED_LABEL } from "@task-handoff/protocol/control-plane";
import type { CloudNodeRelayState, CloudNodeRelayTrust, Node } from "../../../api/types";
import type { CloudNodeOnboardingPhase } from "./cloudNodeOnboardingAttempt";

/** Trust belongs to the node's signed outcome, independently of transport diagnostics. */
export function cloudNodeTrustForNode(node: Node | undefined, relay: CloudNodeRelayState | undefined) {
  if (!node || node.connectionPath?.kind !== "cloud-relay" || node.connectionEnabled === false
    || node.labels[CLOUD_RELAY_CLAIM_DISABLED_LABEL] === "true") return undefined;
  const nodeHandle = node.connectionPath.nodeHandle;
  if (relay?.channels.some((channel) => channel.nodeHandle === nodeHandle && channel.nodeId === node.id && channel.connected)) return undefined;
  return relay?.trust.find((trust) => trust.nodeHandle === nodeHandle && trust.nodeId === node.id);
}

export function cloudNodeTrustPhase(trust: CloudNodeRelayTrust): CloudNodeOnboardingPhase {
  return trust.state === "pending" ? "waiting-node-trust" : trust.state;
}
