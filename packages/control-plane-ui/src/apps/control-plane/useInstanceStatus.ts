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
  return ["provisioning", "starting", "registering", "registered"].includes(instance.status);
}

export function hasInstanceStatusPage(instance: InstanceBoardItem) {
  return instance.status !== "running";
}

export function isInstanceStatusPending(instance: InstanceBoardItem) {
  return ["provisioning", "starting", "registering", "registered", "stopping"].includes(instance.status);
}

export function isInstanceAppReady(instance: InstanceBoardItem) {
  return instance.connectionStatus === "online" || instance.access.status === "reachable";
}

export function canShowInstanceAction(instance: InstanceBoardItem, action: InstanceAction) {
  if (action === "delete") {
    return true;
  }
  if (action === "retry-image") {
    return instance.status === "failed" && instance.imageProvisioning?.phase === "failed";
  }
  if (action === "start") {
    return !isInstanceRunning(instance) && !["provisioning", "starting", "registering", "registered", "stopping"].includes(instance.status);
  }
  if (action === "stop") {
    return !["failed", "stopped", "stopping", "unhealthy"].includes(instance.status) && (isInstanceRunning(instance) || isInstanceConnecting(instance));
  }
  return isInstanceRunning(instance);
}

export function instanceStatusTitle(instance: InstanceBoardItem) {
  if (instance.status === "created") return "Instance created";
  if (instance.status === "provisioning") return "Preparing runtime";
  if (instance.status === "starting") return "Starting container";
  if (instance.status === "registering" || instance.status === "registered") return "Connecting instance";
  if (instance.status === "stopping") return "Stopping instance";
  if (instance.status === "stopped") return "Instance stopped";
  if (instance.status === "failed") return "Instance failed";
  if (instance.status === "unhealthy") return "Instance unhealthy";
  return "Starting instance";
}

export function instanceStatusDetail(instance: InstanceBoardItem) {
  if (instance.status === "created") return "The instance is ready to start.";
  if (instance.status === "failed" && instance.imageProvisioning?.error) return instance.imageProvisioning.error;
  if (instance.status === "failed") return "The instance could not be started. Retry the failed operation or inspect its runtime.";
  if (instance.status === "stopped") return "The instance is stopped. Start it when you are ready to continue.";
  if (instance.status === "unhealthy") return `The instance health check is ${instance.health}. Restart the instance or inspect its runtime.`;
  if (instance.status === "stopping") return "Waiting for the instance runtime to stop safely.";
  return `Waiting for the controlled instance to connect · ${instance.status} · ${instance.connectionStatus}`;
}

export function imageProvisioningLabel(instance: InstanceBoardItem) {
  const phase = instance.imageProvisioning?.phase;
  if (phase === "checking-image") return "Checking image";
  if (phase === "pulling-image") return "Pulling image";
  if (phase === "resolving-image") return "Resolving image digest";
  if (phase === "failed") return "Image provisioning failed";
  return phase === "ready" ? "Image ready" : "";
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
