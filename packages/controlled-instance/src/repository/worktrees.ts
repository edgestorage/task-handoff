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
      if (current.some((item) => item.head.branch === request.branchName)) {
        throw new RepositoryOperationError("REPOSITORY_BRANCH_OCCUPIED", "Branch is already checked out in another worktree.", state);
      }
      const git = new GitProcess(state.worktreeRoot!, this.gitOptions);
      const destination = this.registry.allocate(state.context.repositoryId!, request.branchName);
      const worktreeId = repositoryWorktreeId(state.context.repositoryId!, path.resolve(destination));
      let added = false;
      try {
        let resolvedOid: string;
        if (request.mode === "new-branch") {
          resolvedOid = (await git.run("rev-parse", ["--verify", "--end-of-options", `${request.startRef}^{commit}`])).stdout.trim();
          this.registry.prepare(state.context.repositoryId!, worktreeId, destination, {
            ref: { type: "branch", name: request.branchName },
            resolvedOid,
            checkout: "attached",
          });
          await git.run("worktree", ["add", "-b", request.branchName, destination, resolvedOid]);
        } else {
          resolvedOid = (await git.run("rev-parse", ["--verify", "--end-of-options", `refs/heads/${request.branchName}^{commit}`])).stdout.trim();
          this.registry.prepare(state.context.repositoryId!, worktreeId, destination, {
            ref: { type: "branch", name: request.branchName },
            resolvedOid,
            checkout: "attached",
          });
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

      const revision = request.ref.type === "head"
        ? "HEAD^{commit}"
        : `refs/heads/${request.ref.name}^{commit}`;
      let oid: string;
      try {
        oid = (await git.run("rev-parse", ["--verify", "--end-of-options", revision])).stdout.trim();
      } catch {
        throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", "Selected Git revision no longer exists.", await this.resolve());
      }
      const branchName = request.ref.type === "branch" ? request.ref.name : undefined;
      const branchOccupied = branchName !== undefined
        && current.some((item) => item.head.state === "branch" && item.head.branch === branchName);
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
      if (!target.canRemove) throw new RepositoryOperationError("REPOSITORY_WORKTREE_UNSAFE", `Worktree cannot be removed: ${target.removeBlockers.join(", ")}.`, state);
      try {
        this.registry.beginRemove(target.id, target.canonicalPath);
        await new GitProcess(state.worktreeRoot!, this.gitOptions).run("worktree", ["remove", target.canonicalPath]);
        this.registry.completeRemove(target.id);
        return { removedWorktreeId: target.id, branchRetained: true, worktrees: await this.listFromState(await this.requireAvailable()) };
      } catch (error) {
        this.registry.cancelRemove(target.id);
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

async function isDirty(worktreePath: string, gitOptions: GitProcessOptions) {
  return Boolean((await new GitProcess(worktreePath, gitOptions).run("status", ["--porcelain=v2", "-z", "--untracked-files=all"])).stdout);
}

function activeSessionsForWorktree<T extends { id: string; status?: string }>(sessions: T[], worktreePath: string, cwd: (session: T) => string | undefined) {
  return sessions.filter((session) => {
    if (["stopped", "exited", "failed", "closed", "terminated", "completed"].includes(session.status || "")) return false;
    const value = cwd(session);
    if (!value) return false;
    try { return withinRoot(fs.realpathSync(value), worktreePath); }
    catch { return path.isAbsolute(value) && withinRoot(path.resolve(value), worktreePath); }
  });
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
