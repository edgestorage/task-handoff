import type { InstanceBoardItem, Node } from "../../../api/types";

type StoryOwner = { ownerNodeId: string };

export function isStoryOnline(story: StoryOwner, nodes: readonly Node[]) {
  return nodes.some((node) => node.id === story.ownerNodeId && node.status === "online");
}

export function isStorySessionOnline(
  story: StoryOwner,
  nodes: readonly Node[],
  instance: Pick<InstanceBoardItem, "connectionStatus">,
) {
  return isStoryOnline(story, nodes) && instance.connectionStatus === "online";
}
