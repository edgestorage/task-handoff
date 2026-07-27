import type { InstanceBoardItem } from "../../api/types";
import type { InstanceAction } from "./useInstanceActions";
import { connectionStatusKeys, healthStatusKeys, imagePullStatusKeys, instanceStatusKeys, translateStatus, type Translate } from "../../i18n/status.ts";

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
  return instance.status !== "running" || isInstanceRuntimeUpdating(instance);
}

export function isInstanceStatusPending(instance: InstanceBoardItem) {
  return isInstanceRuntimeUpdating(instance)
    || ["provisioning", "starting", "registering", "registered", "stopping"].includes(instance.status);
}

export function isInstanceRuntimeUpdating(instance: InstanceBoardItem) {
  return ["draining", "installing", "restarting", "verifying"].includes(instance.runtimeVersion?.phase || "");
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

export function instanceStatusTitle(instance: InstanceBoardItem, t: Translate) {
  if (isInstanceRuntimeUpdating(instance)) return t("instances.lifecycle.updatingRuntime");
  if (instance.status !== "stopping" && instance.status !== "stopped") {
    const imagePhase = instance.imageProvisioning?.phase;
    if (["checking-image", "pulling-image", "resolving-image"].includes(imagePhase || "")) return t("instances.lifecycle.preparing");
    if (imagePhase === "failed") return t("instances.lifecycle.imageFailed");
  }
  if (instance.status === "created") return t("instances.lifecycle.created");
  if (instance.status === "provisioning") return t("instances.lifecycle.preparingRuntime");
  if (instance.status === "starting") return t("instances.lifecycle.startingContainer");
  if (instance.status === "registering" || instance.status === "registered") return t("instances.lifecycle.connecting");
  if (instance.status === "stopping") return t("instances.lifecycle.stopping");
  if (instance.status === "stopped") return t("instances.lifecycle.stopped");
  if (instance.status === "failed") return t("instances.lifecycle.failed");
  if (instance.status === "unhealthy") return t("instances.lifecycle.unhealthy");
  return t("instances.lifecycle.starting");
}

export function instanceStatusDetail(instance: InstanceBoardItem, t: Translate) {
  const runtimePhase = instance.runtimeVersion?.phase;
  if (runtimePhase === "draining") return t("instances.lifecycle.runtimeDrainingDetail");
  if (runtimePhase === "installing") return t("instances.lifecycle.runtimeInstallingDetail");
  if (runtimePhase === "restarting") return t("instances.lifecycle.runtimeRestartingDetail");
  if (runtimePhase === "verifying") return t("instances.lifecycle.runtimeVerifyingDetail");
  if (instance.status !== "stopping" && instance.status !== "stopped") {
    const imagePhase = instance.imageProvisioning?.phase;
    if (imagePhase === "checking-image") return t("instances.lifecycle.checkingImageDetail");
    if (imagePhase === "pulling-image") return t("instances.lifecycle.pullingImageDetail");
    if (imagePhase === "resolving-image") return t("instances.lifecycle.resolvingImageDetail");
  }
  if (instance.status === "created") return t("instances.lifecycle.readyToStart");
  if (instance.status === "failed" && instance.imageProvisioning?.error) return instance.imageProvisioning.error;
  if (instance.status === "failed") return t("instances.lifecycle.failedDetail");
  if (instance.status === "stopped") return t("instances.lifecycle.stoppedDetail");
  if (instance.status === "unhealthy") return t("instances.lifecycle.unhealthyDetail", { health: translateStatus(healthStatusKeys, instance.health, t) });
  if (instance.status === "stopping") return t("instances.lifecycle.stoppingDetail");
  return t("instances.lifecycle.waitingDetail", {
    status: translateStatus(instanceStatusKeys, instance.status, t),
    connection: translateStatus(connectionStatusKeys, instance.connectionStatus, t),
  });
}

export function imageProvisioningLabel(instance: InstanceBoardItem, t: Translate) {
  const phase = instance.imageProvisioning?.phase;
  const progress = instance.imagePullProgress;
  if (phase === "checking-image") return t("instances.lifecycle.checkingImage");
  if (phase === "pulling-image") {
    if (!progress) return t("instances.lifecycle.pullingImage");
    const status = translateStatus(imagePullStatusKeys, progress.status, t);
    const layerSummary = progress.layers.total
      ? t("instances.imagePull.layersReady", { completed: progress.layers.completed, total: progress.layers.total })
      : t("instances.imagePull.waitingForLayers");
    return `${status} · ${layerSummary}${progress.percent === undefined ? "" : ` · ${Math.round(progress.percent)}%`}`;
  }
  if (phase === "resolving-image") return t("instances.lifecycle.resolvingDigest");
  if (phase === "failed") return t("instances.lifecycle.imageProvisionFailed");
  return phase === "ready" ? t("instances.lifecycle.imageReady") : "";
}

export function shortId(id: string) {
  return id.replace(/^inst_?/, "").slice(0, 6) || id.slice(0, 6);
}

export function projectSourceLabel(project: { source: { type: string; path?: string; url?: string } }, t: Translate) {
  return project.source.type === "local-folder" ? project.source.path || t("instances.lifecycle.localFolderLower") : project.source.url || project.source.type;
}

export function instanceSourceLabel(instance: InstanceBoardItem, t: Translate) {
  if (instance.project?.name || instance.projectId) {
    return instance.project?.name || instance.projectId || t("instances.lifecycle.source");
  }
  if (instance.source.type === "local-folder") {
    return typeof instance.sourceSnapshot.name === "string" ? instance.sourceSnapshot.name : instance.source.path || t("instances.lifecycle.localFolder");
  }
  return instance.source.url || instance.source.type;
}

function isInstanceRunning(instance: InstanceBoardItem) {
  return instance.status === "running" || instance.connectionStatus === "online" || instance.access.status === "reachable";
}
