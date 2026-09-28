import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AiSessionLifecycle } from "@task-handoff/protocol/ai-sessions";
import type { AppSessionStatus } from "@task-handoff/protocol/app-sessions";
import type { RepositoryMoveWorktreeBlocker, RepositoryWorktreeBlocker, RepositoryWorktrees } from "@task-handoff/protocol/repository";
import { changeScopes, parsePorcelainV2, repositoryChangeSummary, repositoryWorktreeId, type ResolvedRepository } from "./context";
import { GitProcess, type GitProcessOptions } from "./git-process";
import { RepositoryMutationQueue } from "./mutation-queue";
import { RepositoryOperationError } from "./changes";

type SessionInventory = {
  aiSessions: () => Array<{ id: string; appSessionId?: string; cwd?: string; status?: AiSessionLifecycle }>;
  appSessions: () => Array<{ id: string; workspace?: { cwd?: string }; status?: AppSessionStatus }>;
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
type InternalWorktree = RepositoryWorktrees["items"][number] & {
  canonicalPath: string;
  // Sessions that are running in the worktree right now. Removal hazards keep every live
  // session, but an in-place rewrite is only unsafe for sessions that are already running.
  hostsRunningSession: boolean;
};
type ManagedWorktreeIntent = {
  requestId?: string;
  ref: { type: "head" } | { type: "branch"; name: string };
  resolvedOid: string;
  checkout: "attached" | "detached";
};
type ManagedWorktreeEntry = {
  repositoryId: string;
  worktreeId: string;
  path: string;
  createdAt: string;
  generationId: string;
  state: "preparing" | "ready" | "removing" | "quarantined";
  intent?: ManagedWorktreeIntent;
  legacy?: boolean;
};

const MANAGED_WORKTREE_REGISTRY_VERSION = 2;
const WORKTREE_STATUS_CONCURRENCY = 8;
const WORKTREE_GENERATION_MARKER = "task-handoff-generation";

// Removal blockers that also forbid adopting the branch in the main worktree.
// `dirty` is deliberately absent: a move carries the target's changes instead of refusing.
const MOVE_BLOCKERS_FROM_REMOVE = [
  "main-worktree",
  "outside-workspace-roots",
  "path-inaccessible",
  "locked",
  "prunable",
  "session-occupied",
] as const satisfies readonly RepositoryWorktreeBlocker[];

export class ManagedWorktreeRegistry {
  root: string;
  private registryPath: string;
  private entries = new Map<string, ManagedWorktreeEntry>();

  constructor(root: string) {
    const resolvedRoot = path.resolve(root);
    this.root = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
    this.registryPath = path.join(this.root, "registry.json");
    this.load();
  }

  allocate(repositoryId: string, branchName: string, allocationKey?: string) {
    this.ensureRoot();
    const repositoryDirectory = path.join(this.root, repositoryId.replace(/^repo:/, ""));
    fs.mkdirSync(repositoryDirectory, { recursive: true, mode: 0o700 });
    const slug = branchName.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "worktree";
    const suffix = allocationKey
      ? crypto.createHash("sha256").update(allocationKey).digest("hex").slice(0, 24)
      : crypto.randomUUID();
    return path.join(repositoryDirectory, `${slug}-${suffix}`);
  }

  prepare(repositoryId: string, worktreeId: string, worktreePath: string, intent: ManagedWorktreeIntent) {
    const resolvedPath = path.resolve(worktreePath);
    if (!withinRoot(resolvedPath, this.root)) throw new Error("Managed worktree path is outside the managed root.");
    const existing = this.entries.get(worktreeId);
    if (existing && (existing.repositoryId !== repositoryId || path.resolve(existing.path) !== resolvedPath)) {
      throw new Error("Managed worktree identity is already assigned to another path.");
    }
    this.entries.set(worktreeId, {
      repositoryId,
      worktreeId,
      path: resolvedPath,
      createdAt: existing?.createdAt || new Date().toISOString(),
      generationId: existing?.generationId || crypto.randomUUID(),
      state: "preparing",
      intent,
    });
    this.persist();
  }

  markReady(worktreeId: string, worktreePath: string, gitCommonDir: string) {
    const entry = this.requireEntry(worktreeId, worktreePath);
    writeGenerationMarker(worktreePath, gitCommonDir, entry.generationId);
    entry.path = fs.realpathSync(worktreePath);
    entry.state = "ready";
    entry.legacy = false;
    this.persist();
  }

  abortPreparation(worktreeId: string) {
    const entry = this.entries.get(worktreeId);
    if (!entry || entry.state !== "preparing") return;
    this.entries.delete(worktreeId);
    this.persist();
  }

  beginRemove(worktreeId: string, worktreePath: string) {
    const entry = this.requireEntry(worktreeId, worktreePath);
    if (entry.state !== "ready") throw new Error("Managed worktree is not ready for removal.");
    entry.state = "removing";
    this.persist();
  }

  cancelRemove(worktreeId: string) {
    const entry = this.entries.get(worktreeId);
    if (!entry || entry.state !== "removing") return;
    entry.state = "ready";
    this.persist();
  }

  completeRemove(worktreeId: string) {
    if (!this.entries.delete(worktreeId)) return;
    this.persist();
  }

  matchesCreation(worktreeId: string, worktreePath: string, request: { requestId: string; ref: ManagedWorktreeIntent["ref"] }) {
    const entry = this.entries.get(worktreeId);
    return Boolean(
      entry
      && entry.state === "ready"
      && path.resolve(entry.path) === path.resolve(worktreePath)
      && entry.intent?.requestId === request.requestId
      && sameManagedRef(entry.intent.ref, request.ref),
    );
  }

  reconcile(repositoryId: string, gitCommonDir: string, records: WorktreeRecord[]) {
    const recordsById = new Map(records.map((record) => {
      const canonicalPath = canonicalWorktreePath(record.path);
      return [repositoryWorktreeId(repositoryId, canonicalPath), { ...record, path: canonicalPath }] as const;
    }));
    const managed = new Set<string>();
    let changed = false;
    for (const entry of [...this.entries.values()]) {
      if (entry.repositoryId !== repositoryId) continue;
      const record = recordsById.get(entry.worktreeId);
      if (!record || path.resolve(record.path) !== path.resolve(entry.path)) {
        if (entry.state === "preparing" && fs.existsSync(entry.path)) {
          entry.state = "quarantined";
          changed = true;
        } else {
          this.entries.delete(entry.worktreeId);
          changed = true;
        }
        continue;
      }

      const marker = readGenerationMarker(record.path, gitCommonDir);
      if (marker === entry.generationId) {
        if (entry.state === "preparing" || entry.state === "removing") {
          entry.state = "ready";
          changed = true;
        }
        if (entry.state === "ready") managed.add(entry.worktreeId);
        continue;
      }

      // Compatibility for v0.0.21: an older controlled instance can read the
      // additive v2 entry fields but rewrites the registry as v1. The Git admin
      // marker survives that downgrade and remains the strongest identity, so
      // adopt it when the v1 record still proves the same repository and path.
      if (entry.legacy === true && marker !== undefined) {
        entry.generationId = marker;
        entry.state = "ready";
        entry.legacy = false;
        managed.add(entry.worktreeId);
        changed = true;
        continue;
      }

      const canRecover = marker === undefined && (
        entry.legacy === true
        || (entry.state === "preparing" && entry.intent && recordMatchesIntent(record, entry.intent))
      );
      if (canRecover) {
        try {
          writeGenerationMarker(record.path, gitCommonDir, entry.generationId);
          entry.path = record.path;
          entry.state = "ready";
          entry.legacy = false;
          managed.add(entry.worktreeId);
          changed = true;
          continue;
        } catch {}
      }
      if (entry.state !== "quarantined") {
        entry.state = "quarantined";
        changed = true;
      }
    }
    if (changed) this.persist();
    return managed;
  }

  private load() {
    if (!fs.existsSync(this.registryPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
      if (parsed?.version !== 1 && parsed?.version !== MANAGED_WORKTREE_REGISTRY_VERSION) {
        throw new Error(`Unsupported managed worktree registry version: ${String(parsed?.version)}`);
      }
      const records = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const legacyRegistry = parsed?.version === 1;
      for (const item of records) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.repositoryId !== "string" || typeof item.worktreeId !== "string" || typeof item.path !== "string" || typeof item.createdAt !== "string") continue;
        const resolved = path.resolve(item.path);
        if (!withinRoot(resolved, this.root)) continue;
        const intent = sanitizeManagedWorktreeIntent(item.intent);
        const state = ["preparing", "ready", "removing", "quarantined"].includes(item.state) ? item.state : "ready";
        this.entries.set(item.worktreeId, {
          repositoryId: item.repositoryId,
          worktreeId: item.worktreeId,
          path: resolved,
          createdAt: item.createdAt,
          generationId: typeof item.generationId === "string" && /^[0-9a-f-]{36}$/i.test(item.generationId) ? item.generationId : crypto.randomUUID(),
          state,
          ...(intent ? { intent } : {}),
          ...(legacyRegistry || item.legacy === true ? { legacy: true } : {}),
        });
      }
    } catch (error) {
      console.warn("[managed-worktrees] registry could not be loaded; managed ownership is unavailable", error instanceof Error ? error.message : String(error));
    }
  }

  private persist() {
    this.ensureRoot();
    const tempPath = `${this.registryPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({ version: MANAGED_WORKTREE_REGISTRY_VERSION, entries: [...this.entries.values()] }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, this.registryPath);
  }

  private requireEntry(worktreeId: string, worktreePath: string) {
    const entry = this.entries.get(worktreeId);
    if (!entry || path.resolve(entry.path) !== path.resolve(worktreePath) || !withinRoot(entry.path, this.root)) {
      throw new Error("Managed worktree ownership could not be verified.");
    }
    return entry;
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
    return this.listForState(state);
  }

  listForState(state: ResolvedRepository): Promise<RepositoryWorktrees> {
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
      const occupied = hasAttachedBranch(current, request.branchName);
      // A new branch name must be free, but an existing branch that another worktree already
      // has checked out stays usable: the new worktree adopts the same commit with a detached HEAD.
      if (request.mode === "new-branch" && occupied) {
        throw new RepositoryOperationError("REPOSITORY_BRANCH_OCCUPIED", "Branch is already checked out in another worktree.", state);
      }
      const checkout = request.mode === "existing-branch" && occupied ? "detached" as const : "attached" as const;
      const git = new GitProcess(state.worktreeRoot!, this.gitOptions);
      const resolvedOid = await resolveCommitOid(git, request.mode === "new-branch" ? request.startRef : `refs/heads/${request.branchName}`);
      if (!resolvedOid) {
        throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", request.mode === "new-branch"
          ? "Selected Git start ref no longer exists."
          : "Selected Git branch no longer exists.", state);
      }
      const destination = this.registry.allocate(state.context.repositoryId!, request.branchName);
      const worktreeId = repositoryWorktreeId(state.context.repositoryId!, path.resolve(destination));
      let added = false;
      try {
        this.registry.prepare(state.context.repositoryId!, worktreeId, destination, {
          ref: { type: "branch", name: request.branchName },
          resolvedOid,
          checkout,
        });
        if (request.mode === "new-branch") {
          await git.run("worktree", ["add", "-b", request.branchName, destination, resolvedOid]);
        } else if (checkout === "detached") {
          await git.run("worktree", ["add", "--detach", destination, resolvedOid]);
        } else {
          await git.run("worktree", ["add", destination, request.branchName]);
        }
        added = true;
        const canonicalPath = fs.realpathSync(destination);
        this.registry.markReady(worktreeId, canonicalPath, state.gitCommonDir!);
        return { worktreeId, worktrees: await this.listFromState(await this.requireAvailable()) };
      } catch (error) {
        let removed = !added;
        if (added) {
          try {
            await git.run("worktree", ["remove", destination]);
            removed = true;
          } catch {}
        }
        if (removed) {
          try { fs.rmSync(destination, { recursive: true }); } catch {}
          this.registry.abortPreparation(worktreeId);
        }
        if (error instanceof RepositoryOperationError) throw error;
        throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "Git could not create the worktree.", await this.resolve());
      }
    });
  }

  async createForAiSession(request: { ref: { type: "head" } | { type: "branch"; name: string }; clientRequestId: string }) {
    const initial = await this.requireAvailable();
    return this.queue.withRepository(initial.gitCommonDir!, async () => {
      const state = await this.requireAvailable();
      const git = new GitProcess(state.worktreeRoot!, this.gitOptions);
      const refLabel = request.ref.type === "head" ? "HEAD" : request.ref.name;
      const destination = this.registry.allocate(state.context.repositoryId!, refLabel, request.clientRequestId);
      const worktreeId = repositoryWorktreeId(state.context.repositoryId!, path.resolve(destination));
      const current = await this.listFromStateInternal(state);
      const existing = current.find((item) => item.canonicalPath === path.resolve(destination));
      if (existing) {
        if (!existing.managed || !this.registry.matchesCreation(existing.id, existing.canonicalPath, { requestId: request.clientRequestId, ref: request.ref })) {
          throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", "The worktree destination belongs to another creation request.", state);
        }
        if (!existing.canCreateAiSession) {
          throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", `Worktree cannot host an AI session: ${existing.createAiSessionBlockers.join(", ")}.`, state);
        }
        return { worktreeId: existing.id, worktrees: await this.listFromState(state) };
      }
      if (fs.existsSync(destination)) {
        throw new RepositoryOperationError(
          "REPOSITORY_WORKTREE_UNSAFE",
          "The managed worktree destination already exists but is not registered as a Git worktree.",
          state,
        );
      }

      const branchName = request.ref.type === "branch" ? request.ref.name : undefined;
      const oid = await resolveCommitOid(git, branchName !== undefined ? `refs/heads/${branchName}` : "HEAD");
      if (!oid) throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", "Selected Git revision no longer exists.", await this.resolve());
      const branchOccupied = branchName !== undefined && hasAttachedBranch(current, branchName);
      const checkout = branchName !== undefined && !branchOccupied ? "attached" as const : "detached" as const;
      let added = false;
      try {
        this.registry.prepare(state.context.repositoryId!, worktreeId, destination, {
          requestId: request.clientRequestId,
          ref: request.ref,
          resolvedOid: oid,
          checkout,
        });
        if (checkout === "attached" && branchName !== undefined) {
          await git.run("worktree", ["add", destination, branchName]);
        } else {
          await git.run("worktree", ["add", "--detach", destination, oid]);
        }
        added = true;
        const canonicalPath = fs.realpathSync(destination);
        this.registry.markReady(worktreeId, canonicalPath, state.gitCommonDir!);
        return { worktreeId, worktrees: await this.listFromState(await this.requireAvailable()) };
      } catch (error) {
        let removed = !added;
        if (added) {
          try {
            await git.run("worktree", ["remove", destination]);
            removed = true;
          } catch {}
        }
        if (removed) {
          try { fs.rmSync(destination, { recursive: true }); } catch {}
          this.registry.abortPreparation(worktreeId);
        }
        if (error instanceof RepositoryOperationError) throw error;
        throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "Git could not create the AI session worktree.", await this.resolve());
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
      if (target.isCurrent) throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", "The current worktree cannot be removed.", state);
      if (!target.canRemove) throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", `Worktree cannot be removed: ${target.removeBlockers.join(", ")}.`, state);
      try {
        if (target.managed) this.registry.beginRemove(target.id, target.canonicalPath);
        await new GitProcess(state.worktreeRoot!, this.gitOptions).run("worktree", ["remove", target.canonicalPath]);
        if (target.managed) this.registry.completeRemove(target.id);
        return { removedWorktreeId: target.id, branchRetained: true, worktrees: await this.listFromState(await this.requireAvailable()) };
      } catch (error) {
        if (target.managed) this.registry.cancelRemove(target.id);
        if (error instanceof RepositoryOperationError) throw error;
        throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "Git could not remove the worktree.", await this.resolve());
      }
    });
  }

  async moveToMainPreflight(request: { worktreeId: string }) {
    const state = await this.requireAvailable();
    const internal = await this.listFromStateInternal(state);
    const target = internal.find((item) => item.id === request.worktreeId);
    if (!target) throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "Worktree no longer exists.", state);
    const main = internal.find((item) => item.isMain);
    if (!main) throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "The main worktree could not be resolved.", state);
    const blockers = moveWorktreeBlockers(target, main);
    return {
      worktreeId: target.id,
      canMove: blockers.length === 0,
      blockers,
      ...(target.head.state === "branch" && target.head.branch ? { targetBranch: target.head.branch } : {}),
      targetChanges: await worktreeChangeSummary(target, this.gitOptions),
      mainWorktreeId: main.id,
      ...(main.head.state === "branch" && main.head.branch ? { mainBranch: main.head.branch } : {}),
    };
  }

  /**
   * Make the main worktree adopt the target worktree's branch, carrying its
   * uncommitted changes, then delete the target worktree directory. The target's
   * branch and commits survive; the main worktree's own changes never move.
   */
  async moveToMain(request: { worktreeId: string; expectedSnapshotId: string; confirm: true }) {
    const initial = await this.requireAvailable();
    const initialInternal = await this.listFromStateInternal(initial);
    const initialTarget = initialInternal.find((item) => item.id === request.worktreeId);
    if (!initialTarget) throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "Worktree no longer exists.", initial);
    const initialMain = initialInternal.find((item) => item.isMain);
    if (!initialMain) throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "The main worktree could not be resolved.", initial);
    return this.queue.withRepositoryAndWorktrees(initial.gitCommonDir!, [initialTarget.canonicalPath, initialMain.canonicalPath], async () => {
      const state = await this.requireAvailable();
      const list = await this.listFromState(state);
      if (list.snapshotId !== request.expectedSnapshotId) throw new RepositoryOperationError("REPOSITORY_STATE_STALE", "Worktree state changed before the move.", state);
      const internal = await this.listFromStateInternal(state);
      const target = internal.find((item) => item.id === request.worktreeId);
      if (!target) throw new RepositoryOperationError("REPOSITORY_WORKTREE_NOT_FOUND", "Worktree no longer exists.", state);
      const main = internal.find((item) => item.isMain);
      if (!main || main.canonicalPath !== initialMain.canonicalPath) throw new RepositoryOperationError("REPOSITORY_STATE_STALE", "The main worktree moved while the repository was locked.", state);
      const blockers = moveWorktreeBlockers(target, main);
      if (blockers.length) {
        throw blockers.includes("main-dirty")
          ? new RepositoryOperationError("REPOSITORY_MAIN_DIRTY", "The main worktree has uncommitted changes. Commit or stash them there before moving this worktree.", state)
          : new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", `Worktree cannot be moved into the main worktree: ${blockers.join(", ")}.`, state);
      }
      const branch = target.head.state === "branch" ? target.head.branch : undefined;
      const previousHead = target.head.oid;
      if (!branch || !previousHead) throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", "The worktree HEAD is not an adoptable branch.", state);
      const carriedChanges = target.dirty;
      const expectedChanges = carriedChanges ? await worktreeChangeSignature(target.canonicalPath, this.gitOptions) : "";
      const targetGit = new GitProcess(target.canonicalPath, this.gitOptions);
      const mainGit = new GitProcess(main.canonicalPath, this.gitOptions);
      let stashed = false;
      // Restoring the worktree is always possible before the directory is removed:
      // its branch is released only after the stash entry is safely recorded.
      const restoreTargetWorktree = async () => {
        const failures: string[] = [];
        try { await targetGit.run("checkout", ["--quiet", branch]); } catch { failures.push("branch checkout"); }
        if (stashed) {
          try { await targetGit.run("stash", ["pop", "--index", "--quiet"]); } catch { failures.push("stash restore"); }
        }
        return failures;
      };
      try {
        if (carriedChanges) {
          await targetGit.run("stash", ["push", "--include-untracked", "--quiet", "--message", `task-handoff move-to-main: ${branch}`]);
          stashed = true;
        }
        await targetGit.run("checkout", ["--detach", "--quiet"]);
      } catch {
        const failures = await restoreTargetWorktree();
        throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", failures.length
          ? `The worktree could not be restored (${failures.join(", ")}). Recover it from the retained stash entry before retrying.`
          : "Git could not release the branch from the worktree.", await this.resolve());
      }
      try {
        await mainGit.run("checkout", ["--quiet", branch]);
      } catch {
        const failures = await restoreTargetWorktree();
        throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", failures.length
          ? `The main worktree could not adopt the branch, and the worktree could not be restored (${failures.join(", ")}). Recover it from the retained stash entry before retrying.`
          : "The main worktree could not adopt the branch.", await this.resolve());
      }
      if (stashed) {
        try {
          await mainGit.run("stash", ["pop", "--index", "--quiet"]);
        } catch {
          throw new RepositoryOperationError("REPOSITORY_MOVE_CONFLICT", "The carried changes could not be applied to the main worktree. Resolve them there and drop the retained stash entry; the worktree was left in place.", await this.resolve());
        }
        if (await worktreeChangeSignature(main.canonicalPath, this.gitOptions) !== expectedChanges) {
          throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", "The carried changes do not match the recorded worktree state. Nothing was removed.", await this.resolve());
        }
      }
      try {
        if (target.managed) this.registry.beginRemove(target.id, target.canonicalPath);
        await new GitProcess(state.worktreeRoot!, this.gitOptions).run("worktree", ["remove", target.canonicalPath]);
        if (target.managed) this.registry.completeRemove(target.id);
      } catch {
        if (target.managed) this.registry.cancelRemove(target.id);
        throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "The branch and its changes are now in the main worktree, but the worktree directory could not be removed.", await this.resolve());
      }
      return {
        movedWorktreeId: target.id,
        adoptedBranch: branch,
        previousHead,
        carriedChanges: stashed,
        worktrees: await this.listFromState(await this.requireAvailable()),
      };
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
    const publicItems = items.map(({ canonicalPath: _path, hostsRunningSession: _running, ...item }) => item);
    return {
      repositoryId: state.context.repositoryId!,
      repositoryContextId: state.context.repositoryContextId!,
      snapshotId: hashId("worktrees", JSON.stringify(publicItems)),
      items: publicItems,
    };
  }

  private async listFromStateInternal(state: ResolvedRepository): Promise<InternalWorktree[]> {
    const output = (await new GitProcess(state.worktreeRoot!, this.gitOptions).run("worktree", ["list", "--porcelain", "-z"])).stdout;
    const records = parseWorktreePorcelain(output).map((record) => ({ ...record, path: canonicalWorktreePath(record.path) }));
    const managedIds = this.registry.reconcile(state.context.repositoryId!, state.gitCommonDir!, records);
    return mapWithConcurrency(records, WORKTREE_STATUS_CONCURRENCY, async (record, index) => {
      const canonicalPath = canonicalWorktreePath(record.path);
      const id = repositoryWorktreeId(state.context.repositoryId!, canonicalPath);
      const managed = managedIds.has(id);
      const current = canonicalPath === state.worktreeRoot;
      const authorized = current || managed || this.workspaceRoots.some((root) => withinRoot(canonicalPath, root));
      const accessible = authorized && fs.existsSync(canonicalPath);
      const dirty = accessible && !record.prunable ? await isDirty(canonicalPath, this.gitOptions) : false;
      const aiSessionsInWorktree = sessionsInWorktree(this.sessions.aiSessions(), canonicalPath, (session) => session.cwd);
      const activeAiSessions = aiSessionsInWorktree.filter(isLiveSession);
      const activeAiSessionIds = activeAiSessions.map((session) => session.id);
      const aiAppSessionIds = new Set(activeAiSessions.map((session) => session.appSessionId).filter((id): id is string => Boolean(id)));
      // An AI session and its host app session are one logical user session. Keep
      // the two public ID collections disjoint so consumers do not double-count it.
      const appSessionsInWorktree = sessionsInWorktree(this.sessions.appSessions(), canonicalPath, (session) => session.workspace?.cwd);
      const activeAppSessionIds = appSessionsInWorktree
        .filter((session) => isLiveSession(session) && !aiAppSessionIds.has(session.id))
        .map((session) => session.id);
      // A move only rewrites the main worktree in place, so it is blocked by sessions that
      // are running there rather than by every session that happens to live there.
      const hostsRunningSession = aiSessionsInWorktree.some(isRunningAiSession)
        || appSessionsInWorktree.some((session) => !aiAppSessionIds.has(session.id) && isRunningAppSession(session));
      const createAiSessionBlockers: RepositoryWorktrees["items"][number]["createAiSessionBlockers"] = [];
      if (!authorized) createAiSessionBlockers.push("outside-workspace-roots");
      if (!accessible) createAiSessionBlockers.push("path-inaccessible");
      if (record.locked) createAiSessionBlockers.push("locked");
      if (record.prunable) createAiSessionBlockers.push("prunable");
      const removeBlockers: RepositoryWorktrees["items"][number]["removeBlockers"] = [];
      if (index === 0) removeBlockers.push("main-worktree");
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
        hostsRunningSession,
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
    });
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

async function worktreeChangeRecords(worktreePath: string, gitOptions: GitProcessOptions) {
  const output = (await new GitProcess(worktreePath, gitOptions).run("status", ["--porcelain=v2", "-z", "--untracked-files=all"])).stdout;
  return parsePorcelainV2(output).records;
}

async function isDirty(worktreePath: string, gitOptions: GitProcessOptions) {
  return (await worktreeChangeRecords(worktreePath, gitOptions)).length > 0;
}

async function resolveCommitOid(git: GitProcess, revision: string) {
  try {
    return (await git.run("rev-parse", ["--verify", "--end-of-options", `${revision}^{commit}`])).stdout.trim();
  } catch {
    return undefined;
  }
}

function hasAttachedBranch(worktrees: InternalWorktree[], branchName: string) {
  return worktrees.some((item) => item.head.state === "branch" && item.head.branch === branchName);
}

async function worktreeChangeSummary(target: InternalWorktree, gitOptions: GitProcessOptions) {
  // A prunable or inaccessible worktree has no readable changes to carry.
  if (target.prunable || !fs.existsSync(target.canonicalPath)) return { conflicts: 0, staged: 0, unstaged: 0, untracked: 0 };
  return repositoryChangeSummary(await worktreeChangeRecords(target.canonicalPath, gitOptions));
}

async function worktreeChangeSignature(worktreePath: string, gitOptions: GitProcessOptions) {
  const records = await worktreeChangeRecords(worktreePath, gitOptions);
  return records.flatMap((record) => changeScopes(record).map((scope) => `${scope}\u0000${record.path}`)).sort().join("\n");
}

function moveWorktreeBlockers(target: InternalWorktree, main: InternalWorktree): RepositoryMoveWorktreeBlocker[] {
  const blockers: RepositoryMoveWorktreeBlocker[] = [];
  if (main.dirty) blockers.push("main-dirty");
  // The move rewrites the main worktree's HEAD and working tree in place, so only a session
  // that is running there would write into files that changed underneath it.
  if (main.hostsRunningSession) blockers.push("main-session-occupied");
  blockers.push(...MOVE_BLOCKERS_FROM_REMOVE.filter((blocker) => target.removeBlockers.includes(blocker)));
  if (target.head.state === "detached") blockers.push("detached-head");
  else if (target.head.state === "unborn") blockers.push("unborn-head");
  return blockers;
}

function sessionsInWorktree<T extends { id: string }>(sessions: T[], worktreePath: string, cwd: (session: T) => string | undefined) {
  return sessions.filter((session) => {
    const value = cwd(session);
    if (!value) return false;
    try { return withinRoot(fs.realpathSync(value), worktreePath); }
    catch { return path.isAbsolute(value) && withinRoot(path.resolve(value), worktreePath); }
  });
}

// AI sessions report `failed` when they end and app sessions report the process exit
// statuses; anything else still holds a claim on the worktree directory.
const TERMINAL_SESSION_STATUSES = new Set<string>(["stopped", "exited", "failed", "closed", "terminated", "completed"]);

function isLiveSession(session: { status?: string }) {
  return !TERMINAL_SESSION_STATUSES.has(session.status || "");
}

// `waiting` is an in-flight turn parked on an approval, so it counts as running.
function isRunningAiSession(session: { status?: AiSessionLifecycle }) {
  return session.status === "running" || session.status === "waiting";
}

// The app runtime reports `running` only while a process is attached: sessions restored
// after a restart are rewritten to `exited`.
function isRunningAppSession(session: { status?: AppSessionStatus }) {
  return session.status === "running";
}

function sameManagedRef(left: ManagedWorktreeIntent["ref"], right: ManagedWorktreeIntent["ref"]) {
  return left.type === right.type && (left.type === "head" || (right.type === "branch" && left.name === right.name));
}

function recordMatchesIntent(record: WorktreeRecord, intent: ManagedWorktreeIntent) {
  if (record.prunable || !record.headOid) return false;
  if (intent.checkout === "detached") return record.detached && record.headOid === intent.resolvedOid;
  return !record.detached
    && intent.ref.type === "branch"
    && record.branch === intent.ref.name
    && record.headOid === intent.resolvedOid;
}

function sanitizeManagedWorktreeIntent(value: unknown): ManagedWorktreeIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const refValue = record.ref;
  if (!refValue || typeof refValue !== "object" || Array.isArray(refValue)) return undefined;
  const refRecord = refValue as Record<string, unknown>;
  const ref = refRecord.type === "head"
    ? { type: "head" as const }
    : refRecord.type === "branch" && typeof refRecord.name === "string" && refRecord.name
      ? { type: "branch" as const, name: refRecord.name }
      : undefined;
  if (!ref || typeof record.resolvedOid !== "string" || !/^[0-9a-f]{40,64}$/i.test(record.resolvedOid)) return undefined;
  if (record.checkout !== "attached" && record.checkout !== "detached") return undefined;
  if (record.requestId !== undefined && (typeof record.requestId !== "string" || !record.requestId)) return undefined;
  return {
    ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
    ref,
    resolvedOid: record.resolvedOid,
    checkout: record.checkout,
  };
}

function readGenerationMarker(worktreePath: string, gitCommonDir: string) {
  const adminDir = linkedWorktreeAdminDir(worktreePath, gitCommonDir);
  if (!adminDir) return undefined;
  try {
    const value = fs.readFileSync(path.join(adminDir, WORKTREE_GENERATION_MARKER), "utf8").trim();
    return /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeGenerationMarker(worktreePath: string, gitCommonDir: string, generationId: string) {
  const adminDir = linkedWorktreeAdminDir(worktreePath, gitCommonDir);
  if (!adminDir) throw new Error("Git linked-worktree ownership could not be verified.");
  const markerPath = path.join(adminDir, WORKTREE_GENERATION_MARKER);
  try {
    const existing = fs.readFileSync(markerPath, "utf8").trim();
    if (existing === generationId) return;
    throw new Error("Git linked-worktree generation belongs to another managed worktree.");
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  fs.writeFileSync(markerPath, `${generationId}\n`, { mode: 0o600, flag: "wx" });
}

function linkedWorktreeAdminDir(worktreePath: string, gitCommonDir: string) {
  const gitFilePath = path.join(worktreePath, ".git");
  const worktreesRoot = path.join(path.resolve(gitCommonDir), "worktrees");
  try {
    if (fs.statSync(gitFilePath).isFile()) {
      const gitFile = fs.readFileSync(gitFilePath, "utf8");
      const match = /^gitdir:\s*(.+)$/im.exec(gitFile);
      if (match?.[1]?.trim()) {
        const adminDir = path.resolve(worktreePath, match[1].trim());
        if (pathsEqual(path.dirname(adminDir), worktreesRoot) && adminDirPointsToWorktree(adminDir, gitFilePath)) return adminDir;
      }
    }
  } catch {}

  // A prunable worktree has lost its directory and `.git` file. Its Git admin
  // row and generation marker still survive, so use the authoritative backlink
  // instead of downgrading a known managed worktree to external ownership.
  try {
    for (const name of fs.readdirSync(worktreesRoot)) {
      const adminDir = path.join(worktreesRoot, name);
      if (adminDirPointsToWorktree(adminDir, gitFilePath)) return adminDir;
    }
  } catch {}
  return undefined;
}

function adminDirPointsToWorktree(adminDir: string, gitFilePath: string) {
  try {
    if (!fs.statSync(adminDir).isDirectory()) return false;
    const backlink = fs.readFileSync(path.join(adminDir, "gitdir"), "utf8").trim();
    const resolvedBacklink = path.resolve(adminDir, backlink);
    return pathsEqual(resolvedBacklink, path.resolve(gitFilePath));
  } catch {
    return false;
  }
}

function pathsEqual(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isMissingFileError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)));
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<U>) {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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
