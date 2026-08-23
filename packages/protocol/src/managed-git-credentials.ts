import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const TimestampSchema = z.string().datetime();
const RevisionSchema = z.number().int().nonnegative();

export const GitCredentialKindSchema = z.enum(["https-token", "ssh-key"]);
export const GitCredentialRetentionSchema = z.enum(["operation-only", "instance-retained"]);
export const GitCredentialStatusSchema = z.enum(["enabled", "disabled"]);
export const GitCredentialAssignmentStatusSchema = z.enum(["pending", "synced", "deferred", "revoking", "revoked"]);

export const GitCredentialScopeSchema = z.object({
  scheme: z.enum(["https", "ssh"]),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).optional(),
  pathPrefix: z.string().min(1).max(2048).default("/"),
}).strict();

export type GitCredentialScope = z.infer<typeof GitCredentialScopeSchema>;

function invalidScope(message: string): never {
  throw new Error(`Invalid Git credential scope: ${message}`);
}

function normalizeHost(host: string) {
  const trimmed = host.trim().replace(/^\[|\]$/g, "");
  if (!trimmed || trimmed.includes("*") || /[/?#@\s]/.test(trimmed)) invalidScope("host is invalid");
  try {
    // WHATWG URL performs the same IDNA conversion in Node and browsers and
    // canonicalizes IPv6 without introducing a Node-only protocol dependency.
    const parsed = new URL(trimmed.includes(":") ? `http://[${trimmed}]/` : `http://${trimmed}/`);
    const normalized = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!normalized || normalized.length > 253 || normalized.includes("*")) invalidScope("host is invalid");
    return normalized;
  } catch {
    invalidScope("host is invalid");
  }
}

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    invalidScope("path contains invalid percent encoding");
  }
}

function normalizePathPrefix(value: string | undefined) {
  const raw = value?.trim() || "/";
  if (raw.includes("?") || raw.includes("#") || raw.includes("\\") || raw.includes("\0")) {
    invalidScope("path contains an unsupported delimiter");
  }
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const segments = withSlash.split("/").filter(Boolean);
  for (const segment of segments) {
    const decoded = decodePathSegment(segment);
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      invalidScope("path contains an unsafe segment");
    }
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

export function normalizeGitCredentialScope(input: unknown): GitCredentialScope {
  const parsed = GitCredentialScopeSchema.parse(input);
  const defaultPort = parsed.scheme === "https" ? 443 : 22;
  return GitCredentialScopeSchema.parse({
    scheme: parsed.scheme,
    host: normalizeHost(parsed.host),
    ...(parsed.port === undefined || parsed.port === defaultPort ? {} : { port: parsed.port }),
    pathPrefix: normalizePathPrefix(parsed.pathPrefix),
  });
}

export type NormalizedGitRemote = GitCredentialScope & { original: string };

function remotePath(pathname: string) {
  return normalizePathPrefix(pathname.replace(/\.git\/?$/, ""));
}

export function normalizeGitRemote(remote: string): NormalizedGitRemote {
  const value = remote.trim();
  if (!value || value.includes("\0")) invalidScope("remote is empty or invalid");

  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    const rawPath = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "").split(/[?#]/, 1)[0];
    normalizePathPrefix(rawPath || "/");
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      invalidScope("remote URL is invalid");
    }
    if (url.protocol !== "https:" && url.protocol !== "ssh:") invalidScope("remote scheme is unsupported");
    if (url.password || (url.protocol === "https:" && url.username)) invalidScope("HTTPS userinfo is forbidden");
    if (url.search || url.hash) invalidScope("query and fragment are forbidden");
    const scheme = url.protocol === "https:" ? "https" : "ssh";
    const rawPort = url.port ? Number(url.port) : undefined;
    const scope = normalizeGitCredentialScope({
      scheme,
      host: url.hostname,
      port: rawPort,
      pathPrefix: remotePath(url.pathname),
    });
    return { ...scope, original: value };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) invalidScope("remote scheme is unsupported");

  const scp = /^(?:([^@/:\s]+)@)?([^/:\s]+):(.+)$/.exec(value);
  if (!scp) invalidScope("remote must use HTTPS, ssh://, or scp-like SSH syntax");
  const [, , host, path] = scp;
  if (path.includes("?") || path.includes("#")) invalidScope("query and fragment are forbidden");
  const scope = normalizeGitCredentialScope({ scheme: "ssh", host, pathPrefix: remotePath(path) });
  return { ...scope, original: value };
}

export const GitCredentialPublicSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  kind: GitCredentialKindSchema,
  scope: GitCredentialScopeSchema,
  secretSet: z.literal(true),
  status: GitCredentialStatusSchema,
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

const HttpsSecretInputSchema = z.object({
  kind: z.literal("https-token"),
  username: z.string().trim().min(1).max(240),
  token: z.string().min(1).max(8192),
}).strict();

const SshSecretInputSchema = z.object({
  kind: z.literal("ssh-key"),
  privateKey: z.string().min(1).max(128 * 1024),
  passphrase: z.string().max(8192).optional(),
  pinnedKnownHosts: z.string().min(1).max(128 * 1024),
}).strict();

export const GitCredentialSecretInputSchema = z.discriminatedUnion("kind", [HttpsSecretInputSchema, SshSecretInputSchema]);
export const GitCredentialCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  scope: GitCredentialScopeSchema,
  secret: GitCredentialSecretInputSchema,
}).strict().superRefine((value, context) => {
  if ((value.scope.scheme === "https") !== (value.secret.kind === "https-token")) {
    context.addIssue({ code: "custom", path: ["scope", "scheme"], message: "Credential kind must match the remote scheme." });
  }
  try {
    normalizeGitCredentialScope(value.scope);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["scope"], message: error instanceof Error ? error.message : "Invalid Git scope." });
  }
});

export const GitCredentialUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  scope: GitCredentialScopeSchema.optional(),
  secret: GitCredentialSecretInputSchema.optional(),
  status: GitCredentialStatusSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one credential field must be updated.");

export const GitCredentialListResponseSchema = z.object({ items: z.array(GitCredentialPublicSchema).max(10_000) }).strict();

export const InstanceGitCredentialAssignmentSchema = z.object({
  instanceId: IdSchema,
  credentialId: IdSchema,
  credentialRevision: RevisionSchema,
  assignmentRevision: RevisionSchema,
  status: GitCredentialAssignmentStatusSchema,
  authorizedAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const NodeGitCredentialPayloadSchema = z.object({
  credential: GitCredentialPublicSchema,
  secret: GitCredentialSecretInputSchema,
}).strict().superRefine((value, context) => {
  if (value.credential.kind !== value.secret.kind) {
    context.addIssue({ code: "custom", path: ["secret", "kind"], message: "Credential payload kind mismatch." });
  }
});

export const NodeGitCredentialAuthorizationSetSchema = z.object({
  instanceId: IdSchema,
  generation: RevisionSchema,
  credentialIds: z.array(IdSchema).max(256).transform((ids) => [...new Set(ids)].sort()),
  updatedAt: TimestampSchema,
}).strict();

export const GitCredentialHttpsResolveRequestSchema = z.object({
  remoteUrl: z.string().trim().min(1).max(4096),
}).strict();

export const GitCredentialHttpsResolveResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), username: z.string().min(1).max(240), password: z.string().min(1).max(8192) }).strict(),
  z.object({ status: z.enum(["none", "ambiguous", "unsupported", "missing-host-key", "rejected"]) }).strict(),
]);

export const GitCredentialSshPrepareRequestSchema = z.object({
  remoteUrl: z.string().trim().min(1).max(4096),
}).strict();

export const GitCredentialSshPrepareResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    invocationId: IdSchema,
    publicIdentity: z.string().min(1).max(128 * 1024),
    pinnedKnownHosts: z.string().min(1).max(128 * 1024),
  }).strict(),
  z.object({ status: z.enum(["none", "ambiguous", "unsupported", "missing-host-key", "rejected"]) }).strict(),
]);

export const GitCredentialSshAgentRequestSchema = z.object({
  invocationId: IdSchema,
  frame: z.string().min(1).max(1024 * 1024),
}).strict();

export const GitCredentialSshAgentResponseSchema = z.object({
  frame: z.string().min(1).max(1024 * 1024),
}).strict();

export const GitWorkspaceProvisioningCredentialSchema = z.object({
  operationId: IdSchema,
  retention: GitCredentialRetentionSchema,
  payload: NodeGitCredentialPayloadSchema,
}).strict();

export const GitWorkspaceProvisioningInputSchema = z.object({
  operationId: IdSchema,
  instanceId: IdSchema,
  remoteUrl: z.string().trim().min(1).max(4096),
  ref: z.object({
    type: z.enum(["branch", "tag", "commit"]),
    name: z.string().trim().min(1).max(240).optional(),
    commit: z.string().trim().min(1).max(80).optional(),
  }).strict(),
  clone: z.object({
    depth: z.number().int().positive().max(100_000).optional(),
    submodules: z.boolean().default(false),
    lfs: z.boolean().default(false),
    subdirectory: z.string().trim().max(240).default(""),
  }).strict(),
  credentials: z.array(GitWorkspaceProvisioningCredentialSchema).max(256).default([]),
}).strict();

export type GitCredentialPublic = z.infer<typeof GitCredentialPublicSchema>;
export type GitCredentialRetention = z.infer<typeof GitCredentialRetentionSchema>;
export type GitCredentialCreateRequest = z.infer<typeof GitCredentialCreateRequestSchema>;
export type GitCredentialUpdateRequest = z.infer<typeof GitCredentialUpdateRequestSchema>;
export type GitCredentialSecretInput = z.infer<typeof GitCredentialSecretInputSchema>;
export type InstanceGitCredentialAssignment = z.infer<typeof InstanceGitCredentialAssignmentSchema>;
export type NodeGitCredentialPayload = z.infer<typeof NodeGitCredentialPayloadSchema>;
export type NodeGitCredentialAuthorizationSet = z.infer<typeof NodeGitCredentialAuthorizationSetSchema>;
export type GitWorkspaceProvisioningInput = z.infer<typeof GitWorkspaceProvisioningInputSchema>;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pick(record: Record<string, unknown> | undefined, keys: readonly string[]) {
  if (!record) return undefined;
  return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(record, key)).map((key) => [key, record[key]]));
}

export function sanitizeGitCredentialPublic(input: unknown) {
  const record = objectRecord(input);
  const scope = objectRecord(record?.scope);
  return GitCredentialPublicSchema.safeParse({
    ...pick(record, ["id", "name", "kind", "secretSet", "status", "revision", "createdAt", "updatedAt"]),
    scope: pick(scope, ["scheme", "host", "port", "pathPrefix"]),
  });
}

export type GitCredentialMatchCandidate = Pick<GitCredentialPublic, "id" | "kind" | "scope" | "status"> & {
  pinnedKnownHosts?: boolean;
};

export type GitCredentialMatchResult =
  | { status: "unique"; remote: NormalizedGitRemote; credential: GitCredentialMatchCandidate }
  | { status: "none"; remote: NormalizedGitRemote }
  | { status: "ambiguous"; remote: NormalizedGitRemote; credentialIds: string[] }
  | { status: "unsupported"; remote?: undefined; reason: string }
  | { status: "missing-host-key"; remote: NormalizedGitRemote; credentialId: string };

function scopeMatches(scope: GitCredentialScope, remote: NormalizedGitRemote) {
  const normalized = normalizeGitCredentialScope(scope);
  if (normalized.scheme !== remote.scheme || normalized.host !== remote.host || normalized.port !== remote.port) return false;
  return normalized.pathPrefix === "/" || remote.pathPrefix.startsWith(normalized.pathPrefix);
}

export function resolveGitCredential(
  remoteValue: string,
  candidates: readonly GitCredentialMatchCandidate[],
): GitCredentialMatchResult {
  let remote: NormalizedGitRemote;
  try {
    remote = normalizeGitRemote(remoteValue);
  } catch (error) {
    return { status: "unsupported", reason: error instanceof Error ? error.message : "Unsupported Git remote." };
  }
  const matches = candidates
    .filter((candidate) => candidate.status === "enabled")
    .filter((candidate) => (remote.scheme === "https") === (candidate.kind === "https-token"))
    .filter((candidate) => scopeMatches(candidate.scope, remote))
    .map((candidate) => ({ candidate, specificity: normalizeGitCredentialScope(candidate.scope).pathPrefix.length }));
  if (matches.length === 0) return { status: "none", remote };
  const specificity = Math.max(...matches.map((match) => match.specificity));
  const best = matches.filter((match) => match.specificity === specificity).map((match) => match.candidate);
  if (best.length > 1) {
    return { status: "ambiguous", remote, credentialIds: best.map((candidate) => candidate.id).sort() };
  }
  const credential = best[0];
  if (credential.kind === "ssh-key" && credential.pinnedKnownHosts !== true) {
    return { status: "missing-host-key", remote, credentialId: credential.id };
  }
  return { status: "unique", remote, credential };
}
