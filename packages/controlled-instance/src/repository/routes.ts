import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppRuntimeManager } from "@task-handoff/app-runtime/runtime";
import {
  aiSessionCreateRequestFingerprint,
  assertAiSessionCreateRequestFingerprint,
  type AiSessionCreateCoordinator,
  type AiSessionRegistry,
} from "@task-handoff/ai-session-runtime";
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
  RepositoryAiSessionWorkspaceInspectSchema,
  RepositoryAiSessionWorkspaceSchema,
  RepositoryWorkspaceAiSessionCreateSchema,
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
  aiSessionCreate: AiSessionCreateCoordinator;
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
  includeContext: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  contextLines: z.coerce.number().int().min(1).max(3_000).default(20),
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
  const servicesForWorkspace = (cwd: string) => {
    const resolve = () => resolver.resolveWorkspace(cwd);
    const worktrees = new RepositoryWorktreeService(resolve, registry, sessionInventory, options.workspaceRoots, queue);
    return {
      resolve,
      worktrees,
      branches: new RepositoryBranchService(resolve, worktrees, queue),
    };
  };
  const workspaceLaunches = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

  app.post<{ Body: unknown }>("/api/repository/ai-session-workspace/inspect", async (request, reply) => {
    try {
      const body = RepositoryAiSessionWorkspaceInspectSchema.parse(request.body || {});
      const cwd = authorizedWorkspaceCwd(body.cwd.path, options.workspaceRoots);
      return { data: await inspectAiSessionWorkspace(servicesForWorkspace(cwd)) };
    } catch (error) { return sendRepositoryError(reply, error); }
  });

  app.post<{ Body: unknown }>("/api/repository/ai-session-workspace/create", async (request, reply) => {
    try {
      const body = RepositoryWorkspaceAiSessionCreateSchema.parse(request.body || {});
      const fingerprint = aiSessionCreateRequestFingerprint(body);
      const completed = options.aiSessionCreate.completedResult(body.clientRequestId, fingerprint);
      if (completed) return { data: completed };
      const active = workspaceLaunches.get(body.clientRequestId);
      if (active) {
        assertAiSessionCreateRequestFingerprint(active.fingerprint, fingerprint);
        return { data: await active.promise };
      }
      const cwd = authorizedWorkspaceCwd(body.cwd.path, options.workspaceRoots);
      const launch = createWorkspaceAiSession(servicesForWorkspace(cwd), options.aiSessionCreate, body, fingerprint)
        .finally(() => workspaceLaunches.delete(body.clientRequestId));
      workspaceLaunches.set(body.clientRequestId, { fingerprint, promise: launch });
      return { data: await launch };
    } catch (error) { return sendRepositoryError(reply, sanitizeAiSessionLaunchError(error)); }
  });

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
        return { data: repositoryFiles(state, options.workspaceRoots).list(query.path) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.get<{ Params: { id: string }; Querystring: unknown }>(`${base}/files`, async (request, reply) => {
      try {
        const query = FileQuerySchema.parse(request.query || {});
        const state = await requireRepository(servicesFor(kind, request.params.id).resolve);
        return { data: repositoryFiles(state, options.workspaceRoots).read(query.path) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/files`, { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
      try {
        const body = RepositoryCreateFileRequestSchema.parse(request.body || {});
        return { data: await fileMutation(servicesFor(kind, request.params.id).resolve, queue, options.workspaceRoots, body.expectedSnapshotId, (files) => files.create(body.path, body.content)) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.put<{ Params: { id: string }; Body: unknown }>(`${base}/files`, { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
      try {
        const body = RepositoryWriteFileRequestSchema.parse(request.body || {});
        return { data: await fileMutation(servicesFor(kind, request.params.id).resolve, queue, options.workspaceRoots, body.expectedSnapshotId, (files) => files.write(body.path, body.content, body.expectedVersion)) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.post<{ Params: { id: string }; Body: unknown }>(`${base}/files/rename`, async (request, reply) => {
      try {
        const body = RepositoryRenameFileRequestSchema.parse(request.body || {});
        return { data: await fileMutation(servicesFor(kind, request.params.id).resolve, queue, options.workspaceRoots, body.expectedSnapshotId, (files) => files.rename(body.path, body.destination, body.expectedVersion)) };
      } catch (error) { return sendRepositoryError(reply, error); }
    });

    app.delete<{ Params: { id: string }; Body: unknown }>(`${base}/files`, async (request, reply) => {
      try {
        const body = RepositoryDeleteFileRequestSchema.parse(request.body || {});
        return { data: await fileMutation(servicesFor(kind, request.params.id).resolve, queue, options.workspaceRoots, body.expectedSnapshotId, (files) => files.delete(body.path, body.expectedVersion)) };
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
        return { data: await servicesFor(kind, request.params.id).changes.diff(query.scope, query.path, query.byteLimit, query.includeContext, query.contextLines) };
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
      const workspaceRoot = body.workspaceSelection.type === "current"
        ? source.worktreeRoot!
        : await services.worktrees.resolveWorkspace(body.workspaceSelection.repositoryContextId, body.workspaceSelection.worktreeId);
      const workspace = workspaceCwd(workspaceRoot, source);
      const worktrees = await services.worktrees.list();
      const worktreeId = body.workspaceSelection.type === "current"
        ? worktrees.items.find((item) => item.isCurrent)?.id
        : body.workspaceSelection.worktreeId;
      if (!worktreeId) throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "Current worktree no longer exists.", source);
      const created = await options.aiSessionCreate.create({
        agent: body.agent,
        cwd: workspace,
        cwdFolderId: options.aiSessions.get(request.params.id)?.cwdFolderId,
        message: body.message,
        permissionMode: body.permissionMode,
        clientRequestId: body.clientRequestId,
      });
      return { data: { aiSessionId: created.aiSessionId, providerSessionId: created.providerSessionId, worktreeId, disposition: "started" as const } };
    } catch (error) { return sendRepositoryError(reply, sanitizeAiSessionLaunchError(error)); }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/repository/worktrees/ai-sessions", async (request, reply) => {
    try {
      const body = RepositoryCreateWorktreeAiSessionRequestSchema.parse(request.body || {});
      const services = servicesFor("ai-session", request.params.id);
      const source = await requireRepository(services.resolve);
      const created = await services.worktrees.create(body.worktree);
      try {
        const workspace = workspaceCwd(
          await services.worktrees.resolveWorkspace(created.worktrees.repositoryContextId, created.worktreeId),
          source,
        );
        const session = await options.aiSessionCreate.create({
          agent: body.agent,
          cwd: workspace,
          cwdFolderId: options.aiSessions.get(request.params.id)?.cwdFolderId,
          message: body.message,
          permissionMode: body.permissionMode,
          clientRequestId: body.clientRequestId,
        });
        return { data: { aiSessionId: session.aiSessionId, providerSessionId: session.providerSessionId, worktreeId: created.worktreeId, disposition: "started" as const } };
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

type WorkspaceServices = {
  resolve: () => Promise<ResolvedRepository>;
  worktrees: RepositoryWorktreeService;
  branches: RepositoryBranchService;
};

function workspaceCwd(worktreeRoot: string, source: ResolvedRepository) {
  return source.context.cwdRelativePath
    ? path.join(worktreeRoot, ...source.context.cwdRelativePath.split("/"))
    : worktreeRoot;
}

async function inspectAiSessionWorkspace(services: WorkspaceServices) {
  const state = await services.resolve();
  if (state.context.availability !== "available") {
    return RepositoryAiSessionWorkspaceSchema.parse({ availability: state.context.availability });
  }
  const [branches, worktrees] = await Promise.all([services.branches.list(), services.worktrees.list()]);
  const currentWorktree = worktrees.items.find((item) => item.isCurrent);
  const dirty = Boolean(currentWorktree?.dirty);
  const headChoice = state.context.head?.oid ? [{
    name: "HEAD",
    kind: "head" as const,
    current: false,
    currentFolderSelectable: false,
    worktreeSelectable: true,
    worktreeCheckout: "detached" as const,
  }] : [];
  return RepositoryAiSessionWorkspaceSchema.parse({
    availability: "available",
    currentBranch: state.context.head?.state === "branch" ? state.context.head.branch : undefined,
    dirty,
    branches: [...headChoice, ...branches.branches.filter((branch) => branch.kind === "local").map((branch) => {
      const checkedOutElsewhere = !branch.current && branch.checkedOutWorktreeIds.length > 0;
      const currentFolderReason = branch.current
        ? undefined
        : checkedOutElsewhere
          ? "branch-occupied" as const
          : undefined;
      return {
        name: branch.name,
        kind: "branch" as const,
        current: branch.current,
        currentFolderSelectable: branch.current || !currentFolderReason,
        worktreeSelectable: true,
        worktreeCheckout: branch.checkedOutWorktreeIds.length ? "detached" as const : "attached" as const,
        currentFolderReason,
      };
    })],
  });
}

async function createWorkspaceAiSession(
  services: WorkspaceServices,
  coordinator: AiSessionCreateCoordinator,
  body: z.infer<typeof RepositoryWorkspaceAiSessionCreateSchema>,
  idempotencyFingerprint: string,
) {
  const source = await requireRepository(services.resolve);
  // AI-session workspace selection is a ref intent, not an edit against a loaded
  // repository snapshot. The mutation services revalidate the selected ref and
  // worktree occupancy under their repository lock, so unrelated file changes
  // must not invalidate a prompt that took time to compose.
  const inspected = await inspectAiSessionWorkspace(services);
  // Compatibility for v0.0.21: the selection field remains named `branch` on
  // the wire, while the inspected choice kind is the authoritative ref model.
  const selected = inspected.branches.find((branch) => branch.name === body.gitSelection.branch);
  if (!selected || (selected.kind === "head" && body.gitSelection.mode !== "worktree")) {
    throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", "Selected local branch does not exist.", source);
  }

  let workspace = body.cwd.path;
  let createdWorktreeId: string | undefined;
  if (body.gitSelection.mode === "current-folder") {
    if (!selected.current) {
      if (!selected.currentFolderSelectable) {
        const code = selected.currentFolderReason === "branch-occupied" ? "REPOSITORY_BRANCH_OCCUPIED" : "REPOSITORY_WORKTREE_OCCUPIED";
        throw new RepositoryOperationError(code, `The selected branch cannot be checked out in the current folder: ${selected.currentFolderReason}.`, source);
      }
      await services.branches.checkoutForAiSession(selected.name);
    }
  } else {
    const created = await services.worktrees.createForAiSession({
      ref: selected.kind === "head" ? { type: "head" } : { type: "branch", name: selected.name },
      clientRequestId: body.clientRequestId,
    });
    createdWorktreeId = created.worktreeId;
    const worktrees = created.worktrees;
    const target = worktrees.items.find((item) => item.id === created.worktreeId);
    if (!target) throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "The selected branch worktree is unavailable.", await services.resolve());
    const root = await services.worktrees.resolveWorkspace(worktrees.repositoryContextId, target.id);
    workspace = workspaceCwd(root, source);
    try {
      if (!fs.statSync(workspace).isDirectory()) throw new Error("not a directory");
    } catch {
      if (createdWorktreeId) await compensateFailedWorktreeLaunch(services.worktrees, createdWorktreeId);
      throw new RepositoryOperationError("REPOSITORY_CWD_INACCESSIBLE", "The selected folder does not exist in the worktree.", await services.resolve());
    }
  }

  try {
    const { gitSelection: _gitSelection, cwd: _cwd, ...input } = body;
    return await coordinator.create({ ...input, cwd: workspace, idempotencyFingerprint });
  } catch (error) {
    if (createdWorktreeId) await compensateFailedWorktreeLaunch(services.worktrees, createdWorktreeId);
    throw error;
  }
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
  if (error && typeof error === "object" && "code" in error && error.code === "AI_SESSION_CREATE_REQUEST_CONFLICT") {
    return new RepositoryOperationError("REPOSITORY_CONFLICT", error instanceof Error ? error.message : "The request ID conflicts with an earlier session creation.");
  }
  return new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "AI session could not be started.");
}

async function fileMutation<T>(resolve: () => Promise<ResolvedRepository>, queue: RepositoryMutationQueue, workspaceRoots: string[], expectedSnapshotId: string, operation: (files: RepositoryFileService) => T) {
  const initial = await requireRepository(resolve);
  return queue.withWorktree(initial.worktreeRoot!, async () => {
    const state = await requireRepository(resolve);
    if (state.context.snapshotId !== expectedSnapshotId) throw new RepositoryOperationError("REPOSITORY_STATE_STALE", "Repository state changed after the file was loaded.", state);
    const file = operation(repositoryFiles(state, workspaceRoots));
    const current = await requireRepository(resolve);
    return { file, snapshotId: current.context.snapshotId, context: current.context, changes: current.changes };
  });
}

function repositoryFiles(state: ResolvedRepository, workspaceRoots: string[]) {
  const worktreeRoot = state.worktreeRoot!;
  const boundaryRoot = workspaceRoots
    .flatMap((root) => {
      try { return [fs.realpathSync(root)]; } catch { return []; }
    })
    .find((root) => withinRoot(worktreeRoot, root)) || worktreeRoot;
  return new RepositoryFileService(worktreeRoot, undefined, boundaryRoot);
}

function withinRoot(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function authorizedWorkspaceCwd(cwd: string, workspaceRoots: string[]) {
  let canonicalCwd: string;
  try {
    canonicalCwd = fs.realpathSync(cwd);
  } catch {
    throw new RepositoryOperationError("REPOSITORY_CWD_INACCESSIBLE", "The selected workspace folder is inaccessible.");
  }
  // In controlled mode the Control Plane resolves an authoritative node-local
  // folder ID into this runtime path. Standalone callers have no such trusted
  // identity boundary, so their paths must remain inside configured roots.
  if (process.env.TASK_HANDOFF_CONTROL_MODE === "controlled") return canonicalCwd;
  const authorized = workspaceRoots.some((root) => {
    try { return withinRoot(canonicalCwd, fs.realpathSync(root)); } catch { return false; }
  });
  if (!authorized) {
    throw new RepositoryOperationError("REPOSITORY_PATH_FORBIDDEN", "The selected workspace folder is outside the instance workspace boundary.");
  }
  return canonicalCwd;
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
