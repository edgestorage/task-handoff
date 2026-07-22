import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RepositoryContext, RepositoryChanges } from "@task-handoff/protocol/repository";
import { GitProcess, GitProcessError, redactGitDiagnostic, type GitProcessOptions } from "./git-process";

type AiRepositorySession = { cwd?: string; status?: string };
type AppRepositorySession = { workspace?: { cwd?: string }; status?: string };
type RepositorySessionResolverOptions = {
  aiSession: (id: string) => AiRepositorySession | undefined;
  appSession: (id: string) => AppRepositorySession | undefined;
};

export type ResolvedRepository = {
  context: RepositoryContext;
  changes?: RepositoryChanges;
  worktreeRoot?: string;
  gitDir?: string;
  gitCommonDir?: string;
};

type ParsedStatus = {
  headOid?: string;
  branch?: string;
  upstreamRef?: string;
  ahead: number;
  behind: number;
  records: ParsedStatusRecord[];
};
type ParsedStatusRecord = {
  path: string;
  oldPath?: string;
  xy: string;
  kind: "ordinary" | "renamed" | "unmerged" | "untracked";
};

export class RepositorySessionResolver {
  constructor(private readonly sessions: RepositorySessionResolverOptions, private readonly gitOptions: GitProcessOptions = {}) {}

  resolveAiSession(id: string) {
    return this.resolve("ai-session", id, this.sessions.aiSession(id));
  }

  resolveAppSession(id: string) {
    const session = this.sessions.appSession(id);
    return this.resolve("app-session", id, session ? { cwd: session.workspace?.cwd, status: session.status } : undefined);
  }

  private async resolve(sessionKind: "ai-session" | "app-session", sessionId: string, session: AiRepositorySession | undefined) {
    const observedAt = new Date().toISOString();
    const unavailable = (availability: RepositoryContext["availability"]): ResolvedRepository => ({
      context: { availability, sessionKind, sessionId, observedAt },
    });
    if (!session) return unavailable("session-not-found");
    if (["closed", "terminated"].includes(session.status || "") || (sessionKind === "ai-session" && session.status === "stopped")) {
      return unavailable("session-inactive");
    }
    if (!session.cwd?.trim()) return unavailable("cwd-missing");
    const cwd = path.resolve(session.cwd);
    try {
      if (!fs.statSync(cwd).isDirectory()) return unavailable("cwd-inaccessible");
      fs.accessSync(cwd, fs.constants.R_OK);
    } catch {
      return unavailable("cwd-inaccessible");
    }

    const git = new GitProcess(cwd, this.gitOptions);
    let worktreeRoot: string;
    let gitDir: string;
    let gitCommonDir: string;
    let cwdRelativePath: string;
    try {
      const locations = await git.run("rev-parse", ["--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--show-prefix"]);
      const [rootOutput, gitDirOutput, commonDirOutput, prefixOutput = ""] = locations.stdout.split("\n");
      worktreeRoot = fs.realpathSync(rootOutput);
      gitDir = canonicalGitPath(gitDirOutput, cwd);
      gitCommonDir = canonicalGitPath(commonDirOutput, cwd);
      cwdRelativePath = prefixOutput.replace(/\/$/, "");
    } catch (error) {
      if (error instanceof GitProcessError && error.code === "GIT_NOT_FOUND") return unavailable("git-unavailable");
      return unavailable("not-worktree");
    }

    const statusResult = await git.run("status", ["--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    const parsed = parsePorcelainV2(statusResult.stdout);
    const index = await git.run("ls-files", ["--stage", "-z"]);
    const refs = await git.run("for-each-ref", ["--format=%(refname)%00%(objectname)", "refs/heads", "refs/remotes"]);
    const versions = changedPathVersions(worktreeRoot, parsed.records, index.stdout);
    const head = parsed.branch === "(detached)"
      ? { state: "detached" as const, oid: parsed.headOid }
      : parsed.headOid
        ? { state: "branch" as const, oid: parsed.headOid, branch: parsed.branch }
        : { state: "unborn" as const, branch: parsed.branch };
    const changes = repositoryChanges(parsed, versions, hashId("snapshot", [parsed.headOid || "unborn", refs.stdout, index.stdout, ...[...versions.entries()].flat()]));
    const remotes = await repositoryRemotes(git);
    const upstream = parsed.upstreamRef ? upstreamFromStatus(parsed) : undefined;
    const repositoryId = hashId("repo", [gitCommonDir]);
    const worktreeId = repositoryWorktreeId(repositoryId, worktreeRoot);
    const repositoryContextId = hashId("context", [sessionKind, sessionId, repositoryId, worktreeId]);
    const summary = changes.summary;
    const context: RepositoryContext = {
      availability: "available",
      sessionKind,
      sessionId,
      observedAt,
      snapshotId: changes.snapshotId,
      repositoryId,
      repositoryContextId,
      repositoryRoot: worktreeRoot,
      displayName: path.basename(worktreeRoot),
      cwdRelativePath,
      head,
      upstream,
      currentWorktree: {
        id: worktreeId,
        isCurrent: true,
        isMain: gitDir === gitCommonDir,
        managed: false,
        head,
        dirty: summary.conflicts + summary.staged + summary.unstaged + summary.untracked > 0,
        locked: false,
        prunable: false,
        activeAiSessionIds: sessionKind === "ai-session" ? [sessionId] : [],
        activeAppSessionIds: sessionKind === "app-session" ? [sessionId] : [],
      },
      changes: summary,
      remotes,
      primaryAction: primaryRepositoryAction(summary, upstream),
    };
    return { context, changes, worktreeRoot, gitDir, gitCommonDir } satisfies ResolvedRepository;
  }
}

function canonicalGitPath(value: string, cwd: string) {
  return fs.realpathSync(path.resolve(cwd, value));
}

export function parsePorcelainV2(output: string): ParsedStatus {
  const parsed: ParsedStatus = { ahead: 0, behind: 0, records: [] };
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.startsWith("# branch.oid ")) parsed.headOid = field.slice(13) === "(initial)" ? undefined : field.slice(13);
    else if (field.startsWith("# branch.head ")) parsed.branch = field.slice(14);
    else if (field.startsWith("# branch.upstream ")) parsed.upstreamRef = field.slice(18);
    else if (field.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(field);
      if (match) [parsed.ahead, parsed.behind] = [Number(match[1]), Number(match[2])];
    } else if (field.startsWith("1 ")) {
      const parts = field.split(" ");
      parsed.records.push({ kind: "ordinary", xy: parts[1], path: parts.slice(8).join(" ") });
    } else if (field.startsWith("2 ")) {
      const parts = field.split(" ");
      parsed.records.push({ kind: "renamed", xy: parts[1], path: parts.slice(9).join(" "), oldPath: fields[++index] });
    } else if (field.startsWith("u ")) {
      const parts = field.split(" ");
      parsed.records.push({ kind: "unmerged", xy: parts[1], path: parts.slice(10).join(" ") });
    } else if (field.startsWith("? ")) {
      parsed.records.push({ kind: "untracked", xy: "??", path: field.slice(2) });
    }
  }
  return parsed;
}

function changedPathVersions(root: string, records: ParsedStatusRecord[], indexState: string) {
  const result = new Map<string, string>();
  for (const record of records) {
    const filePath = path.join(root, ...record.path.split("/"));
    let content = "missing";
    try {
      const stat = fs.lstatSync(filePath);
      content = stat.isFile()
        ? crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
        : `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.isSymbolicLink() ? fs.readlinkSync(filePath) : "special"}`;
    } catch {}
    const indexLines = indexState.split("\0").filter((line) => line.endsWith(`\t${record.path}`) || (record.oldPath && line.endsWith(`\t${record.oldPath}`))).join("\0");
    result.set(record.path, hashId("version", [record.xy, content, indexLines]));
  }
  return result;
}

function repositoryChanges(parsed: ParsedStatus, versions: Map<string, string>, snapshotId: string): RepositoryChanges {
  const entries: RepositoryChanges["entries"] = [];
  for (const record of parsed.records) {
    const status = changeStatus(record);
    const base = { path: record.path, oldPath: record.oldPath, status, binary: false };
    const entry = (scope: RepositoryChanges["entries"][number]["scope"]) => ({
      ...base,
      scope,
      version: hashId("version", [versions.get(record.path)!, scope]),
    });
    if (record.kind === "unmerged") entries.push(entry("conflict"));
    else if (record.kind === "untracked") entries.push(entry("untracked"));
    else {
      if (record.xy[0] !== ".") entries.push(entry("staged"));
      if (record.xy[1] !== ".") entries.push(entry("unstaged"));
    }
  }
  return {
    snapshotId,
    summary: {
      conflicts: entries.filter((entry) => entry.scope === "conflict").length,
      staged: entries.filter((entry) => entry.scope === "staged").length,
      unstaged: entries.filter((entry) => entry.scope === "unstaged").length,
      untracked: entries.filter((entry) => entry.scope === "untracked").length,
    },
    entries,
  };
}

function changeStatus(record: ParsedStatusRecord): RepositoryChanges["entries"][number]["status"] {
  if (record.kind === "unmerged") return "unmerged";
  if (record.kind === "untracked") return "untracked";
  const code = record.xy.replaceAll(".", "")[0];
  return ({ A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed" } as const)[code as "A"] || "modified";
}

async function repositoryRemotes(git: GitProcess) {
  const names = (await git.run("remote")).stdout.split("\n").map((name) => name.trim()).filter(Boolean);
  return Promise.all(names.map(async (name) => {
    const fetchUrl = redactRemoteUrl((await git.run("remote", ["get-url", name])).stdout.trim());
    const pushUrl = redactRemoteUrl((await git.run("remote", ["get-url", "--push", name])).stdout.trim());
    return { name, fetchUrl, pushUrl };
  }));
}

function redactRemoteUrl(value: string) {
  return redactGitDiagnostic(value).replace(/^([^@\s]+)@([^:\s]+):/, "***@$2:");
}

function upstreamFromStatus(parsed: ParsedStatus) {
  const ref = parsed.upstreamRef!;
  const separator = ref.indexOf("/");
  return {
    ref,
    remote: separator > 0 ? ref.slice(0, separator) : ".",
    branch: separator > 0 ? ref.slice(separator + 1) : ref,
    ahead: parsed.ahead,
    behind: parsed.behind,
  };
}

export function primaryRepositoryAction(summary: RepositoryChanges["summary"], upstream?: { ahead: number; behind: number }) {
  if (summary.conflicts > 0) return "resolve-conflicts" as const;
  if (summary.staged + summary.unstaged + summary.untracked > 0) return "review-changes" as const;
  if (!upstream) return "publish-branch" as const;
  if (upstream.ahead > 0 && upstream.behind > 0) return "diverged" as const;
  if (upstream.ahead > 0) return "push" as const;
  if (upstream.behind > 0) return "pull" as const;
  return "up-to-date" as const;
}

function hashId(prefix: string, parts: string[]) {
  return `${prefix}:${crypto.createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

export function repositoryWorktreeId(repositoryId: string, worktreePath: string) {
  return hashId("wt", [repositoryId, worktreePath]);
}
