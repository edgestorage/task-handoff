import { z } from "zod";
import { StoryIdSchema } from "./story-id.ts";

/** Version of the shared Story context settings and renderer model. */
export const STORY_CONTEXT_PROTOCOL_VERSION = "2026-11-26";
/** Version of the controlled-instance -> Node Agent resolved-context boundary. */
export const STORY_CONTEXT_RESOLVE_PROTOCOL_VERSION = "2026-11-26";
/** Version of the Node Agent -> controlled-instance closed-session summary boundary. */
export const STORY_CONTEXT_CLOSED_SESSIONS_PROTOCOL_VERSION = "2026-11-26";

export const STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH = 8_000;
export const STORY_CONTEXT_MAX_PROJECTS = 100;
export const STORY_CONTEXT_PROJECT_BLOCK_MAX_LENGTH = 4_000;
export const STORY_CONTEXT_SESSION_BLOCK_MAX_LENGTH = 12_000;
export const STORY_CONTEXT_RENDERED_MAX_LENGTH = 24_000;
export const STORY_CONTEXT_MEMBER_APPENDED_PROMPT_MAX_LENGTH = 32_000;
export const STORY_CONTEXT_SESSION_CANDIDATE_LIMIT = 200;
export const STORY_CONTEXT_SESSION_SUMMARY_MAX_LENGTH = 2_000;
export const STORY_CONTEXT_SESSION_TITLE_MAX_LENGTH = 240;
export const STORY_CONTEXT_SESSION_USER_PROMPT_MAX_LENGTH = 600;
export const STORY_CONTEXT_SESSION_LAST_RESPONSE_MAX_LENGTH = 800;

const NodeIdSchema = z.string().trim().min(1).max(120);
const FolderIdSchema = z.string().trim().min(1).max(120);
const SessionIdSchema = z.string().trim().min(1).max(120);
const InstanceIdSchema = z.string().trim().min(1).max(120);
const TimestampSchema = z.string().datetime();

export const StoryContextRevisionSchema = z.number().int().nonnegative();

const StoryContextSettingsShape = {
  storyId: StoryIdSchema,
  revision: StoryContextRevisionSchema,
  projectFolderIds: z.array(FolderIdSchema).max(STORY_CONTEXT_MAX_PROJECTS),
  appendedPrompt: z.string().max(STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH),
  updatedAt: TimestampSchema,
} as const;

export const StoryContextSettingsSchema = z.object(StoryContextSettingsShape).strict();

const StoryContextSettingsConsumerSchema = z.object(StoryContextSettingsShape).strip();

export function sanitizeStoryContextSettings(input: unknown) {
  return StoryContextSettingsConsumerSchema.parse(input);
}

export const StoryContextSettingsUpdateInputSchema = z.object({
  expectedRevision: StoryContextRevisionSchema,
  projectFolderIds: z.array(FolderIdSchema).max(STORY_CONTEXT_MAX_PROJECTS),
  appendedPrompt: z.string().max(STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH),
}).strict();

export const StoryContextPurposeSchema = z.enum(["session-create", "agent-run"]);

export const StoryContextCallerSchema = z.object({
  instanceId: InstanceIdSchema,
  sessionId: SessionIdSchema.optional(),
}).strict();

export const StoryContextResolveInputSchema = z.object({
  storyId: StoryIdSchema,
  purpose: StoryContextPurposeSchema,
  caller: StoryContextCallerSchema.optional(),
  excludeSessionIds: z.array(SessionIdSchema).max(STORY_CONTEXT_SESSION_CANDIDATE_LIMIT).default([]),
}).strict();

export const StoryContextDiagnosticSchema = z.object({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2_000),
  resourceId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const StoryContextProjectDiagnosticSchema = z.object({
  folderId: FolderIdSchema,
  code: z.enum(["missing", "unavailable", "metadata-invalid"]),
}).strict();

export const StoryContextSessionDiagnosticSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  instanceId: InstanceIdSchema.optional(),
  code: z.enum(["read-failed", "unavailable", "not-root", "wrong-story", "invalid"]),
}).strict();

export const StoryContextResolutionSchema = z.object({
  protocolVersion: z.literal(STORY_CONTEXT_RESOLVE_PROTOCOL_VERSION),
  storyId: StoryIdSchema,
  nodeId: NodeIdSchema,
  purpose: StoryContextPurposeSchema,
  revision: StoryContextRevisionSchema,
  renderedContext: z.string().max(STORY_CONTEXT_RENDERED_MAX_LENGTH),
  diagnostics: z.array(StoryContextDiagnosticSchema).max(500).default([]),
  omittedProjectCount: z.number().int().nonnegative().default(0),
  omittedSessionCount: z.number().int().nonnegative().default(0),
  sessionCandidateWindowOmittedCount: z.number().int().nonnegative().default(0),
}).strict();

export const StoryContextClosedSessionRequestSchema = z.object({
  storyId: StoryIdSchema,
  excludeSessionIds: z.array(SessionIdSchema).max(STORY_CONTEXT_SESSION_CANDIDATE_LIMIT).default([]),
  limit: z.number().int().min(1).max(STORY_CONTEXT_SESSION_CANDIDATE_LIMIT).default(STORY_CONTEXT_SESSION_CANDIDATE_LIMIT),
}).strict();

export const StoryContextSessionSummarySchema = z.object({
  instanceId: InstanceIdSchema,
  sessionId: SessionIdSchema,
  title: z.string().max(STORY_CONTEXT_SESSION_TITLE_MAX_LENGTH).optional(),
  agent: z.string().trim().min(1).max(120),
  status: z.string().trim().min(1).max(80).optional(),
  userPrompt: z.string().max(STORY_CONTEXT_SESSION_USER_PROMPT_MAX_LENGTH).optional(),
  lastResponse: z.string().max(STORY_CONTEXT_SESSION_LAST_RESPONSE_MAX_LENGTH).optional(),
  lastActivityAt: TimestampSchema,
}).strict();

export const StoryContextClosedSessionResultSchema = z.object({
  protocolVersion: z.literal(STORY_CONTEXT_CLOSED_SESSIONS_PROTOCOL_VERSION),
  storyId: StoryIdSchema,
  sessions: z.array(StoryContextSessionSummarySchema).max(STORY_CONTEXT_SESSION_CANDIDATE_LIMIT),
  omittedCount: z.number().int().nonnegative().default(0),
  diagnostics: z.array(StoryContextSessionDiagnosticSchema).max(500).default([]),
}).strict();

export const StoryContextRenderProjectSchema = z.object({
  folderId: FolderIdSchema,
  name: z.string().trim().min(1).max(240),
  path: z.string().trim().min(1).max(4_096),
}).strict();

export const StoryContextRenderInputSchema = z.object({
  storyId: StoryIdSchema,
  revision: StoryContextRevisionSchema,
  purpose: StoryContextPurposeSchema,
  appendedPrompt: z.string().max(STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH).default(""),
  projects: z.array(StoryContextRenderProjectSchema).max(STORY_CONTEXT_MAX_PROJECTS).default([]),
  sessions: z.array(StoryContextSessionSummarySchema).max(STORY_CONTEXT_SESSION_CANDIDATE_LIMIT).default([]),
  diagnostics: z.array(StoryContextDiagnosticSchema).max(500).default([]),
  omittedProjectCount: z.number().int().nonnegative().default(0),
  omittedSessionCount: z.number().int().nonnegative().default(0),
  sessionCandidateWindowOmittedCount: z.number().int().nonnegative().default(0),
}).strict();

export const StoryContextRenderResultSchema = z.object({
  renderedContext: z.string().max(STORY_CONTEXT_RENDERED_MAX_LENGTH),
  diagnostics: z.array(StoryContextDiagnosticSchema).max(500),
  omittedProjectCount: z.number().int().nonnegative(),
  omittedSessionCount: z.number().int().nonnegative(),
  sessionCandidateWindowOmittedCount: z.number().int().nonnegative(),
}).strict();

export type StoryContextSettings = z.infer<typeof StoryContextSettingsSchema>;
export type StoryContextSettingsUpdateInput = z.infer<typeof StoryContextSettingsUpdateInputSchema>;
export type StoryContextPurpose = z.infer<typeof StoryContextPurposeSchema>;
export type StoryContextCaller = z.infer<typeof StoryContextCallerSchema>;
export type StoryContextResolveInput = z.infer<typeof StoryContextResolveInputSchema>;
export type StoryContextDiagnostic = z.infer<typeof StoryContextDiagnosticSchema>;
export type StoryContextProjectDiagnostic = z.infer<typeof StoryContextProjectDiagnosticSchema>;
export type StoryContextSessionDiagnostic = z.infer<typeof StoryContextSessionDiagnosticSchema>;
export type StoryContextResolution = z.infer<typeof StoryContextResolutionSchema>;
export type StoryContextClosedSessionRequest = z.infer<typeof StoryContextClosedSessionRequestSchema>;
export type StoryContextSessionSummary = z.infer<typeof StoryContextSessionSummarySchema>;
export type StoryContextClosedSessionResult = z.infer<typeof StoryContextClosedSessionResultSchema>;
export type StoryContextRenderProject = z.infer<typeof StoryContextRenderProjectSchema>;
export type StoryContextRenderInput = z.infer<typeof StoryContextRenderInputSchema>;
export type StoryContextRenderResult = z.infer<typeof StoryContextRenderResultSchema>;

const StoryContextDiagnosticConsumerSchema = StoryContextDiagnosticSchema.strip();
const StoryContextSessionDiagnosticConsumerSchema = StoryContextSessionDiagnosticSchema.strip();
const StoryContextSessionSummaryConsumerSchema = StoryContextSessionSummarySchema.strip();
const StoryContextResolutionConsumerSchema = StoryContextResolutionSchema.extend({
  diagnostics: z.array(StoryContextDiagnosticConsumerSchema).max(500).default([]),
}).strip();
const StoryContextClosedSessionResultConsumerSchema = StoryContextClosedSessionResultSchema.extend({
  sessions: z.array(StoryContextSessionSummaryConsumerSchema).max(STORY_CONTEXT_SESSION_CANDIDATE_LIMIT),
  diagnostics: z.array(StoryContextSessionDiagnosticConsumerSchema).max(500).default([]),
}).strip();

export function sanitizeStoryContextResolution(input: unknown) {
  return StoryContextResolutionConsumerSchema.parse(input);
}

export function sanitizeStoryContextClosedSessionResult(input: unknown) {
  return StoryContextClosedSessionResultConsumerSchema.parse(input);
}

const TRUNCATION_MARKER = "\n… [truncated]";

function truncateWithMarker(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  if (maxLength <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, Math.max(0, maxLength));
  return `${value.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function truncateField(value: string | undefined, maxLength: number) {
  if (!value) return undefined;
  return truncateWithMarker(value, maxLength);
}

function section(title: string, body: string) {
  return body ? `## ${title}\n${body}` : "";
}

function joinSections(sections: string[]) {
  return sections.filter(Boolean).join("\n\n");
}

function projectEntry(project: StoryContextRenderProject, index: number) {
  return `${index + 1}. ${project.name}\n   Path: ${project.path}`;
}

function renderProjectSection(input: StoryContextRenderInput) {
  if (!input.projects.length) {
    return { body: "", omittedCount: input.omittedProjectCount };
  }
  const header = "";
  let body = header;
  let kept = 0;
  for (const [index, project] of input.projects.entries()) {
    const entry = projectEntry(project, index);
    const candidate = body ? `${body}\n\n${entry}` : entry;
    if (candidate.length > STORY_CONTEXT_PROJECT_BLOCK_MAX_LENGTH) break;
    body = candidate;
    kept += 1;
  }
  const omittedCount = input.omittedProjectCount + input.projects.length - kept;
  if (omittedCount > 0) {
    const marker = `… ${omittedCount} project(s) omitted (context budget).`;
    const candidate = body ? `${body}\n\n${marker}` : marker;
    body = truncateWithMarker(candidate, STORY_CONTEXT_PROJECT_BLOCK_MAX_LENGTH);
  }
  return { body, omittedCount };
}

function sessionEntry(session: StoryContextSessionSummary, index: number) {
  const title = truncateField(session.title, STORY_CONTEXT_SESSION_TITLE_MAX_LENGTH) || session.sessionId;
  const lines = [
    `### ${index + 1}. ${title}`,
    `- Session: ${session.sessionId}`,
    `- Agent: ${session.agent}`,
  ];
  if (session.status) lines.push(`- Status: ${session.status}`);
  lines.push(`- Last active: ${session.lastActivityAt}`);
  const userPrompt = truncateField(session.userPrompt, STORY_CONTEXT_SESSION_USER_PROMPT_MAX_LENGTH);
  if (userPrompt) lines.push(`- Original user request: ${userPrompt}`);
  const lastResponse = truncateField(session.lastResponse, STORY_CONTEXT_SESSION_LAST_RESPONSE_MAX_LENGTH);
  if (lastResponse) lines.push(`- Last response: ${lastResponse}`);
  return truncateWithMarker(lines.join("\n"), STORY_CONTEXT_SESSION_SUMMARY_MAX_LENGTH);
}

function renderSessionSection(input: StoryContextRenderInput) {
  if (input.purpose !== "agent-run" || !input.sessions.length) {
    return {
      body: "",
      omittedCount: input.omittedSessionCount + input.sessionCandidateWindowOmittedCount,
    };
  }
  let body = "";
  let kept = 0;
  for (const [index, session] of input.sessions.entries()) {
    const entry = sessionEntry(session, index);
    const candidate = body ? `${body}\n\n${entry}` : entry;
    if (candidate.length > STORY_CONTEXT_SESSION_BLOCK_MAX_LENGTH) break;
    body = candidate;
    kept += 1;
  }
  const omittedCount = input.omittedSessionCount + input.sessionCandidateWindowOmittedCount + input.sessions.length - kept;
  if (omittedCount > 0) {
    const marker = `… ${omittedCount} session(s) omitted (context budget).`;
    const candidate = body ? `${body}\n\n${marker}` : marker;
    body = truncateWithMarker(candidate, STORY_CONTEXT_SESSION_BLOCK_MAX_LENGTH);
  }
  return { body, omittedCount };
}

/** Pure, deterministic renderer shared by Node Agent and parity tests. Only Node Agent calls it in production. */
export function renderStoryContext(rawInput: StoryContextRenderInput): StoryContextRenderResult {
  const input = StoryContextRenderInputSchema.parse(rawInput);
  const diagnostics = [...input.diagnostics];
  const storySection = section("Story additional instructions", input.appendedPrompt);
  const projects = renderProjectSection(input);
  const sessions = renderSessionSection(input);
  const projectSection = section("Attached projects (context only, not mounted)", projects.body);
  const sessionSection = section("Associated AI Sessions", sessions.body);
  let renderedContext = joinSections([storySection, projectSection, sessionSection]);
  if (renderedContext.length > STORY_CONTEXT_RENDERED_MAX_LENGTH) {
    renderedContext = truncateWithMarker(renderedContext, STORY_CONTEXT_RENDERED_MAX_LENGTH);
    diagnostics.push({
      code: "story-context-truncated",
      message: "Story context exceeded the total character budget and was truncated.",
    });
  }
  if (projects.omittedCount > 0) {
    diagnostics.push({
      code: "story-context-projects-truncated",
      message: `${projects.omittedCount} Story project(s) were omitted from the rendered context.`,
    });
  }
  if (sessions.omittedCount > 0) {
    diagnostics.push({
      code: "story-context-sessions-truncated",
      message: `${sessions.omittedCount} Story session(s) were omitted from the rendered context.`,
    });
  }
  return StoryContextRenderResultSchema.parse({
    renderedContext,
    diagnostics,
    omittedProjectCount: projects.omittedCount,
    omittedSessionCount: sessions.omittedCount,
    sessionCandidateWindowOmittedCount: input.sessionCandidateWindowOmittedCount,
  });
}

/** Compose a member's own Agent prompt before the frozen, already-rendered Story context. */
export function composeAgentRunAppendedPrompt(agentPrompt: string, renderedContext: string) {
  const separator = "\n\n";
  if (!agentPrompt) return renderedContext.slice(0, STORY_CONTEXT_MEMBER_APPENDED_PROMPT_MAX_LENGTH);
  if (!renderedContext) return agentPrompt.slice(0, STORY_CONTEXT_MEMBER_APPENDED_PROMPT_MAX_LENGTH);
  const available = STORY_CONTEXT_MEMBER_APPENDED_PROMPT_MAX_LENGTH - agentPrompt.length - separator.length;
  if (available <= 0) return agentPrompt.slice(0, STORY_CONTEXT_MEMBER_APPENDED_PROMPT_MAX_LENGTH);
  return `${agentPrompt}${separator}${truncateWithMarker(renderedContext, available)}`;
}
