import { z } from "zod";
import {
  RepositoryBranchesSchema,
  RepositoryCreateWorktreeRequestSchema,
  RepositoryCreateWorktreeResultSchema,
  RepositoryMoveWorktreePreflightRequestSchema,
  RepositoryMoveWorktreePreflightSchema,
  RepositoryMoveWorktreeRequestSchema,
  RepositoryMoveWorktreeResultSchema,
  RepositoryContextSchema,
  RepositoryRemoveWorktreeRequestSchema,
  RepositoryRemoveWorktreeResultSchema,
  RepositoryWorktreesSchema,
  type RepositoryBranches,
  type RepositoryCreateWorktreeRequest,
  type RepositoryCreateWorktreeResult,
  type RepositoryMoveWorktreePreflight,
  type RepositoryMoveWorktreePreflightRequest,
  type RepositoryMoveWorktreeRequest,
  type RepositoryMoveWorktreeResult,
  type RepositoryRemoveWorktreeRequest,
  type RepositoryRemoveWorktreeResult,
  type RepositorySessionKind,
  type RepositoryWorktrees,
} from "@task-handoff/protocol/repository";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { jsonRequest } from "./json-request.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();

export type RepositorySessionTarget = {
  instanceId: string;
  sessionKind: RepositorySessionKind;
  sessionId: string;
};

/**
 * Workspace-scoped repository target. `legacySession` keeps compatibility for
 * v0.0.21: controlled instances older than the workspace routes can only serve
 * repository reads and mutations through a session-scoped route.
 */
export type RepositoryWorkspaceTarget = {
  instanceId: string;
  cwdFolderId?: string;
  legacySession?: RepositorySessionTarget;
};

export function isControlPlaneNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { status?: unknown }).status === 404);
}

export function repositorySessionBasePath(target: RepositorySessionTarget) {
  const sessionCollection = target.sessionKind === "ai-session" ? "ai-sessions" : "apps/sessions";
  return `/instances/${encodeURIComponent(target.instanceId)}/api/${sessionCollection}/${encodeURIComponent(target.sessionId)}/repository`;
}

export function repositoryWorkspaceResource(target: RepositoryWorkspaceTarget, resource: string) {
  const path = `/api/controlled-instances/${encodeURIComponent(target.instanceId)}/repository/${resource}`;
  return target.cwdFolderId ? `${path}?${new URLSearchParams({ cwdFolderId: target.cwdFolderId })}` : path;
}

export function createControlPlaneRepositoryApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const workspaceFallback = <T>(target: RepositoryWorkspaceTarget, run: (session: RepositorySessionTarget) => Promise<T>) => (
    async (error: unknown) => {
      if (!isControlPlaneNotFoundError(error) || !target.legacySession) throw error;
      return run(target.legacySession);
    }
  );

  return {
    /**
     * Repository context of a concrete session. The controlled instance resolves the
     * session's own working directory, so this is the authority for which worktree a
     * session runs in; clients must not infer that from worktree occupancy projections.
     */
    async context(target: RepositorySessionTarget, options?: { signal?: AbortSignal }) {
      return await requestData(`${repositorySessionBasePath(target)}/context`, RepositoryContextSchema, { signal: options?.signal });
    },
    async worktrees(target: RepositoryWorkspaceTarget, options?: { signal?: AbortSignal }) {
      try {
        return await requestData(repositoryWorkspaceResource(target, "worktrees"), RepositoryWorktreesSchema, { signal: options?.signal });
      } catch (error) {
        return workspaceFallback(target, (session) => (
          requestData(`${repositorySessionBasePath(session)}/worktrees`, RepositoryWorktreesSchema, { signal: options?.signal })
        ))(error);
      }
    },
    async createWorktree(target: RepositoryWorkspaceTarget, input: RepositoryCreateWorktreeRequest, options?: { signal?: AbortSignal }) {
      const body = RepositoryCreateWorktreeRequestSchema.parse(input);
      try {
        return await requestData(repositoryWorkspaceResource(target, "worktrees"), RepositoryCreateWorktreeResultSchema, jsonRequest("POST", body, options?.signal));
      } catch (error) {
        return workspaceFallback(target, (session) => (
          requestData(`${repositorySessionBasePath(session)}/worktrees`, RepositoryCreateWorktreeResultSchema, jsonRequest("POST", body, options?.signal))
        ))(error);
      }
    },
    async removeWorktree(target: RepositoryWorkspaceTarget, input: RepositoryRemoveWorktreeRequest, options?: { signal?: AbortSignal }) {
      const body = RepositoryRemoveWorktreeRequestSchema.parse(input);
      try {
        return await requestData(repositoryWorkspaceResource(target, "worktrees/remove"), RepositoryRemoveWorktreeResultSchema, jsonRequest("POST", body, options?.signal));
      } catch (error) {
        return workspaceFallback(target, (session) => {
          if (session.sessionKind !== "ai-session") {
            throw new Error("Worktrees can only be removed from an AI session repository context.");
          }
          return requestData(`${repositorySessionBasePath(session)}/worktrees/remove`, RepositoryRemoveWorktreeResultSchema, jsonRequest("POST", body, options?.signal));
        })(error);
      }
    },
    async moveWorktreeToMainPreflight(target: RepositoryWorkspaceTarget, input: RepositoryMoveWorktreePreflightRequest, options?: { signal?: AbortSignal }) {
      const body = RepositoryMoveWorktreePreflightRequestSchema.parse(input);
      const data = await requestData(repositoryWorkspaceResource(target, "worktrees/move-to-main/preflight"), RepositoryMoveWorktreePreflightSchema, jsonRequest("POST", body, options?.signal));
      return data satisfies RepositoryMoveWorktreePreflight;
    },
    async moveWorktreeToMain(target: RepositoryWorkspaceTarget, input: RepositoryMoveWorktreeRequest, options?: { signal?: AbortSignal }) {
      const body = RepositoryMoveWorktreeRequestSchema.parse(input);
      return requestData(repositoryWorkspaceResource(target, "worktrees/move-to-main"), RepositoryMoveWorktreeResultSchema, jsonRequest("POST", body, options?.signal));
    },
    async branches(target: RepositoryWorkspaceTarget, options?: { signal?: AbortSignal }) {
      try {
        return await requestData(repositoryWorkspaceResource(target, "branches"), RepositoryBranchesSchema, { signal: options?.signal });
      } catch (error) {
        return workspaceFallback(target, (session) => (
          requestData(`${repositorySessionBasePath(session)}/branches`, RepositoryBranchesSchema, { signal: options?.signal })
        ))(error);
      }
    },
  };
}

export type ControlPlaneRepositoryApi = ReturnType<typeof createControlPlaneRepositoryApi>;
export type ControlPlaneRepositoryWorktrees = RepositoryWorktrees;
export type ControlPlaneRepositoryBranches = RepositoryBranches;
export type ControlPlaneRepositoryCreateWorktreeResult = RepositoryCreateWorktreeResult;
export type ControlPlaneRepositoryRemoveWorktreeResult = RepositoryRemoveWorktreeResult;
export type ControlPlaneRepositoryMoveWorktreeResult = RepositoryMoveWorktreeResult;
