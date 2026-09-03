import type { AiSessionSummary, InstanceBoardItem } from "../../api/types";

export type AiSessionStoryTarget = {
  nodeId: string;
  nodeName?: string;
  instanceId: string;
  sessionId: string;
  storyId?: string | null;
};

export function aiSessionStoryTarget(
  instance: Pick<InstanceBoardItem, "id" | "nodeId" | "node">,
  session: Pick<AiSessionSummary, "id" | "storyId">,
  nodeName?: string,
): AiSessionStoryTarget | undefined {
  if (!instance.nodeId) return undefined;
  return {
    nodeId: instance.nodeId,
    nodeName: instance.node?.name || nodeName,
    instanceId: instance.id,
    sessionId: session.id,
    storyId: session.storyId ?? null,
  };
}

export function storyTargetNodeLabel(target: Pick<AiSessionStoryTarget, "nodeName"> | undefined, ownerNodeId: string) {
  return target?.nodeName || ownerNodeId;
}
