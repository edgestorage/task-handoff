import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlledInstance,
  type ImageProfile,
  type Node,
  type NodeRuntime,
  type Project,
} from "@task-handoff/protocol/control-plane";
import { aiSessionsBoardSummary } from "@task-handoff/protocol/ai-sessions";
import { publicInstanceWithAccess, publicNode } from "../public-records.ts";
import type { NodeAgentScopedError } from "../nodes/client.ts";

export type InstanceBoardReaderInput = {
  projects: Project[];
  images: ImageProfile[];
  nodes: Node[];
  runtimes: NodeRuntime[];
  instances: ControlledInstance[];
  nodeErrors?: NodeAgentScopedError[];
};

export type InstanceBoardResult = {
  items: ReturnType<typeof boardInstance>[];
  nodeErrors: NodeAgentScopedError[];
};

export class InstanceBoardReader {
  read(input: InstanceBoardReaderInput): InstanceBoardResult {
    const projects = new Map(input.projects.map((project) => [project.id, project]));
    const images = new Map(input.images.map((image) => [image.id, image]));
    const nodes = new Map(input.nodes.map((node) => [node.id, node]));
    const runtimes = new Map(input.runtimes.map((runtime) => [`${runtime.nodeId}:${runtime.id}`, runtime]));
    const currentTime = Date.now();
    return {
      items: input.instances.map((instance) => boardInstance({
        instance,
        currentTime,
        project: instance.projectId ? projects.get(instance.projectId) : undefined,
        image: instance.imageId ? images.get(instance.imageId) || instance.imageSnapshot : instance.imageSnapshot,
        node: nodes.get(instance.nodeId),
        runtime: runtimes.get(`${instance.nodeId}:${instance.runtimeId}`),
      })),
      nodeErrors: input.nodeErrors || [],
    };
  }
}

function boardInstance(input: {
  instance: ControlledInstance;
  currentTime: number;
  project?: Project;
  image?: ImageProfile;
  node?: Node;
  runtime?: NodeRuntime;
}) {
  const heartbeatAgeMs = input.instance.lastHeartbeatAt ? input.currentTime - Date.parse(input.instance.lastHeartbeatAt) : undefined;
  const connectionStatus = heartbeatAgeMs !== undefined && heartbeatAgeMs > 30_000 ? "offline" : input.instance.connectionStatus;
  const item = publicInstanceWithAccess(input.instance);
  return {
    ...item,
    aiSessions: aiSessionsBoardSummary(item.aiSessions),
    connectionStatus,
    heartbeatAgeMs,
    project: input.project,
    image: input.image,
    node: input.node ? publicNode(input.node) : undefined,
    runtime: input.runtime,
    protocolCompatible: !input.instance.protocolVersion || input.instance.protocolVersion === CONTROL_PLANE_PROTOCOL_VERSION,
  };
}
