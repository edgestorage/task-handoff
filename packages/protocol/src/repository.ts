import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const TimestampSchema = z.string().datetime();
const GitNameSchema = z.string().trim().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f ~^:?*[\\]/.test(value) && !value.includes("..") && !value.endsWith(".") && !value.endsWith("/"), "Invalid Git name.");
const RelativePathSchema = z.string().min(1).max(4096).refine((value) => {
  if (value.includes("\0") || value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && segment !== ".git");
}, "Path must be a safe repository-relative path.");

export const RepositorySessionKindSchema = z.enum(["ai-session", "app-session"]);
export const RepositoryAvailabilitySchema = z.enum([
  "available",
  "session-not-found",
  "session-inactive",
  "cwd-missing",
  "cwd-inaccessible",
  "git-unavailable",
  "not-worktree",
]);
export const RepositoryHeadStateSchema = z.enum(["branch", "detached", "unborn"]);
export const RepositoryPrimaryActionSchema = z.enum([
  "review-changes",
  "resolve-conflicts",
  "publish-branch",
  "push",
  "pull",
  "diverged",
  "up-to-date",
]);
export const RepositoryChangeScopeSchema = z.enum(["conflict", "staged", "unstaged", "untracked"]);
export const RepositoryFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "unmerged",
  "untracked",
]);

export const RepositoryHeadSchema = z.object({
  state: RepositoryHeadStateSchema,
  oid: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  branch: z.string().min(1).max(1024).optional(),
}).strict();

export const RepositoryUpstreamSchema = z.object({
  ref: z.string().min(1).max(2048),
  remote: GitNameSchema,
  branch: z.string().min(1).max(1024),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
}).strict();

export const RepositoryWorktreeSummarySchema = z.object({
  id: IdSchema,
  isCurrent: z.boolean(),
  isMain: z.boolean(),
  managed: z.boolean(),
  head: RepositoryHeadSchema,
  dirty: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().max(1000).optional(),
  prunable: z.boolean(),
  activeAiSessionIds: z.array(IdSchema).max(256).default([]),
  activeAppSessionIds: z.array(IdSchema).max(256).default([]),
}).strict();
export const RepositoryWorktreeBlockerSchema = z.enum([
  "main-worktree",
  "external-worktree",
  "outside-workspace-roots",
  "dirty",
  "locked",
  "prunable",
  "session-occupied",
  "path-inaccessible",
]);
export const RepositoryWorktreeSchema = RepositoryWorktreeSummarySchema.extend({
  canCreateAiSession: z.boolean(),
  canRemove: z.boolean(),
  createAiSessionBlockers: z.array(RepositoryWorktreeBlockerSchema).max(16).default([]),
  removeBlockers: z.array(RepositoryWorktreeBlockerSchema).max(16).default([]),
}).strict();
export const RepositoryWorktreesSchema = z.object({
  repositoryId: IdSchema,
  repositoryContextId: IdSchema,
  snapshotId: IdSchema,
  items: z.array(RepositoryWorktreeSchema).max(10_000),
}).strict();

export const RepositoryChangeSummarySchema = z.object({
  conflicts: z.number().int().nonnegative(),
  staged: z.number().int().nonnegative(),
  unstaged: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
}).strict();

export const RepositoryRemoteSchema = z.object({
  name: GitNameSchema,
  fetchUrl: z.string().max(4096).optional(),
  pushUrl: z.string().max(4096).optional(),
}).strict();

export const RepositoryContextSchema = z.object({
  availability: RepositoryAvailabilitySchema,
  sessionKind: RepositorySessionKindSchema,
  sessionId: IdSchema,
  observedAt: TimestampSchema,
  snapshotId: IdSchema.optional(),
  repositoryId: IdSchema.optional(),
  repositoryContextId: IdSchema.optional(),
  repositoryRoot: z.string().min(1).max(4096).optional(),
  displayName: z.string().trim().min(1).max(255).optional(),
  cwdRelativePath: z.string().max(4096).optional(),
  head: RepositoryHeadSchema.optional(),
  upstream: RepositoryUpstreamSchema.optional(),
  currentWorktree: RepositoryWorktreeSummarySchema.optional(),
  changes: RepositoryChangeSummarySchema.optional(),
  remotes: z.array(RepositoryRemoteSchema).max(128).optional(),
  primaryAction: RepositoryPrimaryActionSchema.optional(),
}).strict();

export const RepositoryFileKindSchema = z.enum([
  "directory",
  "file",
  "symlink",
  "submodule",
  "nested-repository",
  "special",
]);
export const RepositoryFileModeSchema = z.object({
  executable: z.boolean(),
  gitMode: z.enum(["100644", "100755", "120000", "160000"]).optional(),
}).strict();
export const RepositoryDirectoryEntrySchema = z.object({
  name: z.string().min(1).max(1024),
  path: RelativePathSchema,
  kind: RepositoryFileKindSchema,
  traversable: z.boolean(),
  editable: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  mode: RepositoryFileModeSchema.optional(),
}).strict();
export const RepositoryDirectoryListingSchema = z.object({
  path: z.string().max(4096),
  entries: z.array(RepositoryDirectoryEntrySchema).max(10_000),
  snapshotId: IdSchema,
}).strict();
export const RepositoryFileVersionSchema = z.string().min(16).max(160).regex(/^[a-zA-Z0-9_.:-]+$/);
export const RepositoryFileContentSchema = z.object({
  path: RelativePathSchema,
  content: z.string(),
  byteLength: z.number().int().nonnegative(),
  version: RepositoryFileVersionSchema,
  mode: RepositoryFileModeSchema,
}).strict();

export const RepositoryChangeEntrySchema = z.object({
  path: RelativePathSchema,
  oldPath: RelativePathSchema.optional(),
  scope: RepositoryChangeScopeSchema,
  status: RepositoryFileStatusSchema,
  version: RepositoryFileVersionSchema,
  binary: z.boolean().default(false),
}).strict();
export const RepositoryChangesSchema = z.object({
  snapshotId: IdSchema,
  summary: RepositoryChangeSummarySchema,
  entries: z.array(RepositoryChangeEntrySchema).max(100_000),
}).strict();
export const RepositoryFileMutationResultSchema = z.object({
  file: RepositoryFileContentSchema.optional(),
  snapshotId: IdSchema,
  context: RepositoryContextSchema,
  changes: RepositoryChangesSchema,
}).strict();
const RepositoryDiffLineSchema = z.object({
  kind: z.enum(["metadata", "hunk", "context", "addition", "deletion"]),
  content: z.string(),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
  oldStart: z.number().int().nonnegative().optional(),
  oldCount: z.number().int().nonnegative().optional(),
  newStart: z.number().int().nonnegative().optional(),
  newCount: z.number().int().nonnegative().optional(),
  heading: z.string().optional(),
  hunkId: z.string().min(1).max(200).optional(),
}).strict();

export const RepositoryDiffSchema = z.object({
  path: RelativePathSchema,
  oldPath: RelativePathSchema.optional(),
  scope: RepositoryChangeScopeSchema,
  binary: z.boolean(),
  complete: z.boolean(),
  truncated: z.boolean(),
  byteLimit: z.number().int().positive(),
  content: z.string(),
  lines: z.array(RepositoryDiffLineSchema).max(200_000),
  contextGaps: z.array(z.object({
    gapId: z.string().min(1).max(500),
    beforeHunkId: z.string().min(1).max(200).optional(),
    afterHunkId: z.string().min(1).max(200).optional(),
    lines: z.array(RepositoryDiffLineSchema).max(6_000),
    startLineCount: z.number().int().nonnegative().max(3_000),
    hasMore: z.boolean(),
  }).strict()).max(20_000),
  version: RepositoryFileVersionSchema,
  snapshotId: IdSchema,
}).strict();

export const RepositoryBranchSchema = z.object({
  name: z.string().min(1).max(1024),
  oid: z.string().regex(/^[0-9a-f]{40,64}$/),
  kind: z.enum(["local", "remote-tracking"]),
  current: z.boolean(),
  upstream: z.string().min(1).max(2048).optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  checkedOutWorktreeIds: z.array(IdSchema).max(256).default([]),
}).strict();
export const RepositoryBranchesSchema = z.object({
  snapshotId: IdSchema,
  branches: z.array(RepositoryBranchSchema).max(100_000),
}).strict();
export const RepositoryBranchMutationResultSchema = z.object({
  snapshotId: IdSchema,
  context: RepositoryContextSchema,
  branches: RepositoryBranchesSchema,
}).strict();

export const RepositoryMutationResultSchema = z.object({
  ok: z.literal(true),
  snapshotId: IdSchema,
  context: RepositoryContextSchema,
  changes: RepositoryChangesSchema.optional(),
  commitOid: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
}).strict();
export const RepositoryErrorCodeSchema = z.enum([
  "REPOSITORY_REQUEST_INVALID",
  "REPOSITORY_SESSION_NOT_FOUND",
  "REPOSITORY_SESSION_INACTIVE",
  "REPOSITORY_CWD_MISSING",
  "REPOSITORY_CWD_INACCESSIBLE",
  "REPOSITORY_GIT_UNAVAILABLE",
  "REPOSITORY_NOT_WORKTREE",
  "REPOSITORY_PATH_INVALID",
  "REPOSITORY_PATH_FORBIDDEN",
  "REPOSITORY_FILE_NOT_FOUND",
  "REPOSITORY_FILE_EXISTS",
  "REPOSITORY_FILE_UNSUPPORTED",
  "REPOSITORY_FILE_TOO_LARGE",
  "REPOSITORY_FILE_BINARY",
  "REPOSITORY_FILE_STALE",
  "REPOSITORY_STATE_STALE",
  "REPOSITORY_WORKTREE_NOT_FOUND",
  "REPOSITORY_WORKTREE_OCCUPIED",
  "REPOSITORY_WORKTREE_UNSAFE",
  "REPOSITORY_BRANCH_INVALID",
  "REPOSITORY_BRANCH_OCCUPIED",
  "REPOSITORY_BRANCH_UNMERGED",
  "REPOSITORY_CONFLICT",
  "REPOSITORY_DIRTY",
  "REPOSITORY_NOTHING_TO_COMMIT",
  "REPOSITORY_IDENTITY_MISSING",
  "REPOSITORY_HOOK_FAILED",
  "REPOSITORY_SIGNING_FAILED",
  "REPOSITORY_AUTHENTICATION_FAILED",
  "REPOSITORY_NON_FAST_FORWARD",
  "REPOSITORY_UPSTREAM_MISSING",
  "REPOSITORY_COMMAND_TIMEOUT",
  "REPOSITORY_OUTPUT_LIMIT",
  "REPOSITORY_OPERATION_ABORTED",
  "REPOSITORY_OPERATION_FAILED",
]);
export const RepositoryErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: RepositoryErrorCodeSchema,
    message: z.string().trim().min(1).max(2000),
    retryable: z.boolean(),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }).strict(),
}).strict();

const SnapshotMutationSchema = z.object({ expectedSnapshotId: IdSchema }).strict();
const VersionedPathSchema = z.object({ path: RelativePathSchema, expectedVersion: RepositoryFileVersionSchema }).strict();

export const RepositoryCreateFileRequestSchema = z.object({
  path: RelativePathSchema,
  content: z.string().max(4 * 1024 * 1024),
  expectedAbsent: z.literal(true),
  expectedSnapshotId: IdSchema,
}).strict();
export const RepositoryWriteFileRequestSchema = z.object({
  path: RelativePathSchema,
  content: z.string().max(4 * 1024 * 1024),
  expectedVersion: RepositoryFileVersionSchema,
  expectedSnapshotId: IdSchema,
}).strict();
export const RepositoryRenameFileRequestSchema = z.object({
  path: RelativePathSchema,
  destination: RelativePathSchema,
  expectedVersion: RepositoryFileVersionSchema,
  expectedDestinationAbsent: z.literal(true),
  expectedSnapshotId: IdSchema,
}).strict();
export const RepositoryDeleteFileRequestSchema = z.object({
  path: RelativePathSchema,
  expectedVersion: RepositoryFileVersionSchema,
  expectedSnapshotId: IdSchema,
  confirm: z.literal(true),
}).strict();

export const RepositoryStageRequestSchema = SnapshotMutationSchema.extend({ paths: z.array(VersionedPathSchema).min(1).max(1000) }).strict();
export const RepositoryUnstageRequestSchema = SnapshotMutationSchema.extend({ paths: z.array(VersionedPathSchema).min(1).max(1000) }).strict();
export const RepositoryDiscardWorktreeRequestSchema = SnapshotMutationSchema.extend({ paths: z.array(VersionedPathSchema).min(1).max(1000), confirm: z.literal(true) }).strict();
export const RepositoryDiscardAllTrackedRequestSchema = SnapshotMutationSchema.extend({ paths: z.array(VersionedPathSchema).min(1).max(1000), confirm: z.literal(true) }).strict();
export const RepositoryCommitRequestSchema = SnapshotMutationSchema.extend({ message: z.string().trim().min(1).max(64 * 1024) }).strict();

export const RepositoryCreateWorktreeRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new-branch"), branchName: GitNameSchema, startRef: z.string().trim().min(1).max(2048), expectedSnapshotId: IdSchema }).strict(),
  z.object({ mode: z.literal("existing-branch"), branchName: GitNameSchema, expectedSnapshotId: IdSchema }).strict(),
]);
export const RepositoryRemoveWorktreeRequestSchema = SnapshotMutationSchema.extend({ worktreeId: IdSchema, confirm: z.literal(true) }).strict();
export const RepositoryCreateWorktreeResultSchema = z.object({
  worktreeId: IdSchema,
  worktrees: RepositoryWorktreesSchema,
}).strict();
export const RepositoryRemoveWorktreeResultSchema = z.object({
  removedWorktreeId: IdSchema,
  branchRetained: z.boolean(),
  worktrees: RepositoryWorktreesSchema,
}).strict();
export const AiSessionWorkspaceSelectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("current") }).strict(),
  z.object({ type: z.literal("worktree"), repositoryContextId: IdSchema, worktreeId: IdSchema }).strict(),
]);
export const RepositoryStartAiSessionRequestSchema = z.object({
  agent: z.enum(["codex", "claude"]),
  workspaceSelection: AiSessionWorkspaceSelectionSchema,
  message: z.string().trim().min(1).max(20000),
  clientRequestId: IdSchema,
  permissionMode: z.enum(["ask", "auto-review", "full-access"]).optional(),
}).strict();
export const RepositoryCreateWorktreeAiSessionRequestSchema = z.object({
  agent: z.enum(["codex", "claude"]),
  worktree: RepositoryCreateWorktreeRequestSchema,
  message: z.string().trim().min(1).max(20000),
  clientRequestId: IdSchema,
  permissionMode: z.enum(["ask", "auto-review", "full-access"]).optional(),
}).strict();
export const RepositoryAiSessionLaunchResultSchema = z.object({
  aiSessionId: IdSchema,
  providerSessionId: z.string().trim().min(1).max(240),
  worktreeId: IdSchema,
  disposition: z.literal("started"),
}).strict();

export const RepositoryCreateBranchRequestSchema = SnapshotMutationSchema.extend({ name: GitNameSchema }).strict();
export const RepositoryCheckoutBranchRequestSchema = SnapshotMutationSchema.extend({ branch: z.string().trim().min(1).max(2048) }).strict();
export const RepositoryCreateTrackingBranchRequestSchema = SnapshotMutationSchema.extend({ name: GitNameSchema, remoteTrackingRef: z.string().trim().min(1).max(2048) }).strict();
export const RepositoryDeleteBranchRequestSchema = SnapshotMutationSchema.extend({ name: GitNameSchema, confirm: z.literal(true) }).strict();
export const RepositoryFetchRequestSchema = SnapshotMutationSchema.extend({ remote: GitNameSchema }).strict();
export const RepositoryPullRequestSchema = SnapshotMutationSchema;
export const RepositoryPublishRequestSchema = SnapshotMutationSchema.extend({
  remote: GitNameSchema,
  sourceBranch: GitNameSchema,
  targetBranch: GitNameSchema,
  setUpstream: z.boolean(),
  confirmSetUpstream: z.boolean().optional(),
}).strict().refine((value) => !value.setUpstream || value.confirmSetUpstream === true, { message: "Setting an upstream requires explicit confirmation.", path: ["confirmSetUpstream"] });
export const RepositoryPushRequestSchema = SnapshotMutationSchema.extend({ remote: GitNameSchema, sourceBranch: GitNameSchema, targetBranch: GitNameSchema }).strict();

export type RepositoryContext = z.infer<typeof RepositoryContextSchema>;
export type RepositorySessionKind = z.infer<typeof RepositorySessionKindSchema>;
export type RepositoryPrimaryAction = z.infer<typeof RepositoryPrimaryActionSchema>;
export type RepositoryChanges = z.infer<typeof RepositoryChangesSchema>;
export type RepositoryChangeEntry = z.infer<typeof RepositoryChangeEntrySchema>;
export type RepositoryChangeScope = z.infer<typeof RepositoryChangeScopeSchema>;
export type RepositoryDiff = z.infer<typeof RepositoryDiffSchema>;
export type RepositoryDirectoryListing = z.infer<typeof RepositoryDirectoryListingSchema>;
export type RepositoryDirectoryEntry = z.infer<typeof RepositoryDirectoryEntrySchema>;
export type RepositoryFileContent = z.infer<typeof RepositoryFileContentSchema>;
export type RepositoryFileMutationResult = z.infer<typeof RepositoryFileMutationResultSchema>;
export type RepositoryMutationResult = z.infer<typeof RepositoryMutationResultSchema>;
export type RepositoryWorktrees = z.infer<typeof RepositoryWorktreesSchema>;
export type RepositoryWorktree = z.infer<typeof RepositoryWorktreeSchema>;
export type RepositoryWorktreeBlocker = z.infer<typeof RepositoryWorktreeBlockerSchema>;
export type RepositoryBranches = z.infer<typeof RepositoryBranchesSchema>;
export type RepositoryBranch = z.infer<typeof RepositoryBranchSchema>;
export type RepositoryBranchMutationResult = z.infer<typeof RepositoryBranchMutationResultSchema>;
export type RepositoryError = z.infer<typeof RepositoryErrorSchema>;
export type AiSessionWorkspaceSelection = z.infer<typeof AiSessionWorkspaceSelectionSchema>;
export type RepositoryStartAiSessionRequest = z.infer<typeof RepositoryStartAiSessionRequestSchema>;
export type RepositoryCreateWorktreeAiSessionRequest = z.infer<typeof RepositoryCreateWorktreeAiSessionRequestSchema>;
export type RepositoryAiSessionLaunchResult = z.infer<typeof RepositoryAiSessionLaunchResultSchema>;
export type RepositoryRemoveWorktreeResult = z.infer<typeof RepositoryRemoveWorktreeResultSchema>;
