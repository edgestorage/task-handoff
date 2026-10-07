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
  return instance.status !== "running" || isInstanceRuntimeUpdating(instance) || isInstanceRuntimeUnavailable(instance);
}

export function isInstanceStatusPending(instance: InstanceBoardItem) {
  // An unavailable base runtime is an external condition, not work in progress:
  // the instance waits on the runtime instead of retrying, so no spinner.
  if (isInstanceRuntimeUnavailable(instance)) return false;
  return isInstanceRuntimeUpdating(instance)
    || ["provisioning", "starting", "registering", "registered", "stopping"].includes(instance.status);
}

/**
 * Compact in-progress copy for row surfaces such as the instance list.
 * Settled states return undefined so rows keep their regular presentation.
 */
export function instancePendingStatusLabel(instance: InstanceBoardItem, t: Translate) {
  return isInstanceStatusPending(instance) ? instanceStatusTitle(instance, t) : undefined;
}

export function isInstanceRuntimeUpdating(instance: InstanceBoardItem) {
  return ["draining", "installing", "restarting", "verifying"].includes(instance.runtimeVersion?.phase || "");
}

/**
 * The node runtime record is the authoritative source for base runtime
 * availability. Instances must not reinterpret it from their own failures.
 */
export function isInstanceRuntimeOffline(instance: InstanceBoardItem) {
  return instance.runtime?.status === "offline";
}

/** True when the offline base runtime is what keeps this instance from running. */
export function isInstanceRuntimeUnavailable(instance: InstanceBoardItem) {
  if (instance.status === "stopped" || instance.status === "stopping") return false;
  return isInstanceRuntimeOffline(instance);
}

export function instanceRuntimeUnavailableReason(instance: InstanceBoardItem) {
  const daemon = (instance.runtime?.capabilities as Record<string, unknown> | undefined)?.daemon;
  if (!daemon || typeof daemon !== "object") return undefined;
  const error = (daemon as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() ? error : undefined;
}

export function instanceRuntimeUnavailableLabel(instance: InstanceBoardItem, t: Translate) {
  const type = instance.runtime?.type;
  if (type === "docker") return t("instances.lifecycle.runtimeUnavailableDocker");
  if (type === "local") return t("instances.lifecycle.runtimeUnavailableLocal");
  return t("instances.lifecycle.runtimeUnavailable");
}

/** Short localized runtime name so availability copy never echoes node-owned identifiers. */
export function instanceRuntimeNameLabel(instance: InstanceBoardItem, t: Translate) {
  const type = instance.runtime?.type;
  if (type === "docker") return t("instances.lifecycle.runtimeNameDocker");
  if (type === "local") return t("instances.lifecycle.runtimeNameLocal");
  return instance.runtime?.name || t("instances.lifecycle.runtimeUnavailable");
}

export function isInstanceAppReady(instance: InstanceBoardItem) {
  return instance.connectionStatus === "online" || instance.access.status === "reachable";
}

export function canShowInstanceAction(instance: InstanceBoardItem, action: InstanceAction) {
  if (action === "delete") {
    return true;
  }
  // Runtime lifecycle actions need the base runtime; only surface them when it
  // is present, otherwise the user gets an error instead of a working control.
  if (isInstanceRuntimeOffline(instance)) return false;
  if (action === "retry-image") {
    return instance.status === "failed" && instance.imageProvisioning?.phase === "failed";
  }
  if (action === "retry-git") {
    return instance.status === "failed" && instance.workspace.gitProvisioning?.phase === "failed";
  }
  if (action === "start") {
    return !isInstanceRunning(instance) && !["provisioning", "starting", "registering", "registered", "stopping"].includes(instance.status);
  }
  if (action === "stop") {
    return !["failed", "stopped", "stopping", "unhealthy"].includes(instance.status) && (isInstanceRunning(instance) || isInstanceConnecting(instance));
  }
  return isInstanceRunning(instance);
}

/**
 * Provisioning retries share one user-facing action: whichever preparation step
 * failed owns the retry, so surfaces render a single button.
 */
export function instanceProvisioningRetryAction(instance: InstanceBoardItem): "retry-image" | "retry-git" | undefined {
  if (instance.status !== "failed") return undefined;
  if (instance.workspace.gitProvisioning?.phase === "failed") return "retry-git";
  if (instance.imageProvisioning?.phase === "failed") return "retry-image";
  return undefined;
}

export function instanceProvisioningRetryLabel(instance: InstanceBoardItem, t: Translate) {
  return instanceProvisioningRetryAction(instance) === "retry-git"
    ? t("instances.actions.retryGit")
    : t("instances.actions.retryImage");
}

export function instanceStatusTitle(instance: InstanceBoardItem, t: Translate) {
  if (isInstanceRuntimeUnavailable(instance)) return instanceRuntimeUnavailableLabel(instance, t);
  if (isInstanceRuntimeUpdating(instance)) return t("instances.lifecycle.updatingRuntime");
  if (instance.status !== "stopping" && instance.status !== "stopped") {
    const imagePhase = instance.imageProvisioning?.phase;
    if (["checking-image", "pulling-image", "resolving-image"].includes(imagePhase || "")) return t("instances.lifecycle.preparing");
    if (imagePhase === "failed") return t("instances.lifecycle.imageFailed");
    const gitPhase = instance.workspace.gitProvisioning?.phase;
    if (gitPhase && ["pending", "cloning", "checking-out", "submodules", "lfs", "finalizing"].includes(gitPhase)) return t("instances.lifecycle.preparingWorkspace");
    if (gitPhase === "failed") return t("instances.lifecycle.workspaceFailed");
  }
  if (instance.status === "created") return t("instances.lifecycle.created");
  if (instance.status === "provisioning") return t("instances.lifecycle.preparingRuntime");
  if (instance.status === "starting") return t("instances.lifecycle.starting");
  if (instance.status === "registering" || instance.status === "registered") return t("instances.lifecycle.connecting");
  if (instance.status === "stopping") return t("instances.lifecycle.stopping");
  if (instance.status === "stopped") return t("instances.lifecycle.stopped");
  if (instance.status === "failed") return t("instances.lifecycle.failed");
  if (instance.status === "unhealthy") return t("instances.lifecycle.unhealthy");
  return t("instances.lifecycle.starting");
}

export function instanceStatusDetail(instance: InstanceBoardItem, t: Translate) {
  if (isInstanceRuntimeUnavailable(instance)) {
    const runtime = instanceRuntimeNameLabel(instance, t);
    const reason = instanceRuntimeUnavailableReason(instance);
    return reason
      ? t("instances.lifecycle.runtimeUnavailableReason", { runtime, reason })
      : t("instances.lifecycle.runtimeUnavailableDetail", { runtime });
  }
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
    const gitPhase = instance.workspace.gitProvisioning?.phase;
    if (gitPhase === "pending" || gitPhase === "cloning") return t("instances.lifecycle.cloningRepositoryDetail");
    if (gitPhase === "checking-out") return t("instances.lifecycle.checkingOutDetail");
    if (gitPhase === "submodules") return t("instances.lifecycle.submodulesDetail");
    if (gitPhase === "lfs") return t("instances.lifecycle.lfsDetail");
    if (gitPhase === "finalizing") return t("instances.lifecycle.finalizingWorkspaceDetail");
  }
  if (instance.status === "created") return t("instances.lifecycle.readyToStart");
  if (instance.status === "failed" && instance.imageProvisioning?.error) return instance.imageProvisioning.error;
  if (instance.status === "failed" && instance.workspace.gitProvisioning?.error) return instance.workspace.gitProvisioning.error;
  // Start failures are recorded on the workspace by the node agent, so a failed
  // instance that never reached Git provisioning still shows its real reason.
  if (instance.status === "failed" && instance.workspace.error) return instance.workspace.error;
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

/** Fallback copy for the workspace preparation page before live progress arrives. */
export function gitProvisioningLabel(instance: InstanceBoardItem, t: Translate) {
  const provisioning = instance.workspace.gitProvisioning;
  if (!provisioning) return "";
  if (provisioning.phase === "ready") return t("instances.lifecycle.workspaceReady");
  if (provisioning.phase === "failed") return t("instances.lifecycle.workspaceFailed");
  return t("instances.lifecycle.preparingWorkspace");
}

export function showGitPreparation(instance: InstanceBoardItem) {
  const phase = instance.workspace.gitProvisioning?.phase;
  return Boolean(phase && phase !== "ready");
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
