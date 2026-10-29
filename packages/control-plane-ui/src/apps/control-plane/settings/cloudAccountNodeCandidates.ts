import { CLOUD_ACCOUNT_NODE_HANDLE_LABEL } from "@task-handoff/protocol/control-plane";
import type { CloudAccountNodes, Node } from "../../../api/types";
import { cloudNodeTrustForNode } from "./cloudNodeTrust.ts";

/** Adding a node is distinct from choosing a transport for an existing node. */
export function cloudAccountNodeCandidates(account: CloudAccountNodes | undefined, nodes: readonly Node[]) {
  const managedHandles = new Set<string>();
  for (const node of nodes) {
    // A signed trust outcome is still an unfinished connection. Keep its row
    // available for review until the authoritative channel is connected.
    if (cloudNodeTrustForNode(node, account?.nodeRelay)) continue;
    const linkedHandle = node.labels[CLOUD_ACCOUNT_NODE_HANDLE_LABEL];
    if (linkedHandle) managedHandles.add(linkedHandle);
    if (node.connectionPath.kind === "cloud-relay") managedHandles.add(node.connectionPath.nodeHandle);
  }
  // A channel can arrive before the next nodes snapshot. It is already an
  // authoritative connection and must not become another add action meanwhile.
  for (const channel of account?.nodeRelay.channels ?? []) {
    if (channel.connected) managedHandles.add(channel.nodeHandle);
  }
  return (account?.items ?? []).filter((item) => item.status === "active" && !managedHandles.has(item.nodeHandle));
}
