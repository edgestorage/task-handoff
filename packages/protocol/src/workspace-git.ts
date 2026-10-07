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

/**
 * Machine-readable progress contract for `docker/git-provision.sh`.
 *
 * The provisioning script prints one marker line per stage/result on stdout (or
 * stderr for failures); the node agent forwards the raw stream to the control
 * plane, and both sides parse it with the helpers below. The script cannot
 * import this module, so keep the names in sync with `docker/git-provision.sh`.
 */
export const GIT_PROVISIONING_MARKERS = {
  stage: "TASK_HANDOFF_GIT_PROVISIONING_STAGE=",
  commit: "TASK_HANDOFF_GIT_PROVISIONING_COMMIT=",
  errorCode: "TASK_HANDOFF_GIT_PROVISIONING_ERROR=",
} as const;

export const GIT_PROVISIONING_STAGES = ["cloning", "checking-out", "submodules", "lfs", "finalizing"] as const;

export type GitProvisioningStage = typeof GIT_PROVISIONING_STAGES[number];

export type GitProvisioningMarker = {
  stage?: GitProvisioningStage;
  commit?: string;
  errorCode?: string;
};

const GIT_PROVISIONING_STAGE_SET: ReadonlySet<string> = new Set(GIT_PROVISIONING_STAGES);

export function parseGitProvisioningMarker(line: string): GitProvisioningMarker | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith(GIT_PROVISIONING_MARKERS.stage)) {
    const stage = trimmed.slice(GIT_PROVISIONING_MARKERS.stage.length).trim();
    return GIT_PROVISIONING_STAGE_SET.has(stage) ? { stage: stage as GitProvisioningStage } : undefined;
  }
  if (trimmed.startsWith(GIT_PROVISIONING_MARKERS.commit)) {
    const commit = trimmed.slice(GIT_PROVISIONING_MARKERS.commit.length).trim();
    return commit ? { commit } : undefined;
  }
  if (trimmed.startsWith(GIT_PROVISIONING_MARKERS.errorCode)) {
    const errorCode = trimmed.slice(GIT_PROVISIONING_MARKERS.errorCode.length).trim();
    return errorCode ? { errorCode } : undefined;
  }
  return undefined;
}

const MAX_PENDING_CHARS = 8_192;
const MAX_RECENT_LINES = 40;

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripTerminalFormatting(value: string) {
  return value.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARS, "").trim();
}

export type GitProvisioningTerminalChunk = GitProvisioningMarker & {
  /** Terminal output with marker lines removed, ready to display. */
  display: string;
};

/**
 * Splits the provisioning terminal stream into displayable output and marker
 * lines. git progress updates use bare carriage returns, so every line
 * delimiter is a boundary and only the trailing partial line is held back.
 */
export class GitProvisioningTerminalParser {
  private pending = "";
  private recent: string[] = [];

  push(chunk: string): GitProvisioningTerminalChunk {
    const parts = `${this.pending}${chunk}`.split(/(\r\n|\n|\r)/);
    const remainder = parts.pop() ?? "";
    const overflow = remainder.length > MAX_PENDING_CHARS;
    this.pending = overflow ? "" : remainder;
    let display = overflow ? remainder : "";
    const parsed: GitProvisioningTerminalChunk = { display: "" };
    for (let index = 0; index < parts.length; index += 2) {
      const line = parts[index];
      const delimiter = parts[index + 1] || "";
      const marker = parseGitProvisioningMarker(line);
      if (marker) {
        Object.assign(parsed, marker);
        continue;
      }
      display += `${line}${delimiter}`;
      this.remember(line);
    }
    parsed.display = display;
    return parsed;
  }

  flush(): string {
    const remainder = this.pending;
    this.pending = "";
    if (parseGitProvisioningMarker(remainder)) return "";
    this.remember(remainder);
    return remainder;
  }

  /** Last meaningful non-marker line, used as the failure reason. */
  failureDetail() {
    return this.recent.filter(Boolean).at(-1);
  }

  private remember(line: string) {
    const cleaned = stripTerminalFormatting(line);
    if (!cleaned) return;
    this.recent.push(cleaned);
    if (this.recent.length > MAX_RECENT_LINES) this.recent.splice(0, this.recent.length - MAX_RECENT_LINES);
  }
}

/** Removes inline credentials so provisioning failures never leak secrets. */
export function redactGitUrlCredentials(value: string) {
  return value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1***@");
}
