import type { AppManagementJob, AppManagementSnapshot } from "../../../api/types";

export function appTaskGroups(snapshot: AppManagementSnapshot) {
  return {
    active: [...snapshot.activeJobs].sort((a, b) =>
      Number(b.state === "running") - Number(a.state === "running")
      || a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id)),
    recent: [...snapshot.recentJobs].sort((a, b) =>
      (b.finishedAt || b.updatedAt).localeCompare(a.finishedAt || a.updatedAt) || a.id.localeCompare(b.id)),
  };
}

export function appTaskProgress(job?: AppManagementJob) {
  const { current, total } = job?.progress || {};
  if (current === undefined || !total) return undefined;
  return Math.max(0, Math.min(100, current / total * 100));
}

export function appTaskStatusKey(job: AppManagementJob) {
  if (job.state === "queued") return "instances.settings.queued";
  if (job.state === "running") return `instances.settings.${{
    install: "installing", update: "updating", uninstall: "uninstalling",
  }[job.operation]}`;
  return `instances.settings.${job.state}`;
}

export function retryableAppTask(snapshot: AppManagementSnapshot, job: AppManagementJob) {
  if ((job.state !== "failed" && job.state !== "interrupted") || !job.error?.retryable) return undefined;
  if (snapshot.activeJobs.some((active) => active.appId === job.appId)) return undefined;
  const app = snapshot.apps.find((candidate) => candidate.id === job.appId);
  const allowed = job.operation === "install" ? app?.canInstall
    : job.operation === "update" ? app?.canUpdate : app?.canUninstall;
  return allowed ? app : undefined;
}
