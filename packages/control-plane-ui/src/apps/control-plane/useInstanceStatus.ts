import type { InstanceBoardItem } from "../../api/types";
import type { InstanceAction } from "./useInstanceActions";

export function instanceDisplayName(instance: InstanceBoardItem, duplicateNames: Set<string>) {
  return duplicateNames.has(instance.name) ? `${instance.name} · ${shortId(instance.id)}` : instance.name;
}

export function isInstanceConnecting(instance: InstanceBoardItem) {
  if (["failed", "stopped", "stopping", "unhealthy"].includes(instance.status)) {
    return false;
  }
  if (instance.connectionStatus === "online") {
    return false;
  }
  return ["created", "provisioning", "starting", "registering", "registered"].includes(instance.status) || instance.connectionStatus === "unknown";
}

export function isInstanceAppReady(instance: InstanceBoardItem) {
  return instance.connectionStatus === "online" || instance.access.status === "reachable";
}

export function canShowInstanceAction(instance: InstanceBoardItem, action: InstanceAction) {
  if (action === "delete") {
    return true;
  }
  if (action === "start") {
    return !isInstanceRunning(instance) && !["provisioning", "starting", "registering", "registered", "stopping"].includes(instance.status);
  }
  if (action === "stop") {
    return !["failed", "stopped", "stopping", "unhealthy"].includes(instance.status) && (isInstanceRunning(instance) || isInstanceConnecting(instance));
  }
  return isInstanceRunning(instance);
}

export function instanceConnectionTitle(instance?: InstanceBoardItem) {
  if (!instance) {
    return "Starting instance";
  }
  if (instance.status === "provisioning") {
    return "Preparing runtime";
  }
  if (instance.status === "starting") {
    return "Starting container";
  }
  if (instance.status === "registering" || instance.status === "registered") {
    return "Connecting instance";
  }
  return "Starting instance";
}

export function instanceConnectionDetail(instance?: InstanceBoardItem) {
  if (!instance) {
    return "Waiting for the controlled instance to connect...";
  }
  return `Waiting for the controlled instance to connect · ${instance.status} · ${instance.connectionStatus}`;
}

export function shortId(id: string) {
  return id.replace(/^inst_?/, "").slice(0, 6) || id.slice(0, 6);
}

export function projectSourceLabel(project: { source: { type: string; path?: string; url?: string } }) {
  return project.source.type === "local-folder" ? project.source.path || "local folder" : project.source.url || project.source.type;
}

export function instanceSourceLabel(instance: InstanceBoardItem) {
  if (instance.project?.name || instance.projectId) {
    return instance.project?.name || instance.projectId || "Source";
  }
  if (instance.source.type === "local-folder") {
    return typeof instance.sourceSnapshot.name === "string" ? instance.sourceSnapshot.name : instance.source.path || "Local folder";
  }
  return instance.source.url || instance.source.type;
}

function isInstanceRunning(instance: InstanceBoardItem) {
  return instance.status === "running" || instance.connectionStatus === "online" || instance.access.status === "reachable";
}
