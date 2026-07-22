import type {
  RepositoryAiSessionLaunchResult,
  RepositoryBranches,
  RepositoryBranchMutationResult,
  RepositoryContext,
  RepositoryChanges,
  RepositoryChangeScope,
  RepositoryDiff,
  RepositoryDirectoryListing,
  RepositoryFileContent,
  RepositoryFileMutationResult,
  RepositoryMutationResult,
  RepositoryCreateWorktreeAiSessionRequest,
  RepositorySessionKind,
  RepositoryStartAiSessionRequest,
  RepositoryRemoveWorktreeResult,
  RepositoryWorktrees,
} from "@task-handoff/protocol/repository";
import { RepositoryWorktreesSchema } from "@task-handoff/protocol/repository";
import { useQuery } from "@tanstack/vue-query";
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { deleteUrlData, getUrlData, postUrlData, putUrlData } from "./client";

export type RepositorySessionTarget = {
  instanceId: string;
  sessionKind: RepositorySessionKind;
  sessionId: string;
};

export function repositoryTargetBasePath(target: RepositorySessionTarget) {
  const sessionCollection = target.sessionKind === "ai-session" ? "ai-sessions" : "apps/sessions";
  return `/instances/${encodeURIComponent(target.instanceId)}/api/${sessionCollection}/${encodeURIComponent(target.sessionId)}/repository`;
}

export function getRepositoryContext(target: RepositorySessionTarget, options?: { signal?: AbortSignal }) {
  return getUrlData<RepositoryContext>(`${repositoryTargetBasePath(target)}/context`, options);
}

export async function getRepositoryWorktrees(target: RepositorySessionTarget, options?: { signal?: AbortSignal }) {
  const data = await getUrlData<unknown>(`${repositoryTargetBasePath(target)}/worktrees`, options);
  const parsed = RepositoryWorktreesSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("The controlled instance returned an incompatible worktree response. Restart the instance to load the current protocol.");
  }
  return parsed.data satisfies RepositoryWorktrees;
}

export function startRepositoryAiSession(
  target: RepositorySessionTarget,
  input: RepositoryStartAiSessionRequest,
  options?: { signal?: AbortSignal },
) {
  if (target.sessionKind !== "ai-session") {
    throw new Error("New AI sessions can only be started from an AI session repository context.");
  }
  return postUrlData<RepositoryAiSessionLaunchResult>(`${repositoryTargetBasePath(target)}/ai-sessions`, input, options);
}

export function createRepositoryWorktreeAiSession(
  target: RepositorySessionTarget,
  input: RepositoryCreateWorktreeAiSessionRequest,
  options?: { signal?: AbortSignal },
) {
  if (target.sessionKind !== "ai-session") {
    throw new Error("Managed worktrees can only start AI sessions from an AI session repository context.");
  }
  return postUrlData<RepositoryAiSessionLaunchResult>(`${repositoryTargetBasePath(target)}/worktrees/ai-sessions`, input, options);
}

export function removeRepositoryWorktree(
  target: RepositorySessionTarget,
  input: { worktreeId: string; expectedSnapshotId: string; confirm: true },
  options?: { signal?: AbortSignal },
) {
  if (target.sessionKind !== "ai-session") {
    throw new Error("Worktrees can only be removed from an AI session repository context.");
  }
  return postUrlData<RepositoryRemoveWorktreeResult>(`${repositoryTargetBasePath(target)}/worktrees/remove`, input, options);
}

export function getRepositoryBranches(target: RepositorySessionTarget, options?: { signal?: AbortSignal }) {
  return getUrlData<RepositoryBranches>(`${repositoryTargetBasePath(target)}/branches`, options);
}

function repositoryUrlWithQuery(target: RepositorySessionTarget, resource: string, query: Record<string, string | number>) {
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  return `${repositoryTargetBasePath(target)}/${resource}?${params.toString()}`;
}

export function getRepositoryDirectory(target: RepositorySessionTarget, path = "", options?: { signal?: AbortSignal }) {
  return getUrlData<RepositoryDirectoryListing>(repositoryUrlWithQuery(target, "directories", { path }), options);
}

export function getRepositoryFile(target: RepositorySessionTarget, path: string, options?: { signal?: AbortSignal }) {
  return getUrlData<RepositoryFileContent>(repositoryUrlWithQuery(target, "files", { path }), options);
}

export function createRepositoryFile(
  target: RepositorySessionTarget,
  input: { path: string; content: string; expectedAbsent: true; expectedSnapshotId: string },
  options?: { signal?: AbortSignal },
) {
  return postUrlData<RepositoryFileMutationResult>(`${repositoryTargetBasePath(target)}/files`, input, options);
}

export function writeRepositoryFile(
  target: RepositorySessionTarget,
  input: { path: string; content: string; expectedVersion: string; expectedSnapshotId: string },
  options?: { signal?: AbortSignal },
) {
  return putUrlData<RepositoryFileMutationResult>(`${repositoryTargetBasePath(target)}/files`, input, options);
}

export function renameRepositoryFile(
  target: RepositorySessionTarget,
  input: { path: string; destination: string; expectedVersion: string; expectedDestinationAbsent: true; expectedSnapshotId: string },
  options?: { signal?: AbortSignal },
) {
  return postUrlData<RepositoryFileMutationResult>(`${repositoryTargetBasePath(target)}/files/rename`, input, options);
}

export function deleteRepositoryFile(
  target: RepositorySessionTarget,
  input: { path: string; expectedVersion: string; expectedSnapshotId: string; confirm: true },
  options?: { signal?: AbortSignal },
) {
  return deleteUrlData<RepositoryFileMutationResult>(`${repositoryTargetBasePath(target)}/files`, input, options);
}

export function getRepositoryChanges(target: RepositorySessionTarget, options?: { signal?: AbortSignal }) {
  return getUrlData<RepositoryChanges>(`${repositoryTargetBasePath(target)}/changes`, options);
}

export type RepositoryVersionedPath = { path: string; expectedVersion: string };

function mutateRepositoryChanges(
  target: RepositorySessionTarget,
  resource: string,
  input: unknown,
  options?: { signal?: AbortSignal },
) {
  return postUrlData<RepositoryMutationResult>(`${repositoryTargetBasePath(target)}/${resource}`, input, options);
}

export function stageRepositoryPaths(target: RepositorySessionTarget, input: { paths: RepositoryVersionedPath[]; expectedSnapshotId: string }) {
  return mutateRepositoryChanges(target, "index/stage", input);
}

export function unstageRepositoryPaths(target: RepositorySessionTarget, input: { paths: RepositoryVersionedPath[]; expectedSnapshotId: string }) {
  return mutateRepositoryChanges(target, "index/unstage", input);
}

export function discardRepositoryWorktree(
  target: RepositorySessionTarget,
  input: { paths: RepositoryVersionedPath[]; expectedSnapshotId: string; confirm: true },
) {
  return mutateRepositoryChanges(target, "discard/worktree", input);
}

export function discardRepositoryAllTracked(
  target: RepositorySessionTarget,
  input: { paths: RepositoryVersionedPath[]; expectedSnapshotId: string; confirm: true },
) {
  return mutateRepositoryChanges(target, "discard/all-tracked", input);
}

export function commitRepositoryIndex(target: RepositorySessionTarget, input: { message: string; expectedSnapshotId: string }) {
  return mutateRepositoryChanges(target, "commits", input);
}

export function getRepositoryDiff(
  target: RepositorySessionTarget,
  input: { path: string; scope: RepositoryChangeScope; byteLimit?: number },
  options?: { signal?: AbortSignal },
) {
  return getUrlData<RepositoryDiff>(repositoryUrlWithQuery(target, "diff", {
    path: input.path,
    scope: input.scope,
    byteLimit: input.byteLimit || 512 * 1024,
  }), options);
}

function mutateRepositoryBranches(
  target: RepositorySessionTarget,
  action: "create" | "checkout" | "tracking" | "delete",
  input: unknown,
  options?: { signal?: AbortSignal },
) {
  return postUrlData<RepositoryBranchMutationResult>(`${repositoryTargetBasePath(target)}/branches/${action}`, input, options);
}

export function createRepositoryBranch(target: RepositorySessionTarget, input: { name: string; expectedSnapshotId: string }) {
  return mutateRepositoryBranches(target, "create", input);
}

export function checkoutRepositoryBranch(target: RepositorySessionTarget, input: { branch: string; expectedSnapshotId: string }) {
  return mutateRepositoryBranches(target, "checkout", input);
}

export function createRepositoryTrackingBranch(
  target: RepositorySessionTarget,
  input: { name: string; remoteTrackingRef: string; expectedSnapshotId: string },
) {
  return mutateRepositoryBranches(target, "tracking", input);
}

export function deleteRepositoryBranch(target: RepositorySessionTarget, input: { name: string; expectedSnapshotId: string; confirm: true }) {
  return mutateRepositoryBranches(target, "delete", input);
}

function mutateRepositoryDelivery(
  target: RepositorySessionTarget,
  action: "fetch" | "pull" | "publish" | "push",
  input: unknown,
  options?: { signal?: AbortSignal },
) {
  return postUrlData<RepositoryBranchMutationResult>(`${repositoryTargetBasePath(target)}/delivery/${action}`, input, options);
}

export function fetchRepositoryRemote(target: RepositorySessionTarget, input: { remote: string; expectedSnapshotId: string }) {
  return mutateRepositoryDelivery(target, "fetch", input);
}

export function pullRepositoryBranch(target: RepositorySessionTarget, input: { expectedSnapshotId: string }) {
  return mutateRepositoryDelivery(target, "pull", input);
}

export function publishRepositoryBranch(
  target: RepositorySessionTarget,
  input: { remote: string; sourceBranch: string; targetBranch: string; setUpstream: boolean; confirmSetUpstream?: true; expectedSnapshotId: string },
) {
  return mutateRepositoryDelivery(target, "publish", input);
}

export function pushRepositoryBranch(
  target: RepositorySessionTarget,
  input: { remote: string; sourceBranch: string; targetBranch: string; expectedSnapshotId: string },
) {
  return mutateRepositoryDelivery(target, "push", input);
}

export function useRepositoryContextQuery(
  target: MaybeRefOrGetter<RepositorySessionTarget>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  const resolvedTarget = computed(() => toValue(target));
  return useQuery({
    queryKey: computed(() => [
      "repository-context",
      resolvedTarget.value.instanceId,
      resolvedTarget.value.sessionKind,
      resolvedTarget.value.sessionId,
    ]),
    queryFn: ({ signal }) => getRepositoryContext(resolvedTarget.value, { signal }),
    enabled: computed(() => Boolean(
      toValue(enabled)
      && resolvedTarget.value.instanceId
      && resolvedTarget.value.sessionId
    )),
    retry: false,
    refetchOnWindowFocus: true,
  });
}

export function useRepositoryWorktreesQuery(
  target: MaybeRefOrGetter<RepositorySessionTarget>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  const resolvedTarget = computed(() => toValue(target));
  return useQuery({
    queryKey: computed(() => [
      "repository-worktrees",
      resolvedTarget.value.instanceId,
      resolvedTarget.value.sessionKind,
      resolvedTarget.value.sessionId,
    ]),
    queryFn: ({ signal }) => getRepositoryWorktrees(resolvedTarget.value, { signal }),
    enabled: computed(() => Boolean(
      toValue(enabled)
      && resolvedTarget.value.instanceId
      && resolvedTarget.value.sessionId
    )),
    retry: false,
    refetchOnWindowFocus: true,
  });
}

export function useRepositoryBranchesQuery(
  target: MaybeRefOrGetter<RepositorySessionTarget>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  const resolvedTarget = computed(() => toValue(target));
  return useQuery({
    queryKey: computed(() => [
      "repository-branches",
      resolvedTarget.value.instanceId,
      resolvedTarget.value.sessionKind,
      resolvedTarget.value.sessionId,
    ]),
    queryFn: ({ signal }) => getRepositoryBranches(resolvedTarget.value, { signal }),
    enabled: computed(() => Boolean(
      toValue(enabled)
      && resolvedTarget.value.instanceId
      && resolvedTarget.value.sessionId
    )),
    retry: false,
    refetchOnWindowFocus: true,
  });
}
