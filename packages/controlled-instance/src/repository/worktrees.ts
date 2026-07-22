import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RepositoryWorktrees } from "@task-handoff/protocol/repository";
import { repositoryWorktreeId, type ResolvedRepository } from "./context";
import { GitProcess, type GitProcessOptions } from "./git-process";
import { RepositoryMutationQueue } from "./mutation-queue";
import { RepositoryOperationError } from "./changes";

type SessionInventory = {
  aiSessions: () => Array<{ id: string; appSessionId?: string; cwd?: string; status?: string }>;
  appSessions: () => Array<{ id: string; workspace?: { cwd?: string }; status?: string }>;
};
type WorktreeRecord = {
  path: string;
  headOid?: string;
  branch?: string;
  detached: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
};
type InternalWorktree = RepositoryWorktrees["items"][number] & { canonicalPath: string };

export class ManagedWorktreeRegistry {
  root: string;
  private registryPath: string;
  private entries = new Map<string, { repositoryId: string; worktreeId: string; path: string; createdAt: string }>();

  constructor(root: string) {
    const resolvedRoot = path.resolve(root);
    this.root = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
    this.registryPath = path.join(this.root, "registry.json");
    this.load();
  }

  allocate(repositoryId: string, branchName: string) {
    this.ensureRoot();
    const repositoryDirectory = path.join(this.root, repositoryId.replace(/^repo:/, ""));
    fs.mkdirSync(repositoryDirectory, { recursive: true, mode: 0o700 });
    const slug = branchName.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "worktree";
    return path.join(repositoryDirectory, `${slug}-${crypto.randomUUID()}`);
  }

  add(repositoryId: string, worktreeId: string, worktreePath: string) {
    const canonicalPath = fs.realpathSync(worktreePath);
    if (!withinRoot(canonicalPath, this.root)) throw new Error("Managed worktree path is outside the managed root.");
    this.entries.set(worktreeId, { repositoryId, worktreeId, path: canonicalPath, createdAt: new Date().toISOString() });
    this.persist();
  }

  remove(worktreeId: string) {
    this.entries.delete(worktreeId);
    this.persist();
  }

  isManaged(repositoryId: string, worktreeId: string, worktreePath: string) {
    const entry = this.entries.get(worktreeId);
    return Boolean(entry && entry.repositoryId === repositoryId && path.resolve(entry.path) === path.resolve(worktreePath) && withinRoot(entry.path, this.root));
  }

  private load() {
    if (!fs.existsSync(this.registryPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
      const records = Array.isArray(parsed?.entries) ? parsed.entries : [];
      for (const item of records) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.repositoryId !== "string" || typeof item.worktreeId !== "string" || typeof item.path !== "string" || typeof item.createdAt !== "string") continue;
        const resolved = path.resolve(item.path);
        if (!withinRoot(resolved, this.root)) continue;
        this.entries.set(item.worktreeId, { repositoryId: item.repositoryId, worktreeId: item.worktreeId, path: resolved, createdAt: item.createdAt });
      }
    } catch {}
  }

  private persist() {
    this.ensureRoot();
    const tempPath = `${this.registryPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, this.registryPath);
  }

  private ensureRoot() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const canonicalRoot = fs.realpathSync(this.root);
    if (canonicalRoot === this.root) return;
    this.root = canonicalRoot;
    this.registryPath = path.join(this.root, "registry.json");
  }
}

export class RepositoryWorktreeService {
  private readonly workspaceRoots: string[];

  constructor(
    private readonly resolve: () => Promise<ResolvedRepository>,
    private readonly registry: ManagedWorktreeRegistry,
    private readonly sessions: SessionInventory,
    workspaceRoots: string[],
    private readonly queue = new RepositoryMutationQueue(),
    private readonly gitOptions: GitProcessOptions = {},
  ) {
    this.workspaceRoots = workspaceRoots.flatMap((root) => {
      try { return [fs.realpathSync(root)]; } catch { return []; }
    });
  }

  async list(): Promise<RepositoryWorktrees> {
    const state = await this.requireAvailable();
    return this.listFromState(state);
  }

  async create(request:
    | { mode: "new-branch"; branchName: string; startRef: string; expectedSnapshotId: string }
    | { mode: "existing-branch"; branchName: string; expectedSnapshotId: string },
  ) {
    const initial = await this.requireAvailable();
    return this.queue.withRepository(initial.gitCommonDir!, async () => {
      const state = await this.requireAvailable();
      if (state.context.snapshotId !== request.expectedSnapshotId) throw new RepositoryOperationError("REPOSITORY_STATE_STALE", "Repository state changed before worktree creation.", state);
      const current = await this.listFromStateInternal(state);
      if (current.some((item) => item.head.branch === request.branchName)) {
        throw new RepositoryOperationError("REPOSITORY_BRANCH_OCCUPIED", "Branch is already checked out in another worktree.", state);
      }
      const git = new GitProcess(state.worktreeRoot!, this.gitOptions);
      const destination = this.registry.allocate(state.context.repositoryId!, request.branchName);
      let added = false;
      try {
        if (request.mode === "new-branch") {
          const startOid = (await git.run("rev-parse", ["--verify", "--end-of-options", `${request.startRef}^{commit}`])).stdout.trim();
          await git.run("worktree", ["add", "-b", request.branchName, destination, startOid]);
        } else {
          await git.run("rev-parse", ["--verify", "--end-of-options", `refs/heads/${request.branchName}^{commit}`]);
          await git.run("worktree", ["add", destination, request.branchName]);
        }
        added = true;
        const canonicalPath = fs.realpathSync(destination);
        const worktreeId = repositoryWorktreeId(state.context.repositoryId!, canonicalPath);
        this.registry.add(state.context.repositoryId!, worktreeId, canonicalPath);
        return { worktreeId, worktrees: await this.listFromState(await this.requireAvailable()) };
      } catch (error) {
        if (added) {
          try { await git.run("worktree", ["remove", destination]); } catch {}
        }
        try { fs.rmSync(destination, { recursive: true }); } catch {}
        if (error instanceof RepositoryOperationError) throw error;
        throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "Git could not create the worktree.", await this.resolve());
      }
    });
  }

  async remove(request: { worktreeId: string; expectedSnapshotId: string; confirm: true }) {
    const initial = await this.requireAvailable();
    const initialTarget = (await this.listFromStateInternal(initial)).find((item) => item.id === request.worktreeId);
    if (!initialTarget) throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "Worktree no longer exists.", initial);
    return this.queue.withRepositoryAndWorktree(initial.gitCommonDir!, initialTarget.canonicalPath, async () => {
      const state = await this.requireAvailable();
      const list = await this.listFromState(state);
      if (list.snapshotId !== request.expectedSnapshotId) throw new RepositoryOperationError("REPOSITORY_STATE_STALE", "Worktree state changed before removal.", state);
      const internal = await this.listFromStateInternal(state);
      const target = internal.find((item) => item.id === request.worktreeId);
      if (!target) throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "Worktree no longer exists.", state);
      if (!target.canRemove) throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", `Worktree cannot be removed: ${target.removeBlockers.join(", ")}.`, state);
      try {
        await new GitProcess(state.worktreeRoot!, this.gitOptions).run("worktree", ["remove", target.canonicalPath]);
        this.registry.remove(target.id);
        return { removedWorktreeId: target.id, branchRetained: true, worktrees: await this.listFromState(await this.requireAvailable()) };
      } catch (error) {
        if (error instanceof RepositoryOperationError) throw error;
        throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "Git could not remove the worktree.", await this.resolve());
      }
    });
  }

  async resolveWorkspace(repositoryContextId: string, worktreeId: string) {
    const state = await this.requireAvailable();
    if (state.context.repositoryContextId !== repositoryContextId) throw new RepositoryOperationError("REPOSITORY_STATE_STALE", "Repository context is stale.", state);
    const target = (await this.listFromStateInternal(state)).find((item) => item.id === worktreeId);
    if (!target) throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "Worktree no longer exists.", state);
    if (!target.canCreateAiSession) throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", `Worktree cannot host a new session: ${target.createAiSessionBlockers.join(", ")}.`, state);
    try {
      const canonicalPath = fs.realpathSync(target.canonicalPath);
      if (!fs.statSync(canonicalPath).isDirectory()) throw new Error("not a directory");
      return canonicalPath;
    } catch {
      throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "Worktree path is no longer accessible.", await this.resolve());
    }
  }

  private async listFromState(state: ResolvedRepository): Promise<RepositoryWorktrees> {
    const items = await this.listFromStateInternal(state);
    const publicItems = items.map(({ canonicalPath: _path, ...item }) => item);
    return {
      repositoryId: state.context.repositoryId!,
      repositoryContextId: state.context.repositoryContextId!,
      snapshotId: hashId("worktrees", JSON.stringify(publicItems)),
      items: publicItems,
    };
  }

  private async listFromStateInternal(state: ResolvedRepository): Promise<InternalWorktree[]> {
    const output = (await new GitProcess(state.worktreeRoot!, this.gitOptions).run("worktree", ["list", "--porcelain", "-z"])).stdout;
    const records = parseWorktreePorcelain(output);
    return Promise.all(records.map(async (record, index) => {
      const canonicalPath = canonicalWorktreePath(record.path);
      const id = repositoryWorktreeId(state.context.repositoryId!, canonicalPath);
      const managed = this.registry.isManaged(state.context.repositoryId!, id, canonicalPath);
      const current = canonicalPath === state.worktreeRoot;
      const authorized = current || managed || this.workspaceRoots.some((root) => withinRoot(canonicalPath, root));
      const accessible = authorized && fs.existsSync(canonicalPath);
      const dirty = accessible && !record.prunable ? await isDirty(canonicalPath, this.gitOptions) : false;
      const activeAiSessions = activeSessionsForWorktree(this.sessions.aiSessions(), canonicalPath, (session) => session.cwd);
      const activeAiSessionIds = activeAiSessions.map((session) => session.id);
      const aiAppSessionIds = new Set(activeAiSessions.map((session) => session.appSessionId).filter((id): id is string => Boolean(id)));
      // An AI session and its host app session are one logical user session. Keep
      // the two public ID collections disjoint so consumers do not double-count it.
      const activeAppSessionIds = activeSessionsForWorktree(this.sessions.appSessions(), canonicalPath, (session) => session.workspace?.cwd)
        .filter((session) => !aiAppSessionIds.has(session.id))
        .map((session) => session.id);
      const createAiSessionBlockers: RepositoryWorktrees["items"][number]["createAiSessionBlockers"] = [];
      if (!authorized) createAiSessionBlockers.push("outside-workspace-roots");
      if (!accessible) createAiSessionBlockers.push("path-inaccessible");
      if (record.locked) createAiSessionBlockers.push("locked");
      if (record.prunable) createAiSessionBlockers.push("prunable");
      const removeBlockers: RepositoryWorktrees["items"][number]["removeBlockers"] = [];
      if (index === 0) removeBlockers.push("main-worktree");
      if (!managed) removeBlockers.push("external-worktree");
      if (!authorized) removeBlockers.push("outside-workspace-roots");
      if (!accessible) removeBlockers.push("path-inaccessible");
      if (dirty) removeBlockers.push("dirty");
      if (record.locked) removeBlockers.push("locked");
      if (record.prunable) removeBlockers.push("prunable");
      if (activeAiSessionIds.length || activeAppSessionIds.length) removeBlockers.push("session-occupied");
      const head = record.detached
        ? { state: "detached" as const, oid: record.headOid }
        : record.headOid
          ? { state: "branch" as const, oid: record.headOid, branch: record.branch }
          : { state: "unborn" as const, branch: record.branch };
      return {
        id,
        canonicalPath,
        isCurrent: current,
        isMain: index === 0,
        managed,
        head,
        dirty,
        locked: record.locked,
        lockReason: record.lockReason,
        prunable: record.prunable,
        activeAiSessionIds,
        activeAppSessionIds,
        canCreateAiSession: createAiSessionBlockers.length === 0,
        canRemove: removeBlockers.length === 0,
        createAiSessionBlockers,
        removeBlockers,
      };
    }));
  }

  private async requireAvailable() {
    const state = await this.resolve();
    if (state.context.availability !== "available" || !state.worktreeRoot || !state.gitCommonDir || !state.context.repositoryId || !state.context.repositoryContextId) {
      throw new RepositoryOperationError("REPOSITORY_NOT_WORKTREE", "Repository is unavailable.", state);
    }
    return state;
  }
}

export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current) records.push(current);
      current = undefined;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: field.slice(9), detached: false, locked: false, prunable: false };
    } else if (current && field.startsWith("HEAD ")) current.headOid = field.slice(5);
    else if (current && field.startsWith("branch refs/heads/")) current.branch = field.slice(18);
    else if (current && field === "detached") current.detached = true;
    else if (current && field.startsWith("locked")) {
      current.locked = true;
      current.lockReason = field.slice(6).trim() || undefined;
    } else if (current && field.startsWith("prunable")) current.prunable = true;
  }
  if (current) records.push(current);
  return records;
}

async function isDirty(worktreePath: string, gitOptions: GitProcessOptions) {
  try {
    return Boolean((await new GitProcess(worktreePath, gitOptions).run("status", ["--porcelain=v2", "-z", "--untracked-files=all"])).stdout);
  } catch {
    return false;
  }
}

function activeSessionsForWorktree<T extends { id: string; status?: string }>(sessions: T[], worktreePath: string, cwd: (session: T) => string | undefined) {
  return sessions.filter((session) => {
    if (["stopped", "exited", "failed", "closed", "terminated", "completed"].includes(session.status || "")) return false;
    const value = cwd(session);
    if (!value) return false;
    try { return withinRoot(fs.realpathSync(value), worktreePath); } catch { return false; }
  });
}

function canonicalWorktreePath(value: string) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function withinRoot(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hashId(prefix: string, value: string) {
  return `${prefix}:${crypto.createHash("sha256").update(value).digest("hex")}`;
}
