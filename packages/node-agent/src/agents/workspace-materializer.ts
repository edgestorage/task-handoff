import path from "node:path";
import type { AgentRunMemberExecutionSnapshot } from "@task-handoff/protocol/agent-runs";

export const AGENT_RUN_WORKSPACE_ROOT = "/run/task-handoff/agent-runs/workspaces";
export const AGENT_RUN_WORKSPACE_MARKER = ".task-handoff-agent-run.json";
export const AGENT_RUN_WORKSPACE_MARKER_VERSION = 1;

const PathSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/;

export type AgentRunWorkspaceMarker = {
  version: typeof AGENT_RUN_WORKSPACE_MARKER_VERSION;
  runId: string;
  memberId: string;
  generationId: string;
  createdAt: string;
};

export type AgentRunWorkspaceLayout = {
  root: string;
  runRoot: string;
  memberRoot: string;
  cwd: string;
  markerPath: string;
};

export type WorkspaceMaterializerPrepareInput = {
  runId: string;
  memberId: string;
  generationId: string;
  runtimeId: string;
  instanceId: string;
  sourceRuntimePath: string;
  executionSnapshot: AgentRunMemberExecutionSnapshot;
};

export type PreparedAgentRunWorkspace = {
  materializer: "overlay-copy-on-write" | "worktree";
  generationId: string;
  layout: AgentRunWorkspaceLayout;
  backendIdentity: string;
  diagnostics: Record<string, unknown>;
};

export type WorkspaceOwnership = "absent" | "owned" | "foreign";

export interface WorkspaceMaterializer<TWorkspace extends PreparedAgentRunWorkspace = PreparedAgentRunWorkspace> {
  readonly kind: TWorkspace["materializer"];
  prepare(input: WorkspaceMaterializerPrepareInput): Promise<TWorkspace>;
  inspectOwnership(workspace: TWorkspace, marker: AgentRunWorkspaceMarker): Promise<WorkspaceOwnership>;
  dispose(workspace: TWorkspace, marker: AgentRunWorkspaceMarker): Promise<void>;
}

export type WorkspaceMaterializerSelection = {
  runtimeType: string;
  workspaceMaterializer: string;
  processSandbox: string;
};

/** Selects only explicitly registered execution combinations; it never substitutes another materializer. */
export class WorkspaceMaterializerRegistry {
  private readonly entries = new Map<string, WorkspaceMaterializer>();

  register(selection: WorkspaceMaterializerSelection, materializer: WorkspaceMaterializer) {
    if (selection.workspaceMaterializer !== materializer.kind) {
      throw new Error(`Materializer ${materializer.kind} cannot be registered as ${selection.workspaceMaterializer}.`);
    }
    const key = this.key(selection);
    if (this.entries.has(key)) throw new Error(`Workspace materializer combination ${key} is already registered.`);
    this.entries.set(key, materializer);
  }

  require(selection: WorkspaceMaterializerSelection): WorkspaceMaterializer {
    const materializer = this.entries.get(this.key(selection));
    if (materializer) return materializer;
    throw Object.assign(new Error("No workspace materializer is available for the requested execution combination."), {
      code: "AGENT_RUN_MATERIALIZER_UNAVAILABLE",
      statusCode: 409,
      details: { ...selection },
    });
  }

  private key(selection: WorkspaceMaterializerSelection) {
    return `${selection.runtimeType}\0${selection.workspaceMaterializer}\0${selection.processSandbox}`;
  }
}

function pathSegment(value: string, field: string) {
  if (!PathSegmentPattern.test(value)) {
    throw Object.assign(new Error(`${field} is not a safe workspace path segment.`), {
      code: "AGENT_RUN_WORKSPACE_ID_INVALID",
      statusCode: 400,
      details: { field },
    });
  }
  return value;
}

/** Runtime workspace paths are POSIX paths even when the Node Agent host is not. */
export function agentRunWorkspaceLayout(
  runId: string,
  memberId: string,
  root = AGENT_RUN_WORKSPACE_ROOT,
): AgentRunWorkspaceLayout {
  const normalizedRoot = path.posix.resolve("/", root);
  const runRoot = path.posix.join(normalizedRoot, pathSegment(runId, "runId"));
  const memberRoot = path.posix.join(runRoot, pathSegment(memberId, "memberId"));
  return {
    root: normalizedRoot,
    runRoot,
    memberRoot,
    cwd: path.posix.join(memberRoot, "merged"),
    markerPath: path.posix.join(memberRoot, AGENT_RUN_WORKSPACE_MARKER),
  };
}

export function assertAgentRunWorkspacePath(root: string, candidate: string) {
  const normalizedRoot = path.posix.resolve("/", root);
  const normalizedCandidate = path.posix.resolve("/", candidate);
  if (normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)) {
    return normalizedCandidate;
  }
  throw Object.assign(new Error("Agent Run workspace path is outside its owned root."), {
    code: "AGENT_RUN_WORKSPACE_PATH_OUTSIDE_ROOT",
    statusCode: 400,
  });
}

export function createAgentRunWorkspaceMarker(input: {
  runId: string;
  memberId: string;
  generationId: string;
  createdAt?: string;
}): AgentRunWorkspaceMarker {
  pathSegment(input.runId, "runId");
  pathSegment(input.memberId, "memberId");
  pathSegment(input.generationId, "generationId");
  return {
    version: AGENT_RUN_WORKSPACE_MARKER_VERSION,
    runId: input.runId,
    memberId: input.memberId,
    generationId: input.generationId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function workspaceMarkerMatches(
  marker: AgentRunWorkspaceMarker,
  expected: Pick<AgentRunWorkspaceMarker, "runId" | "memberId" | "generationId">,
) {
  return marker.version === AGENT_RUN_WORKSPACE_MARKER_VERSION
    && marker.runId === expected.runId
    && marker.memberId === expected.memberId
    && marker.generationId === expected.generationId;
}
