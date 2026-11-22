import { z } from "zod";
import type { RepositorySessionKind } from "@task-handoff/protocol/repository";
import type { InstanceWithAiSessions } from "../../../api/types";
import type { StorySelection } from "./storySelection";

export const StoryRepositoryPageSchema = z.enum(["files", "changes-review", "worktrees"]);
export type StoryRepositoryPage = z.infer<typeof StoryRepositoryPageSchema>;

const InstanceResourceIdentitySchema = z.object({
  instanceId: z.string().trim().min(1).max(160),
}).strict();

const AiSessionResourceIdentitySchema = InstanceResourceIdentitySchema.extend({
  aiSessionId: z.string().trim().min(1).max(160),
}).strict();

export const StoryAppResourceRefSchema = InstanceResourceIdentitySchema.extend({
  kind: z.literal("app-session"),
  sessionId: z.string().trim().min(1).max(160),
}).strict();

export const StoryRepositoryResourceRefSchema = AiSessionResourceIdentitySchema.extend({
  kind: z.literal("repository"),
  sessionKind: z.enum(["ai-session", "app-session"]),
  sessionId: z.string().trim().min(1).max(160),
  cwdFolderId: z.string().trim().min(1).max(120).optional(),
  page: StoryRepositoryPageSchema,
  filePath: z.string().trim().min(1).max(4096).optional(),
  fileRequestId: z.number().int().nonnegative().optional(),
}).strict();

export const StoryEmbeddedBrowserResourceRefSchema = AiSessionResourceIdentitySchema.extend({
  kind: z.literal("embedded-browser"),
  browserTabId: z.string().trim().min(1).max(240),
  creationRef: z.string().trim().min(1).max(240).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  initialUrl: z.string().trim().min(1).max(2000).optional(),
  currentUrl: z.string().trim().min(1).max(2000).optional(),
  status: z.string().trim().min(1).max(40).optional(),
}).strict();

export const StoryRemoteDesktopResourceRefSchema = AiSessionResourceIdentitySchema.extend({
  kind: z.literal("remote-desktop"),
}).strict();
export type StoryRemoteDesktopResourceRef = z.infer<typeof StoryRemoteDesktopResourceRefSchema>;

export const StoryResourceRefSchema = z.discriminatedUnion("kind", [
  StoryAppResourceRefSchema,
  StoryRepositoryResourceRefSchema,
  StoryEmbeddedBrowserResourceRefSchema,
  StoryRemoteDesktopResourceRefSchema,
]);

export type StoryAppResourceRef = z.infer<typeof StoryAppResourceRefSchema>;
export type StoryRepositoryResourceRef = z.infer<typeof StoryRepositoryResourceRefSchema>;
export type StoryEmbeddedBrowserResourceRef = z.infer<typeof StoryEmbeddedBrowserResourceRefSchema>;
export type StoryResourceRef = z.infer<typeof StoryResourceRefSchema>;

type StoryBrowserSessionOwner = {
  id: string;
  nodeId: string;
  aiSessions: { sessions: readonly { id: string; storyId?: string }[] };
};

/**
 * Browser resources are owned by the AI Session that opened them. The instance
 * page list intentionally spans Sessions, so activating one of those pages must
 * first move the Story selection to its owner instead of silently failing the
 * sidebar's current-context guard.
 */
export function storyBrowserSessionSelection(
  resource: StoryEmbeddedBrowserResourceRef,
  instances: readonly StoryBrowserSessionOwner[],
): Extract<StorySelection, { kind: "session" }> | undefined {
  const instance = instances.find((candidate) => candidate.id === resource.instanceId);
  const session = instance?.aiSessions.sessions.find((candidate) => candidate.id === resource.aiSessionId);
  if (!instance || !session?.storyId) return undefined;
  return {
    kind: "session",
    ownerNodeId: instance.nodeId,
    storyId: session.storyId,
    instanceId: resource.instanceId,
    sessionId: resource.aiSessionId,
  };
}

export function aiSessionResourceContextKey(instanceId: string, aiSessionId: string) {
  return instanceId && aiSessionId ? JSON.stringify([instanceId, aiSessionId]) : "";
}

const REPOSITORY_RESOURCE_KEY_FIELDS = ["aiSessionId", "instanceId", "kind", "sessionKind", "sessionId", "page", "cwdFolderId"] as const;

// cwdFolderId belongs to the identity because one AI Session owns a separate repository resource per worktree.
function repositoryResourceKeyParts(resource: StoryRepositoryResourceRef) {
  return REPOSITORY_RESOURCE_KEY_FIELDS.map((field) => resource[field] ?? null);
}

function parseRepositoryResourceKey(value: readonly unknown[]) {
  const fields: Record<string, unknown> = {};
  REPOSITORY_RESOURCE_KEY_FIELDS.forEach((field, index) => {
    const part = value[index];
    if (part !== undefined && part !== null) fields[field] = part;
  });
  const parsed = StoryRepositoryResourceRefSchema.safeParse(fields);
  return parsed.success ? parsed.data : undefined;
}

export function storyResourceKey(resource: StoryResourceRef) {
  return JSON.stringify(resource.kind === "app-session"
    ? [resource.instanceId, resource.kind, resource.sessionId]
    : resource.kind === "remote-desktop"
      ? [resource.aiSessionId, resource.instanceId, resource.kind]
    : resource.kind === "embedded-browser"
      ? [resource.aiSessionId, resource.instanceId, resource.kind, resource.browserTabId]
      : repositoryResourceKeyParts(resource));
}
export function parseStoryResourceKey(key: string): StoryResourceRef | undefined {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value)) return undefined;
    if (value[1] === "app-session") {
      const parsed = StoryAppResourceRefSchema.safeParse({ instanceId: value[0], kind: value[1], sessionId: value[2] });
      return parsed.success ? parsed.data : undefined;
    }
    if (value[2] === "remote-desktop") {
      const parsed = StoryRemoteDesktopResourceRefSchema.safeParse({ aiSessionId: value[0], instanceId: value[1], kind: value[2] });
      return parsed.success ? parsed.data : undefined;
    }
    if (value[2] === "embedded-browser") {
      const parsed = StoryEmbeddedBrowserResourceRefSchema.safeParse({
        aiSessionId: value[0],
        instanceId: value[1],
        kind: value[2],
        browserTabId: value[3],
      });
      return parsed.success ? parsed.data : undefined;
    }
    return parseRepositoryResourceKey(value);
  } catch {
    return undefined;
  }
}

export function instanceAppResourceRefs(instanceId: string, instances: readonly InstanceWithAiSessions[]): StoryAppResourceRef[] {
  if (!instanceId) return [];
  const instance = instances.find((candidate) => candidate.id === instanceId);
  return instance?.apps.sessions.flatMap((session) => (
    typeof session.id === "string" && session.id
      ? [{ kind: "app-session" as const, instanceId, sessionId: session.id }]
      : []
  )) || [];
}

export function repositoryResourcesForContext(
  contextKey: string,
  byContext: Readonly<Record<string, readonly StoryRepositoryResourceRef[]>>,
) {
  return contextKey ? [...(byContext[contextKey] || [])] : [];
}

export function upsertAiSessionRepositoryResource(
  current: readonly StoryRepositoryResourceRef[],
  input: StoryRepositoryResourceRef,
) {
  const parsed = StoryRepositoryResourceRefSchema.parse(input);
  const key = storyResourceKey(parsed);
  const index = current.findIndex((resource) => storyResourceKey(resource) === key);
  if (index < 0) return [...current, parsed];
  const next = [...current];
  const previous = next[index]!;
  next[index] = parsed.page === "files" && parsed.filePath
    ? { ...previous, ...parsed, fileRequestId: (previous.fileRequestId || 0) + 1 }
    : { ...previous, ...parsed };
  return next;
}

export function repositoryResource(
  aiSessionId: string,
  instanceId: string,
  sessionKind: RepositorySessionKind,
  sessionId: string,
  page: StoryRepositoryPage,
  filePath?: string,
  cwdFolderId?: string,
): StoryRepositoryResourceRef {
  return StoryRepositoryResourceRefSchema.parse({
    kind: "repository",
    aiSessionId,
    instanceId,
    sessionKind,
    sessionId,
    page,
    ...(cwdFolderId ? { cwdFolderId } : {}),
    ...(filePath ? { filePath, fileRequestId: 1 } : {}),
  });
}

export function activeStoryResourceKey(current: string | undefined, resources: readonly StoryResourceRef[]) {
  if (current && resources.some((resource) => storyResourceKey(resource) === current)) return current;
  return resources[0] ? storyResourceKey(resources[0]) : "";
}

export async function closeStoryResourceTarget(
  resource: StoryResourceRef,
  actions: {
    stopAppSession: (instanceId: string, sessionId: string) => Promise<unknown>;
    closeRepository: (resource: StoryRepositoryResourceRef) => void;
    closeEmbeddedBrowser: (resource: StoryEmbeddedBrowserResourceRef) => void;
    closeRemoteDesktop: (resource: StoryRemoteDesktopResourceRef) => void;
  },
) {
  if (resource.kind === "remote-desktop") {
    actions.closeRemoteDesktop(resource);
    return;
  }
  if (resource.kind === "repository") {
    actions.closeRepository(resource);
    return;
  }
  if (resource.kind === "embedded-browser") {
    actions.closeEmbeddedBrowser(resource);
    return;
  }
  await actions.stopAppSession(resource.instanceId, resource.sessionId);
}
