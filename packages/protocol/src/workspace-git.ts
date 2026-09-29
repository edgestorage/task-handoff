/**
 * Environment contract for the managed Git workspace inside a controlled
 * instance container.
 *
 * The node agent is the only producer: it passes these keys to the one-shot
 * provisioning helper and to the instance container. Consumers are the
 * provisioning helper (`docker/git-provision.sh`), the instance entrypoint
 * (`docker/entrypoint.sh`), and the controlled instance status API.
 *
 * The keys stay separate from image build metadata on purpose. Released images
 * bake `TASK_HANDOFF_GIT_COMMIT` as the commit the image was built from, and
 * Docker exposes image environment variables to every container started from
 * that image. Reusing that name for the workspace checkout made the helper
 * check out the image build commit instead of the requested ref.
 *
 * `docker/git-provision.sh` and `docker/entrypoint.sh` ship with the node agent,
 * mirror these names, and read only the `TASK_HANDOFF_WORKSPACE_GIT_*` keys;
 * they cannot import this module, so keep them in sync.
 */
export const WORKSPACE_GIT_ENV = {
  url: "TASK_HANDOFF_WORKSPACE_GIT_URL",
  ref: "TASK_HANDOFF_WORKSPACE_GIT_REF",
  commit: "TASK_HANDOFF_WORKSPACE_GIT_COMMIT",
  depth: "TASK_HANDOFF_WORKSPACE_GIT_DEPTH",
  submodules: "TASK_HANDOFF_WORKSPACE_GIT_SUBMODULES",
  lfs: "TASK_HANDOFF_WORKSPACE_GIT_LFS",
} as const;

export type WorkspaceGitEnvironmentKey = keyof typeof WORKSPACE_GIT_ENV;

/**
 * Compatibility for v0.0.34: the node agent still writes the legacy keys below
 * for the instance container, and readers fall back to them, because the
 * controlled-instance artifact is hot-swapped independently of the node agent
 * and the N-1 artifact reads the legacy names for workspace status.
 *
 * `TASK_HANDOFF_GIT_COMMIT` is intentionally absent: images bake that name as
 * the image build commit, so it cannot identify the workspace checkout commit.
 */
export const LEGACY_WORKSPACE_GIT_ENV = {
  url: "TASK_HANDOFF_GIT_URL",
  ref: "TASK_HANDOFF_GIT_REF",
  depth: "TASK_HANDOFF_GIT_DEPTH",
  submodules: "TASK_HANDOFF_GIT_SUBMODULES",
  lfs: "TASK_HANDOFF_GIT_LFS",
} as const;

export function workspaceGitEnvironmentValue(
  source: Record<string, string | undefined>,
  key: WorkspaceGitEnvironmentKey,
): string | undefined {
  const value = source[WORKSPACE_GIT_ENV[key]]?.trim();
  if (value) return value;
  const legacy = LEGACY_WORKSPACE_GIT_ENV[key as keyof typeof LEGACY_WORKSPACE_GIT_ENV];
  return legacy ? source[legacy]?.trim() || undefined : undefined;
}
