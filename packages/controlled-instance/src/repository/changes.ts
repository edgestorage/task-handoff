import fs from "node:fs";
import path from "node:path";
import type { RepositoryChanges, RepositoryContext } from "@task-handoff/protocol/repository";
import type { ResolvedRepository } from "./context";
import { validateRepositoryRelativePath } from "./files";
import { GitProcess, GitProcessError, type GitProcessOptions } from "./git-process";
import { RepositoryMutationQueue } from "./mutation-queue";

type ChangeEntry = RepositoryChanges["entries"][number];
type VersionedPath = { path: string; expectedVersion: string };
type SnapshotRequest = { expectedSnapshotId: string };
type MutationState = { ok: true; snapshotId: string; context: RepositoryContext; changes: RepositoryChanges; commitOid?: string };

export class RepositoryOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly current?: ResolvedRepository,
    readonly details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = "RepositoryOperationError";
  }
}

export class RepositoryChangesService {
  constructor(
    private readonly resolve: () => Promise<ResolvedRepository>,
    private readonly queue = new RepositoryMutationQueue(),
    private readonly gitOptions: GitProcessOptions = {},
  ) {}

  async diff(scope: ChangeEntry["scope"], relativePath: string, byteLimit = 512 * 1024) {
    if (!Number.isInteger(byteLimit) || byteLimit < 1 || byteLimit > 2 * 1024 * 1024) {
      throw new RepositoryOperationError("REPOSITORY_PATH_INVALID", "Diff byte limit is invalid.");
    }
    validateRepositoryRelativePath(relativePath);
    const state = await this.requireAvailable();
    const entry = state.changes!.entries.find((candidate) => candidate.scope === scope && candidate.path === relativePath);
    if (!entry) throw new RepositoryOperationError("REPOSITORY_FILE_NOT_FOUND", "Change entry no longer exists.", state);
    const root = state.worktreeRoot!;
    let raw: string;
    let binary = false;
    if (scope === "untracked") {
      const result = untrackedUnifiedDiff(root, relativePath, byteLimit);
      raw = result.content;
      binary = result.binary;
    } else {
      const git = new GitProcess(root, this.gitOptions);
      const args = scope === "staged"
        ? ["--cached", "--", relativePath]
        : scope === "conflict"
          ? ["--cc", "--", relativePath]
          : ["--", relativePath];
      const result = await git.run("diff", args, { outputLimitBytes: Math.max(byteLimit * 8, 8 * 1024 * 1024) });
      raw = result.stdout;
      binary = /(?:Binary files .* differ|GIT binary patch)/.test(raw);
    }
    const truncated = truncateUtf8(raw, byteLimit);
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      scope,
      binary,
      complete: !binary && !truncated.truncated,
      truncated: truncated.truncated,
      byteLimit,
      content: binary ? "" : truncated.content,
      lines: binary ? [] : structuredDiffLines(truncated.content),
      version: entry.version,
      snapshotId: state.context.snapshotId!,
    };
  }

  stage(request: SnapshotRequest & { paths: VersionedPath[] }) {
    return this.mutate(request, ["unstaged", "untracked", "conflict"], async (git, paths) => {
      await git.run("add", ["--", ...paths]);
    });
  }

  unstage(request: SnapshotRequest & { paths: VersionedPath[] }) {
    return this.mutate(request, ["staged"], async (git, paths, state) => {
      if (state.context.head?.state === "unborn") await git.run("reset", ["--", ...paths]);
      else await git.run("restore", ["--staged", "--", ...paths]);
    });
  }

  discardWorktree(request: SnapshotRequest & { paths: VersionedPath[]; confirm: true }) {
    return this.mutate(request, ["unstaged"], async (git, paths) => {
      await git.run("restore", ["--worktree", "--", ...paths]);
    }, ["untracked", "conflict"]);
  }

  discardAllTracked(request: SnapshotRequest & { paths: VersionedPath[]; confirm: true }) {
    return this.mutate(request, ["staged", "unstaged"], async (git, paths, state) => {
      if (state.context.head?.state === "unborn") {
        throw new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "Discarding all tracked changes requires an existing HEAD.", state);
      }
      for (const selected of paths) {
        const entries = state.changes!.entries.filter((entry) => entry.path === selected);
        if (entries.some((entry) => entry.scope === "untracked" || entry.scope === "conflict")) {
          throw new RepositoryOperationError("REPOSITORY_CONFLICT", "Untracked and conflicted paths cannot be discarded by this action.", state);
        }
      }
      await git.run("restore", ["--source=HEAD", "--staged", "--worktree", "--", ...paths]);
    }, ["untracked", "conflict"]);
  }

  async commit(request: SnapshotRequest & { message: string }): Promise<MutationState> {
    const initial = await this.requireAvailable();
    return this.queue.withWorktree(initial.worktreeRoot!, async () => {
      const state = await this.requireAvailable();
      this.assertSnapshot(state, request.expectedSnapshotId);
      if (!request.message.trim()) throw new RepositoryOperationError("REPOSITORY_NOTHING_TO_COMMIT", "Commit message is required.", state);
      if (!state.changes!.entries.some((entry) => entry.scope === "staged")) {
        throw new RepositoryOperationError("REPOSITORY_NOTHING_TO_COMMIT", "The index has no staged changes.", state);
      }
      const git = new GitProcess(state.worktreeRoot!, this.gitOptions);
      try {
        await git.run("commit", ["-m", request.message]);
        const commitOid = (await git.run("rev-parse", ["HEAD"])).stdout.trim();
        return this.result(await this.requireAvailable(), commitOid);
      } catch (error) {
        const current = await this.resolve();
        throw structuredGitError(error, current);
      }
    });
  }

  private async mutate(
    request: SnapshotRequest & { paths: VersionedPath[] },
    allowedScopes: ChangeEntry["scope"][],
    operation: (git: GitProcess, paths: string[], state: ResolvedRepository) => Promise<void>,
    rejectedScopes: ChangeEntry["scope"][] = [],
  ): Promise<MutationState> {
    const initial = await this.requireAvailable();
    return this.queue.withWorktree(initial.worktreeRoot!, async () => {
      const state = await this.requireAvailable();
      this.assertSnapshot(state, request.expectedSnapshotId);
      for (const item of request.paths) {
        const rejected = state.changes!.entries.find((entry) => entry.path === item.path && entry.version === item.expectedVersion && rejectedScopes.includes(entry.scope));
        if (rejected) throw new RepositoryOperationError("REPOSITORY_CONFLICT", `${rejected.scope} paths are not supported by this discard action.`, state);
      }
      const paths = this.assertVersions(state, request.paths, allowedScopes);
      try {
        await operation(new GitProcess(state.worktreeRoot!, this.gitOptions), paths, state);
        return this.result(await this.requireAvailable());
      } catch (error) {
        if (error instanceof RepositoryOperationError) throw error;
        const current = await this.resolve();
        throw structuredGitError(error, current);
      }
    });
  }

  private async requireAvailable() {
    const state = await this.resolve();
    if (state.context.availability !== "available" || !state.worktreeRoot || !state.gitCommonDir || !state.changes) {
      throw new RepositoryOperationError("REPOSITORY_NOT_WORKTREE", "Repository is unavailable.", state);
    }
    return state;
  }

  private assertSnapshot(state: ResolvedRepository, expectedSnapshotId: string) {
    if (state.context.snapshotId !== expectedSnapshotId) {
      throw new RepositoryOperationError("REPOSITORY_STATE_STALE", "Repository state changed after it was loaded.", state);
    }
  }

  private assertVersions(state: ResolvedRepository, requested: VersionedPath[], allowedScopes: ChangeEntry["scope"][]) {
    if (!requested.length) throw new RepositoryOperationError("REPOSITORY_PATH_INVALID", "At least one path is required.", state);
    const unique = new Set<string>();
    for (const item of requested) {
      validateRepositoryRelativePath(item.path);
      if (unique.has(item.path)) throw new RepositoryOperationError("REPOSITORY_PATH_INVALID", "Duplicate paths are not allowed.", state);
      unique.add(item.path);
      const matching = state.changes!.entries.find((entry) => entry.path === item.path && allowedScopes.includes(entry.scope));
      if (!matching || matching.version !== item.expectedVersion) {
        throw new RepositoryOperationError("REPOSITORY_STATE_STALE", `Change version is stale: ${item.path}.`, state);
      }
    }
    return [...unique];
  }

  private result(state: ResolvedRepository, commitOid?: string): MutationState {
    return {
      ok: true,
      snapshotId: state.context.snapshotId!,
      context: state.context,
      changes: state.changes!,
      ...(commitOid ? { commitOid } : {}),
    };
  }
}

export function structuredDiffLines(raw: string) {
  const lines: Array<{
    kind: "metadata" | "hunk" | "context" | "addition" | "deletion";
    content: string;
    oldLine?: number;
    newLine?: number;
  }> = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const rawLines = raw ? raw.split("\n") : [];
  if (raw.endsWith("\n")) rawLines.pop();
  for (const rawLine of rawLines) {
    const hunk = rawLine.match(/^@@ -(?<old>\d+)(?:,\d+)? \+(?<next>\d+)(?:,\d+)? @@/);
    if (hunk?.groups) {
      oldLine = Number(hunk.groups.old);
      newLine = Number(hunk.groups.next);
      lines.push({ kind: "hunk", content: rawLine });
      continue;
    }
    if (rawLine.startsWith("@@@")) {
      oldLine = undefined;
      newLine = undefined;
      lines.push({ kind: "hunk", content: rawLine });
      continue;
    }
    if (oldLine === undefined || newLine === undefined || rawLine.startsWith("diff --git ") || rawLine.startsWith("index ") || rawLine.startsWith("--- ") || rawLine.startsWith("+++ ") || rawLine.startsWith("\\ No newline")) {
      lines.push({ kind: "metadata", content: rawLine });
      continue;
    }
    if (rawLine.startsWith("+")) {
      lines.push({ kind: "addition", content: rawLine.slice(1), newLine });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      lines.push({ kind: "deletion", content: rawLine.slice(1), oldLine });
      oldLine += 1;
      continue;
    }
    const content = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
    lines.push({ kind: "context", content, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }
  return lines;
}

function structuredGitError(error: unknown, current: ResolvedRepository) {
  if (!(error instanceof GitProcessError)) return new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "Repository operation failed.", current);
  if (error.code === "GIT_TIMEOUT") return new RepositoryOperationError("REPOSITORY_COMMAND_TIMEOUT", "Git operation timed out.", current);
  if (error.code === "GIT_OUTPUT_LIMIT") return new RepositoryOperationError("REPOSITORY_OUTPUT_LIMIT", "Git operation exceeded its output limit.", current);
  if (error.code === "GIT_ABORTED") return new RepositoryOperationError("REPOSITORY_OPERATION_ABORTED", "Git operation was aborted.", current);
  const diagnostic = `${error.message}\n${error.stderr || ""}`;
  if (/Author identity unknown|unable to auto-detect email address|Please tell me who you are/i.test(diagnostic)) {
    return new RepositoryOperationError("REPOSITORY_IDENTITY_MISSING", "Git user identity is not configured for this repository.", current);
  }
  if (/gpg failed to sign|failed to write commit object|signing failed/i.test(diagnostic)) {
    return new RepositoryOperationError("REPOSITORY_SIGNING_FAILED", "Git could not sign the commit.", current);
  }
  if (/hook declined|hook.*failed|pre-commit|commit-msg/i.test(diagnostic)) {
    return new RepositoryOperationError("REPOSITORY_HOOK_FAILED", "A Git commit hook rejected the commit.", current);
  }
  return new RepositoryOperationError("REPOSITORY_OPERATION_FAILED", "Git rejected the repository operation.", current);
}

function untrackedUnifiedDiff(root: string, relativePath: string, byteLimit: number) {
  const absolutePath = path.join(root, ...validateRepositoryRelativePath(relativePath));
  const canonicalParent = fs.realpathSync(path.dirname(absolutePath));
  if (canonicalParent !== root && !canonicalParent.startsWith(`${root}${path.sep}`)) {
    throw new RepositoryOperationError("REPOSITORY_PATH_FORBIDDEN", "Untracked path crosses the repository boundary.");
  }
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) return { content: "", binary: true };
  const readLimit = Math.max(byteLimit * 4, 64 * 1024);
  const fd = fs.openSync(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, readLimit));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (buffer.includes(0)) return { content: "", binary: true };
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return { content: "", binary: true }; }
    const lines = text.split("\n");
    const body = lines.map((line, index) => index === lines.length - 1 && line === "" ? "" : `+${line}`).filter((line, index) => line !== "" || index !== lines.length - 1).join("\n");
    const header = [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relativePath}`,
      `@@ -0,0 +1,${Math.max(0, lines.length - (text.endsWith("\n") ? 1 : 0))} @@`,
    ].join("\n");
    return { content: `${header}\n${body}${body ? "\n" : ""}`, binary: false };
  } finally {
    fs.closeSync(fd);
  }
}

function truncateUtf8(value: string, byteLimit: number) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= byteLimit) return { content: value, truncated: false };
  let end = byteLimit;
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { content: buffer.subarray(0, end).toString("utf8"), truncated: true };
}
