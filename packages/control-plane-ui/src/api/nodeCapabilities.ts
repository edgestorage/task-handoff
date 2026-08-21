import { supportsNodeLocalFolderNameUpdate } from "@task-handoff/protocol/control-plane";
import type { Node } from "./types";

function nodeAgentCapabilities(node: Pick<Node, "capabilities"> | undefined) {
  const agent = node?.capabilities?.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return undefined;
  return (agent as { capabilities?: unknown }).capabilities;
}

export function nodeSupportsLocalFolderNameUpdate(node: Pick<Node, "capabilities"> | undefined) {
  return supportsNodeLocalFolderNameUpdate(nodeAgentCapabilities(node));
}
