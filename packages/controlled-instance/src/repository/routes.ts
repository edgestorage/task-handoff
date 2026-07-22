import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppRuntimeManager } from "@task-handoff/app-runtime/runtime";
import type { AiSessionRegistry } from "@task-handoff/ai-session-runtime";
import {
  RepositoryCommitRequestSchema,
  RepositoryCheckoutBranchRequestSchema,
  RepositoryCreateBranchRequestSchema,
  RepositoryCreateFileRequestSchema,
  RepositoryCreateTrackingBranchRequestSchema,
  RepositoryCreateWorktreeRequestSchema,
  RepositoryCreateWorktreeAiSessionRequestSchema,
  RepositoryDeleteFileRequestSchema,
  RepositoryDiscardAllTrackedRequestSchema,
  RepositoryDiscardWorktreeRequestSchema,
  RepositoryDeleteBranchRequestSchema,
  RepositoryFetchRequestSchema,
  RepositoryPullRequestSchema,
  RepositoryPublishRequestSchema,
  RepositoryPushRequestSchema,
  RepositoryRemoveWorktreeRequestSchema,
  RepositoryRenameFileRequestSchema,
  RepositoryStageRequestSchema,
  RepositoryStartAiSessionRequestSchema,
  RepositoryUnstageRequestSchema,
  RepositoryWriteFileRequestSchema,
} from "@task-handoff/protocol/repository";
import { RepositoryChangesService, RepositoryOperationError } from "./changes";
import { RepositoryBranchService } from "./branches";
import { RepositoryFileError, RepositoryFileService } from "./files";
import { RepositorySessionResolver, type ResolvedRepository } from "./context";
import { RepositoryMutationQueue } from "./mutation-queue";
import { ManagedWorktreeRegistry, RepositoryWorktreeService } from "./worktrees";

type RegisterRepositoryRoutesOptions = {
  appRuntime: AppRuntimeManager;
  aiSessions: AiSessionRegistry;
  managedWorktreesRoot: string;
  workspaceRoots: string[];
};

const EmptyQuerySchema = z.object({}).strict();
const DirectoryQuerySchema = z.object({ path: z.string().max(4096).default("") }).strict();
const FileQuerySchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const DiffQuerySchema = z.object({
  path: z.string().min(1).max(4096),
  scope: z.enum(["conflict", "staged", "unstaged", "untracked"]),
  byteLimit: z.coerce.number().int().min(1).max(2 * 1024 * 1024).default(512 * 1024),
}).strict();

export function registerRepositoryRoutes(app: FastifyInstance, options: RegisterRepositoryRoutesOptions) {
  const resolver = new RepositorySessionResolver({
    aiSession: (id) => options.aiSessions.get(id),
    appSession: (id) => options.appRuntime.getSession(id),
  });
  const registry = new ManagedWorktreeRegistry(options.managedWorktreesRoot);
  const queue = new RepositoryMutationQueue();
  const sessionInventory = {
    // Repository occupancy must consume the same bound session model published
    // by the instance API. Raw discovery history can outlive its closed app session.
    aiSessions: () => options.aiSessions.boundSnapshot(options.appRuntime.listSessions(), 10_000).sessions,
    appSessions: () => options.appRuntime.listSessions(),
  };
  const resolveFor = (kind: "ai-session" | "app-session", id: string) => () => kind === "ai-session" ? resolver.resolveAiSession(id) : resolver.resolveAppSession(id);
  const servicesFor = (kind: "ai-session" | "app-session", id: string) => {
    const resolve = resolveFor(kind, id);
    const worktrees = new RepositoryWorktreeService(resolve, registry, sessionInventory, options.workspaceRoots, queue);
    return {
      resolve,
      changes: new RepositoryChangesService(resolve, queue),
      worktrees,
      branches: new RepositoryBranchService(resolve, worktrees, queue),
    };
  };

  for (const kind of ["ai-session", "app-session"] as const) {
    const segment = kind === "ai-session" ? "ai-sessions" : "apps/sessions";
    const base = `/api/${segment}/:id/repository`;

    app.get<{ Params: { id: string }; Querystring: unknown }>(`${base}/context`, async (request, reply) => {
      try {
        EmptyQuerySchema.parse(request.query || {});
        return { data: (await servicesFor(kind, request.params.id).resolve()).context };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.get<{ Params: { id: string }; Querystring: unknown }>(`${base}/worktrees`, async (request, reply) => {
      try {
        EmptyQuerySchema.parse(request.query || {});
        return { data: await servicesFor(kind, request.params.id).worktrees.list() };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/worktrees`, async (request, reply) => {
      try {
        const body = RepositoryCreateWorktreeRequestSchema.parse(request.body || {});
        return { data: await servicesFor(kind, request.params.id).worktrees.create(body) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/worktrees/remove`, async (request, reply) => {
      try {
        const body = RepositoryRemoveWorktreeRequestSchema.parse(request.body || {});
        return { data: await servicesFor(kind, request.params.id).worktrees.remove(body) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.get<{ Params: { id: string }; Querystring: unknown }>(`${base}/directories`, async (request, reply) => {
      try {
        const query = DirectoryQuerySchema.parse(request.query || {});
        const state = await requireRepository(servicesFor(kind, request.params.id).resolve);
        return { data: new RepositoryFileService(state.worktreeRoot!).list(query.path) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.get<{ Params: { id: string }; Querystring: unknown }>(`${base}/files`, async (request, reply) => {
      try {
        const query = FileQuerySchema.parse(request.query || {});
        const state = await requireRepository(servicesFor(kind, request.params.id).resolve);
        return { data: new RepositoryFileService(state.worktreeRoot!).read(query.path) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/files`, { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
      try {
        const body = RepositoryCreateFileRequestSchema.parse(request.body || {});
        return { data: await fileMutation(servicesFor(kind, request.params.id).resolve, queue, body.expectedSnapshotId, (files) => files.create(body.path, body.content)) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.put<{ Params: { id: string }; Body: unknown }>(`${base}/files`, { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
      try {
        const body = RepositoryWriteFileRequestSchema.parse(request.body || {});
        return { data: await fileMutation(servicesFor(kind, request.params.id).resolve, queue, body.expectedSnapshotId, (files) => files.write(body.path, body.content, body.expectedVersion)) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/files/rename`, async (request, reply) => {
      try {
        const body = RepositoryRenameFileRequestSchema.parse(request.body || {});
        return { data: await fileMutation(servicesFor(kind, request.params.id).resolve, queue, body.expectedSnapshotId, (files) => files.rename(body.path, body.destination, body.expectedVersion)) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.delete<{ Params: { id: string }; Body: unknown }>(`${base}/files`, async (request, reply) => {
      try {
        const body = RepositoryDeleteFileRequestSchema.parse(request.body || {});
        return { data: await fileMutation(servicesFor(kind, request.params.id).resolve, queue, body.expectedSnapshotId, (files) => files.delete(body.path, body.expectedVersion)) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.get<{ Params: { id: string }; Querystring: unknown }>(`${base}/changes`, async (request, reply) => {
      try {
        EmptyQuerySchema.parse(request.query || {});
        const state = await requireRepository(servicesFor(kind, request.params.id).resolve);
        return { data: state.changes };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.get<{ Params: { id: string }; Querystring: unknown }>(`${base}/diff`, async (request, reply) => {
      try {
        const query = DiffQuerySchema.parse(request.query || {});
        return { data: await servicesFor(kind, request.params.id).changes.diff(query.scope, query.path, query.byteLimit) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/index/stage`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).changes.stage(RepositoryStageRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/index/unstage`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).changes.unstage(RepositoryUnstageRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/discard/worktree`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).changes.discardWorktree(RepositoryDiscardWorktreeRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/discard/all-tracked`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).changes.discardAllTracked(RepositoryDiscardAllTrackedRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/commits`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).changes.commit(RepositoryCommitRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });

    app.get<{ Params: { id: string }; Querystring: unknown }>(`${base}/branches`, async (request, reply) => {
      try { EmptyQuerySchema.parse(request.query || {}); return { data: await servicesFor(kind, request.params.id).branches.list() }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/branches/create`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).branches.create(RepositoryCreateBranchRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/branches/checkout`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).branches.checkout(RepositoryCheckoutBranchRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/branches/tracking`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).branches.createTracking(RepositoryCreateTrackingBranchRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/branches/delete`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).branches.delete(RepositoryDeleteBranchRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.get<{ Params: { id: string }; Querystring: unknown }>(`${base}/remotes`, async (request, reply) => {
      try {
        EmptyQuerySchema.parse(request.query || {});
        const state = await requireRepository(servicesFor(kind, request.params.id).resolve);
        return { data: { snapshotId: state.context.snapshotId, remotes: state.context.remotes || [] } };
      } catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/delivery/fetch`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).branches.fetch(RepositoryFetchRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/delivery/pull`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).branches.pull(RepositoryPullRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/delivery/publish`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).branches.publish(RepositoryPublishRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/delivery/push`, async (request, reply) => {
      try { return { data: await servicesFor(kind, request.params.id).branches.push(RepositoryPushRequestSchema.parse(request.body || {})) }; }
      catch (error) { return sendRepositoryError(reply, error); }
    });
  }

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/repository/ai-sessions", async (request, reply) => {
    try {
      const body = RepositoryStartAiSessionRequestSchema.parse(request.body || {});
      const services = servicesFor("ai-session", request.params.id);
      const source = await requireRepository(services.resolve);
      const workspace = body.workspaceSelection.type === "current"
        ? source.worktreeRoot!
        : await services.worktrees.resolveWorkspace(body.workspaceSelection.repositoryContextId, body.workspaceSelection.worktreeId);
      const worktrees = await services.worktrees.list();
      const worktreeId = body.workspaceSelection.type === "current"
        ? worktrees.items.find((item) => item.isCurrent)?.id
        : body.workspaceSelection.worktreeId;
      if (!worktreeId) throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "Current worktree no longer exists.", source);
      const launched = options.appRuntime.start(body.agent, { cwd: workspace });
      return { data: { appSessionId: launched.id, worktreeId, disposition: "started" as const } };
    } catch (error) { return sendRepositoryError(reply, sanitizeAiSessionLaunchError(error)); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/repository/worktrees/ai-sessions", async (request, reply) => {
    try {
      const body = RepositoryCreateWorktreeAiSessionRequestSchema.parse(request.body || {});
      const services = servicesFor("ai-session", request.params.id);
      const created = await services.worktrees.create(body.worktree);
      try {
        const workspace = await services.worktrees.resolveWorkspace(created.worktrees.repositoryContextId, created.worktreeId);
        const launched = options.appRuntime.start(body.agent, { cwd: workspace });
        return { data: { appSessionId: launched.id, worktreeId: created.worktreeId, disposition: "started" as const } };
      } catch (launchError) {
        const cleanup = await compensateFailedWorktreeLaunch(services.worktrees, created.worktreeId);
        throw new RepositoryOperationError(
          "REPOSITORY_OPERATION_FAILED",
          cleanup.removed
            ? "AI session launch failed; the newly created worktree was removed and its branch was retained."
            : "AI session launch failed; the newly created worktree was retained for recovery.",
          await services.resolve(),
          { worktreeId: created.worktreeId, worktreeRemoved: cleanup.removed, branchRetained: true, recoverable: !cleanup.removed },
        );
      }
    } catch (error) { return sendRepositoryError(reply, sanitizeAiSessionLaunchError(error)); }
  });
}

async function compensateFailedWorktreeLaunch(worktrees: RepositoryWorktreeService, worktreeId: string) {
  try {
    const current = await worktrees.list();
    const target = current.items.find((item) => item.id === worktreeId);
    if (!target?.canRemove) return { removed: false };
    await worktrees.remove({ worktreeId, expectedSnapshotId: current.snapshotId, confirm: true });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

function sanitizeAiSessionLaunchError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof RepositoryOperationError || error instanceof RepositoryFileError) return error;
  return new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "AI session could not be started.");
}

async function fileMutation<T>(resolve: () => Promise<ResolvedRepository>, queue: RepositoryMutationQueue, expectedSnapshotId: string, operation: (files: RepositoryFileService) => T) {
  const initial = await requireRepository(resolve);
  return queue.withWorktree(initial.worktreeRoot!, async () => {
    const state = await requireRepository(resolve);
    if (state.context.snapshotId !== expectedSnapshotId) throw new RepositoryOperationError("REPOSITORY_STATE_STALE", "Repository state changed after the file was loaded.", state);
    const file = operation(new RepositoryFileService(state.worktreeRoot!));
    const current = await requireRepository(resolve);
    return { file, snapshotId: current.context.snapshotId, context: current.context, changes: current.changes };
  });
}

async function requireRepository(resolve: () => Promise<ResolvedRepository>) {
  const state = await resolve();
  if (state.context.availability !== "available" || !state.worktreeRoot || !state.changes) {
    throw new RepositoryOperationError(repositoryAvailabilityCode(state.context.availability), "Repository is unavailable for this session.", state);
  }
  return state;
}

function repositoryAvailabilityCode(availability: string) {
  return ({
    "session-not-found": "REPOSITORY_SESSION_NOT_FOUND",
    "session-inactive": "REPOSITORY_SESSION_INACTIVE",
    "cwd-missing": "REPOSITORY_CWD_MISSING",
    "cwd-inaccessible": "REPOSITORY_CWD_INACCESSIBLE",
    "git-unavailable": "REPOSITORY_GIT_UNAVAILABLE",
    "not-worktree": "REPOSITORY_NOT_WORKTREE",
  } as Record<string, string>)[availability] || "REPOSITORY_NOT_WORKTREE";
}

function sendRepositoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: { code: "REPOSITORY_REQUEST_INVALID", message: error.issues.map((issue) => issue.message).join("; "), retryable: false } });
  }
  const code = error instanceof RepositoryOperationError || error instanceof RepositoryFileError ? error.code : "REPOSITORY_OPERATION_FAILED";
  const message = error instanceof RepositoryOperationError || error instanceof RepositoryFileError ? error.message : "Repository operation failed.";
  const current = error instanceof RepositoryOperationError ? error.current : undefined;
  const details = error instanceof RepositoryOperationError ? error.details : undefined;
  const status = repositoryHttpStatus(code);
  return reply.code(status).send({
    error: { code, message, retryable: code === "REPOSITORY_STATE_STALE" || code === "REPOSITORY_COMMAND_TIMEOUT", ...(details ? { details } : {}) },
    ...(current ? { current: { context: current.context, changes: current.changes } } : {}),
  });
}

function repositoryHttpStatus(code: string) {
  if (code === "REPOSITORY_SESSION_NOT_FOUND" || code === "REPOSITORY_FILE_NOT_FOUND" || code === "REPOSITORY_WORKTREE_NOT_FOUND") return 404;
  if (code === "REPOSITORY_GIT_UNAVAILABLE") return 503;
  if (code === "REPOSITORY_FILE_TOO_LARGE" || code === "REPOSITORY_OUTPUT_LIMIT") return 413;
  if (code.includes("STALE") || code.includes("CONFLICT") || code.includes("DIRTY") || code.includes("OCCUPIED") || code.includes("UNSAFE")) return 409;
  return 400;
}

export function repositoryWorkspaceRootsFromEnv() {
  return [
    ...(process.env.TASK_HANDOFF_WORKSPACE_ROOTS || "").split(path.delimiter),
    process.env.TASK_HANDOFF_WORKSPACE || "",
  ].map((entry) => entry.trim()).filter(Boolean);
}
