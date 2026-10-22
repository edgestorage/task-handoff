import type { Node } from "@task-handoff/protocol/control-plane";
import { StorySchema, type Story } from "@task-handoff/protocol/stories";
import type { ControlPlaneService } from "../application/service.ts";
import { nodeJson } from "./node-agent-request.ts";

/**
 * A Node Agent reports its own machine identity. Cloud Relay inserts a
 * Control Plane-local node record, so Story ownership must be projected at the
 * Control Plane boundary just like instance, folder and runtime node IDs.
 */
export function projectNodeAgentStory(node: Node, input: unknown): Story {
  const story = StorySchema.parse(input);
  return node.connectionPath?.kind === "cloud-relay" && story.ownerNodeId !== node.id
    ? StorySchema.parse({ ...story, ownerNodeId: node.id })
    : story;
}

export async function nodeStoryJson(
  service: ControlPlaneService,
  nodeId: string,
  route: string,
  init: RequestInit = {},
) {
  const node = service.requireNode(nodeId);
  return projectNodeAgentStory(node, await nodeJson(service, nodeId, route, init));
}
