import assert from "node:assert/strict";
import test from "node:test";
import {
  STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH,
  STORY_CONTEXT_MAX_PROJECTS,
  STORY_CONTEXT_RENDERED_MAX_LENGTH,
  StoryContextResolutionSchema,
  StoryContextSettingsSchema,
  StoryContextSettingsUpdateInputSchema,
  composeAgentRunAppendedPrompt,
  renderStoryContext,
  sanitizeStoryContextClosedSessionResult,
  sanitizeStoryContextResolution,
  sanitizeStoryContextSettings,
} from "../src/story-context.ts";
import {
  normalizeNodeAgentCapabilities,
  supportsNodeStoryContextProjects,
  supportsNodeStoryContextSettings,
  supportsNodeStorySessionPrompting,
} from "../src/node-agent-capabilities.ts";
import { StoryListSchema, StorySchema } from "../src/stories.ts";

const settings = {
  storyId: "story_1",
  revision: 0,
  projectFolderIds: ["folder_a", "folder_b"],
  appendedPrompt: "Follow the Story rules.",
  updatedAt: "2026-11-26T00:00:00.000Z",
};

test("Story context settings keep the base Story wire model separate and validate bounded strict writes", () => {
  assert.equal(StoryContextSettingsSchema.parse(settings).revision, 0);
  assert.equal(sanitizeStoryContextSettings({ ...settings, future: true }).storyId, "story_1");
  assert.equal("future" in sanitizeStoryContextSettings({ ...settings, future: true }), false);
  assert.equal(StoryContextSettingsUpdateInputSchema.safeParse({
    expectedRevision: 0,
    projectFolderIds: ["folder_a"],
    appendedPrompt: "",
  }).success, true);
  assert.equal(StoryContextSettingsUpdateInputSchema.safeParse({
    expectedRevision: 0,
    projectFolderIds: ["folder_a"],
    appendedPrompt: "",
    future: true,
  }).success, false);
  assert.equal(StoryContextSettingsUpdateInputSchema.safeParse({
    expectedRevision: 0,
    projectFolderIds: Array.from({ length: STORY_CONTEXT_MAX_PROJECTS + 1 }, (_, index) => `folder_${index}`),
    appendedPrompt: "",
  }).success, false);
  assert.equal(StoryContextSettingsUpdateInputSchema.safeParse({
    expectedRevision: 0,
    projectFolderIds: [],
    appendedPrompt: "x".repeat(STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH + 1),
  }).success, false);
});

test("Story context capability is additive and normalize missing or invalid fields to unsupported", () => {
  assert.equal(supportsNodeStoryContextSettings({}), false);
  assert.equal(supportsNodeStoryContextProjects({ stories: { contextSettings: { settings: true } } }), false);
  assert.equal(supportsNodeStorySessionPrompting({ stories: { contextSettings: { settings: true, sessionPrompting: true } } }), true);
  const normalized = normalizeNodeAgentCapabilities({
    stories: { enabled: true, contextSettings: { settings: true, projects: true, future: true } },
  });
  assert.deepEqual(normalized.stories.contextSettings, { settings: true, projects: true, sessionPrompting: false });
  const malformed = normalizeNodeAgentCapabilities({
    controlPlaneTrust: true,
    stories: { enabled: true, sessionRetention: true, contextSettings: { settings: "yes" } },
  });
  assert.equal(malformed.controlPlaneTrust, true);
  assert.equal(malformed.stories.enabled, true);
  assert.equal(malformed.stories.sessionRetention, true);
  assert.deepEqual(malformed.stories.contextSettings, { settings: false, projects: false, sessionPrompting: false });
});

test("Story list and detail models stay unchanged for old clients", () => {
  const story = {
    id: "story_1",
    ownerNodeId: "node_1",
    title: "Story",
    documents: [],
    actions: [],
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
  };
  assert.deepEqual(StoryListSchema.parse({ stories: [story] }).stories[0], story);
  assert.equal(StorySchema.safeParse({ ...story, contextSettings: settings }).success, false);
  assert.equal(StoryListSchema.safeParse({ stories: [story], contextSettings: settings }).success, false);
});

test("Story context renderer uses one deterministic block order and omits empty sections", () => {
  const input = {
    storyId: "story_1",
    revision: 3,
    purpose: "agent-run" as const,
    appendedPrompt: "Keep API compatibility.",
    projects: [
      { folderId: "folder_a", name: "Alpha", path: "/work/alpha" },
      { folderId: "folder_b", name: "Beta", path: "/work/beta" },
    ],
    sessions: [
      {
        instanceId: "instance_1",
        sessionId: "session_1",
        title: "Design review",
        agent: "codex",
        status: "completed",
        userPrompt: "Review the design",
        lastResponse: "Approved with one note",
        lastActivityAt: "2026-11-26T01:00:00.000Z",
      },
    ],
  };
  const first = renderStoryContext(input);
  const second = renderStoryContext(input);
  assert.deepEqual(first, second);
  const rendered = first.renderedContext;
  assert.ok(rendered.indexOf("## Story additional instructions") < rendered.indexOf("## Attached projects"));
  assert.ok(rendered.indexOf("## Attached projects") < rendered.indexOf("## Associated AI Sessions"));
  assert.match(rendered, /1\. Alpha\n   Path: \/work\/alpha/);
  assert.match(rendered, /Original user request: Review the design/);
  assert.equal(renderStoryContext({
    storyId: "story_1",
    revision: 0,
    purpose: "session-create",
    appendedPrompt: "",
    projects: [],
    sessions: [],
  }).renderedContext, "");
  assert.equal(renderStoryContext({ ...input, purpose: "session-create" }).renderedContext.includes("Associated AI Sessions"), false);
});

test("Story context renderer preserves ordinary text characters without evaluating templates", () => {
  const rendered = renderStoryContext({
    storyId: "story_1",
    revision: 1,
    purpose: "session-create",
    appendedPrompt: "Use `${HOME}` and {braces} literally.",
    projects: [{ folderId: "folder_a", name: "A `name` $HOME", path: "/work/{project}/$HOME" }],
  }).renderedContext;
  assert.match(rendered, /\$\{HOME\}/);
  assert.match(rendered, /A `name` \$HOME/);
  assert.match(rendered, /\/work\/\{project\}\/\$HOME/);
});

test("Story context budgets truncate deterministically and stay within protocol limits", () => {
  const sessions = Array.from({ length: 200 }, (_, index) => ({
    instanceId: `instance_${index}`,
    sessionId: `session_${index}`,
    title: `Session ${index}`,
    agent: "codex",
    userPrompt: "u".repeat(600),
    lastResponse: "r".repeat(800),
    lastActivityAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const rendered = renderStoryContext({
    storyId: "story_1",
    revision: 1,
    purpose: "agent-run",
    appendedPrompt: "s".repeat(STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH),
    projects: Array.from({ length: STORY_CONTEXT_MAX_PROJECTS }, (_, index) => ({
      folderId: `folder_${index}`,
      name: `Project ${index}`,
      path: `/work/${"p".repeat(180)}/${index}`,
    })),
    sessions,
  });
  assert.ok(rendered.renderedContext.length <= STORY_CONTEXT_RENDERED_MAX_LENGTH);
  assert.ok(rendered.omittedProjectCount > 0);
  assert.ok(rendered.omittedSessionCount > 0);
  assert.ok(rendered.diagnostics.some((entry) => entry.code === "story-context-projects-truncated"));
  assert.ok(rendered.diagnostics.some((entry) => entry.code === "story-context-sessions-truncated"));
  assert.match(rendered.renderedContext, /omitted \(context budget\)/);
});

test("Agent Run member composition keeps the Agent prompt intact and caps only Story context", () => {
  const agentPrompt = "a".repeat(30_000);
  const storyContext = "s".repeat(STORY_CONTEXT_RENDERED_MAX_LENGTH);
  const combined = composeAgentRunAppendedPrompt(agentPrompt, storyContext);
  assert.ok(combined.length <= 32_000);
  assert.ok(combined.startsWith(agentPrompt));
  assert.match(combined.slice(agentPrompt.length), /\[truncated\]/);
});

test("Story context resolution rejects provider-private or oversized fields", () => {
  const value = {
    protocolVersion: "2026-11-26",
    storyId: "story_1",
    nodeId: "node_1",
    purpose: "session-create",
    revision: 2,
    renderedContext: "context",
    diagnostics: [],
    omittedProjectCount: 0,
    omittedSessionCount: 0,
    sessionCandidateWindowOmittedCount: 0,
  };
  assert.equal(StoryContextResolutionSchema.safeParse(value).success, true);
  assert.equal(StoryContextResolutionSchema.safeParse({ ...value, transcript: ["secret"] }).success, false);
  assert.equal(StoryContextResolutionSchema.safeParse({ ...value, renderedContext: "x".repeat(STORY_CONTEXT_RENDERED_MAX_LENGTH + 1) }).success, false);
});

test("Story context consumers ignore future nested fields without losing known data", () => {
  const resolution = sanitizeStoryContextResolution({
    protocolVersion: "2026-11-26",
    storyId: "story_1",
    nodeId: "node_1",
    purpose: "agent-run",
    revision: 2,
    renderedContext: "context",
    diagnostics: [{ code: "story-context-project-missing", message: "missing", future: "ignored" }],
    omittedProjectCount: 1,
    omittedSessionCount: 0,
    sessionCandidateWindowOmittedCount: 0,
    future: "ignored",
  });
  assert.deepEqual(resolution.diagnostics, [{ code: "story-context-project-missing", message: "missing" }]);
  assert.equal(resolution.future, undefined);

  const closed = sanitizeStoryContextClosedSessionResult({
    protocolVersion: "2026-11-26",
    storyId: "story_1",
    sessions: [{
      instanceId: "instance_1",
      sessionId: "session_1",
      agent: "codex",
      lastActivityAt: "2026-11-26T00:00:00.000Z",
      future: "ignored",
    }],
    omittedCount: 0,
    diagnostics: [{ code: "read-failed", future: "ignored" }],
    future: "ignored",
  });
  assert.equal(closed.sessions[0]?.future, undefined);
  assert.deepEqual(closed.diagnostics, [{ code: "read-failed" }]);
});
