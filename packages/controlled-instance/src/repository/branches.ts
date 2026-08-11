import type { RepositoryBranches, RepositoryContext } from "@task-handoff/protocol/repository";
import type { ResolvedRepository } from "./context";
import { GitProcess, GitProcessError, type GitProcessOptions } from "./git-process";
import { RepositoryMutationQueue } from "./mutation-queue";
import { RepositoryOperationError } from "./changes";
import type { RepositoryWorktreeService } from "./worktrees";

type BranchResult = { snapshotId: string; context: RepositoryContext; branches: RepositoryBranches };

export class RepositoryBranchService {
  constructor(
    private readonly resolve: () => Promise<ResolvedRepository>,
    private readonly worktrees: RepositoryWorktreeService,
    private readonly queue = new RepositoryMutationQueue(),
    private readonly gitOptions: GitProcessOptions = {},
  ) {}

  async list(): Promise<RepositoryBranches> {
    const state = await this.requireAvailable();
    return this.listFromState(state);
  }

  create(request: { name: string; expectedSnapshotId: string }) {
    return this.checkoutMutation(request.expectedSnapshotId, async (git) => {
      await git.run("checkout", ["-b", request.name]);
    });
  }

  checkout(request: { branch: string; expectedSnapshotId: string }) {
    return this.checkoutMutation(request.expectedSnapshotId, async (git, state) => {
      const branches = await this.listFromState(state);
      const target = branches.branches.find((branch) => branch.kind === "local" && branch.name === request.branch);
      if (!target) throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", "Local branch does not exist.", state);
      if (target.checkedOutWorktreeIds.length && !target.current) throw new RepositoryOperationError("REPOSITORY_BRANCH_OCCUPIED", "Branch is checked out in another worktree.", state);
      await git.run("checkout", [request.branch]);
    });
  }

  checkoutForAiSession(branch: string) {
    return this.checkoutMutation(undefined, async (git, state) => {
      const branches = await this.listFromState(state);
      const target = branches.branches.find((candidate) => candidate.kind === "local" && candidate.name === branch);
      if (!target) throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", "Local branch does not exist.", state);
      if (target.checkedOutWorktreeIds.length && !target.current) throw new RepositoryOperationError("REPOSITORY_BRANCH_OCCUPIED", "Branch is checked out in another worktree.", state);
      await git.run("checkout", [branch]);
    });
  }

  createTracking(request: { name: string; remoteTrackingRef: string; expectedSnapshotId: string }) {
    return this.checkoutMutation(request.expectedSnapshotId, async (git, state) => {
      const branches = await this.listFromState(state);
      if (!branches.branches.some((branch) => branch.kind === "remote-tracking" && branch.name === request.remoteTrackingRef)) {
        throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", "Remote-tracking branch does not exist in local refs.", state);
      }
      await git.run("checkout", ["-b", request.name, "--track", request.remoteTrackingRef]);
    });
  }

  async delete(request: { name: string; expectedSnapshotId: string; confirm: true }): Promise<BranchResult> {
    const initial = await this.requireAvailable();
    return this.queue.withRepository(initial.gitCommonDir!, async () => {
      const state = await this.requireAvailable();
      this.assertSnapshot(state, request.expectedSnapshotId);
      const branches = await this.listFromState(state);
      const target = branches.branches.find((branch) => branch.kind === "local" && branch.name === request.name);
      if (!target) throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", "Local branch does not exist.", state);
      if (target.current || target.checkedOutWorktreeIds.length) throw new RepositoryOperationError("REPOSITORY_BRANCH_OCCUPIED", "Current or checked-out branches cannot be deleted.", state);
      try {
        await new GitProcess(state.worktreeRoot!, this.gitOptions).run("branch", ["-d", "--", request.name]);
        return this.result(await this.requireAvailable());
      } catch (error) {
        throw await this.gitError(error, "delete", "Git rejected safe branch deletion.");
      }
    });
  }

  async fetch(request: { remote: string; expectedSnapshotId: string }): Promise<BranchResult> {
    const initial = await this.requireAvailable();
    return this.queue.withRepository(initial.gitCommonDir!, async () => {
      const state = await this.requireAvailable();
      this.assertSnapshot(state, request.expectedSnapshotId);
      await this.assertRemote(state, request.remote);
      try {
        await new GitProcess(state.worktreeRoot!, this.gitOptions).run("fetch", [request.remote], { remote: true, timeoutMs: 60_000 });
        return this.result(await this.requireAvailable());
      } catch (error) {
        throw await this.gitError(error, "fetch", "Git fetch failed.");
      }
    });
  }

  async pull(request: { expectedSnapshotId: string }): Promise<BranchResult> {
    const initial = await this.requireAvailable();
    return this.queue.withRepositoryAndWorktree(initial.gitCommonDir!, initial.worktreeRoot!, async () => {
      const state = await this.requireAvailable();
      this.assertSnapshot(state, request.expectedSnapshotId);
      if (!isClean(state)) throw new RepositoryOperationError("REPOSITORY_DIRTY", "Pull requires a clean worktree and index.", state);
      const upstream = state.context.upstream;
      if (!upstream) throw new RepositoryOperationError("REPOSITORY_UPSTREAM_MISSING", "Current branch has no upstream.", state);
      if (upstream.ahead > 0 && upstream.behind > 0) throw new RepositoryOperationError("REPOSITORY_NON_FAST_FORWARD", "Current branch has diverged from its upstream.", state);
      try {
        await new GitProcess(state.worktreeRoot!, this.gitOptions).run("pull", ["--ff-only", upstream.remote, upstream.branch], { remote: true, timeoutMs: 60_000 });
        return this.result(await this.requireAvailable());
      } catch (error) {
        throw await this.gitError(error, "pull", "Git pull could not fast-forward.");
      }
    });
  }

  publish(request: { remote: string; sourceBranch: string; targetBranch: string; setUpstream: boolean; confirmSetUpstream?: boolean; expectedSnapshotId: string }) {
    return this.pushMutation(request, true);
  }

  push(request: { remote: string; sourceBranch: string; targetBranch: string; expectedSnapshotId: string }) {
    return this.pushMutation({ ...request, setUpstream: false }, false);
  }

  private async pushMutation(
    request: { remote: string; sourceBranch: string; targetBranch: string; setUpstream: boolean; confirmSetUpstream?: boolean; expectedSnapshotId: string },
    publish: boolean,
  ): Promise<BranchResult> {
    const initial = await this.requireAvailable();
    return this.queue.withRepository(initial.gitCommonDir!, async () => {
      const state = await this.requireAvailable();
      this.assertSnapshot(state, request.expectedSnapshotId);
      if (!isClean(state)) throw new RepositoryOperationError("REPOSITORY_DIRTY", "Push requires a clean worktree and index.", state);
      if (state.context.head?.state !== "branch" || state.context.head.branch !== request.sourceBranch) {
        throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", "Push source must be the current local branch.", state);
      }
      if (publish && request.setUpstream && request.confirmSetUpstream !== true) {
        throw new RepositoryOperationError("REPOSITORY_REQUEST_INVALID", "Setting upstream requires explicit confirmation.", state);
      }
      if (!publish && state.context.upstream?.behind) {
        throw new RepositoryOperationError("REPOSITORY_NON_FAST_FORWARD", "Local branch is behind its upstream.", state);
      }
      await this.assertRemote(state, request.remote);
      const refspec = `refs/heads/${request.sourceBranch}:refs/heads/${request.targetBranch}`;
      try {
        await new GitProcess(state.worktreeRoot!, this.gitOptions).run("push", [...(request.setUpstream ? ["--set-upstream"] : []), request.remote, refspec], { remote: true, timeoutMs: 60_000 });
        return this.result(await this.requireAvailable());
      } catch (error) {
        throw await this.gitError(error, "push", "Git push failed.");
      }
    });
  }

  private async checkoutMutation(expectedSnapshotId: string | undefined, operation: (git: GitProcess, state: ResolvedRepository) => Promise<void>): Promise<BranchResult> {
    const initial = await this.requireAvailable();
    return this.queue.withRepositoryAndWorktree(initial.gitCommonDir!, initial.worktreeRoot!, async () => {
      const state = await this.requireAvailable();
      if (expectedSnapshotId) this.assertSnapshot(state, expectedSnapshotId);
      try {
        await operation(new GitProcess(state.worktreeRoot!, this.gitOptions), state);
        return this.result(await this.requireAvailable());
      } catch (error) {
        if (error instanceof RepositoryOperationError) throw error;
        throw await this.gitError(error, "checkout", "Git could not switch branches without overwriting changes.");
      }
    });
  }

  private async listFromState(state: ResolvedRepository): Promise<RepositoryBranches> {
    const git = new GitProcess(state.worktreeRoot!, this.gitOptions);
    const result = await git.run("for-each-ref", [
      "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)",
      "refs/heads",
      "refs/remotes",
    ]);
    const worktrees = await this.worktrees.list();
    const occupied = new Map<string, string[]>();
    for (const worktree of worktrees.items) {
      if (worktree.head.state === "branch" && worktree.head.branch) {
        occupied.set(worktree.head.branch, [...(occupied.get(worktree.head.branch) || []), worktree.id]);
      }
    }
    const branches = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
      const [ref, oid, upstream, track] = line.split("\0");
      if (!ref || !oid || ref.endsWith("/HEAD")) return [];
      const local = ref.startsWith("refs/heads/");
      const name = ref.replace(local ? /^refs\/heads\// : /^refs\/remotes\//, "");
      const counts = parseTrack(track || "");
      return [{
        name,
        oid,
        kind: local ? "local" as const : "remote-tracking" as const,
        current: local && state.context.head?.state === "branch" && state.context.head.branch === name,
        upstream: upstream || undefined,
        ahead: local ? counts.ahead : undefined,
        behind: local ? counts.behind : undefined,
        checkedOutWorktreeIds: local ? occupied.get(name) || [] : [],
      }];
    });
    return { snapshotId: state.context.snapshotId!, branches };
  }

  private async assertRemote(state: ResolvedRepository, remote: string) {
    if (!state.context.remotes?.some((item) => item.name === remote)) {
      throw new RepositoryOperationError("REPOSITORY_BRANCH_INVALID", "Configured remote does not exist.", state);
    }
  }

  private assertSnapshot(state: ResolvedRepository, expected: string) {
    if (state.context.snapshotId !== expected) throw new RepositoryOperationError("REPOSITORY_STATE_STALE", "Repository state changed after it was loaded.", state);
  }

  private async requireAvailable() {
    const state = await this.resolve();
    if (state.context.availability !== "available" || !state.worktreeRoot || !state.gitCommonDir || !state.changes) {
      throw new RepositoryOperationError("REPOSITORY_NOT_WORKTREE", "Repository is unavailable.", state);
    }
    return state;
  }

  private async result(state: ResolvedRepository): Promise<BranchResult> {
    return { snapshotId: state.context.snapshotId!, context: state.context, branches: await this.listFromState(state) };
  }

  private async gitError(error: unknown, operation: "checkout" | "delete" | "fetch" | "pull" | "push", fallback: string) {
    const current = await this.resolve();
    if (error instanceof GitProcessError) {
      const message = `${error.message}\n${error.stderr || ""}`;
      if (/non-fast-forward|fetch first|rejected.*behind|Not possible to fast-forward/i.test(message)) return new RepositoryOperationError("REPOSITORY_NON_FAST_FORWARD", fallback, current);
      if (/authentication failed|permission denied|could not read Username|terminal prompts disabled|publickey/i.test(message)) return new RepositoryOperationError("REPOSITORY_AUTHENTICATION_FAILED", "Git authentication failed in the controlled instance.", current);
      if (operation === "delete" && /not fully merged|not merged/i.test(message)) return new RepositoryOperationError("REPOSITORY_BRANCH_UNMERGED", "Branch contains commits that are not merged.", current);
      if (operation === "checkout" && /already checked out|used by worktree/i.test(message)) return new RepositoryOperationError("REPOSITORY_BRANCH_OCCUPIED", fallback, current);
      if (operation === "checkout" && /would be overwritten|local changes|untracked working tree files/i.test(message)) return new RepositoryOperationError("REPOSITORY_DIRTY", fallback, current);
      if (error.code === "GIT_TIMEOUT") return new RepositoryOperationError("REPOSITORY_COMMAND_TIMEOUT", fallback, current);
    }
    return new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", fallback, current);
  }
}

function parseTrack(value: string) {
  return {
    ahead: Number(/ahead (\d+)/.exec(value)?.[1] || 0),
    behind: Number(/behind (\d+)/.exec(value)?.[1] || 0),
  };
}

function isClean(state: ResolvedRepository) {
  const summary = state.changes!.summary;
  return summary.conflicts + summary.staged + summary.unstaged + summary.untracked === 0;
}
