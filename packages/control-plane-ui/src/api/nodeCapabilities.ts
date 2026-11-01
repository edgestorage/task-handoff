import { supportsNodeControlPlaneTrust, supportsNodeLocalFolderNameUpdate, supportsNodeModelProviderCapabilities, supportsNodeModelRelay, supportsNodeModelRelayImagePruning, supportsNodeModelRelayUnknownModelPolicy, supportsNodeModelRequestMappings } from "@task-handoff/protocol/control-plane";
import type { Node } from "./types";

function nodeAgentCapabilities(node: Pick<Node, "capabilities"> | undefined) {
  const agent = node?.capabilities?.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return undefined;
  return (agent as { capabilities?: unknown }).capabilities;
}

export function nodeSupportsLocalFolderNameUpdate(node: Pick<Node, "capabilities"> | undefined) {
  return supportsNodeLocalFolderNameUpdate(nodeAgentCapabilities(node));
}

export function nodeSupportsControlPlaneTrust(node: Pick<Node, "capabilities"> | undefined) {
  return supportsNodeControlPlaneTrust(nodeAgentCapabilities(node));
}

export function nodeSupportsModelRelay(node: Pick<Node, "capabilities"> | undefined) {
  return supportsNodeModelRelay(nodeAgentCapabilities(node));
}

export function nodeSupportsModelRelayUnknownModelPolicy(node: Pick<Node, "capabilities"> | undefined) {
  return supportsNodeModelRelayUnknownModelPolicy(nodeAgentCapabilities(node));
}

export function nodeSupportsModelRelayImagePruning(node: Pick<Node, "capabilities"> | undefined) {
  return supportsNodeModelRelayImagePruning(nodeAgentCapabilities(node));
}

export function nodeSupportsModelRequestMappings(node: Pick<Node, "capabilities"> | undefined) {
  return supportsNodeModelRequestMappings(nodeAgentCapabilities(node));
}

export function nodeSupportsModelProviderCapabilities(node: Pick<Node, "capabilities"> | undefined) {
  return supportsNodeModelProviderCapabilities(nodeAgentCapabilities(node));
}
