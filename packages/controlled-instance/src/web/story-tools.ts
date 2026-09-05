import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  STORY_DEFAULT_MAX_FILE_BYTES,
  StoryContentGetInputSchema,
  StoryContentGetResultSchema,
  StoryContentSetInputSchema,
  StoryPathSchema,
} from "@task-handoff/protocol/stories";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { NodeAgentRegistrationClient } from "./node-agent-client.ts";

const STORY_CONTENT_DEFAULT_PAGE_SIZE = 20;
const STORY_CONTENT_MAX_PAGE_SIZE = 100;

const StoryContentListToolInputSchema = z.object({
  page: z.number().int().min(1).max(500).default(1),
  pageSize: z.number().int().min(1).max(STORY_CONTENT_MAX_PAGE_SIZE).default(STORY_CONTENT_DEFAULT_PAGE_SIZE),
}).strict();

export const STORY_DYNAMIC_TOOLS = [
  {
    type: "function" as const,
    name: "story_list_content",
    description: "List a page of indexed documents in the Story assigned to the current AI Session, ordered newest to oldest. Start with page 1, increment page while pagination.hasMore is true, then pass selected storyPath values to story_get_content.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1, maximum: 500, default: 1, description: "One-based page number." },
        pageSize: { type: "integer", minimum: 1, maximum: STORY_CONTENT_MAX_PAGE_SIZE, default: STORY_CONTENT_DEFAULT_PAGE_SIZE, description: "Maximum documents to return per page." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "story_get_content",
    description: "Copy one or more Story documents selected by exact storyPath from story_list_content into a directory in the current workspace. Files retain their Story-relative paths; read the returned local paths with workspace tools.",
    inputSchema: {
      type: "object",
      properties: {
        storyPaths: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
        destinationPath: { type: "string" },
      },
      required: ["storyPaths", "destinationPath"],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "story_set_content",
    description: "Create or replace one indexed Story document from a regular file in the current workspace. A new document requires title; replacing one requires the expectedRevision returned by story_list_content or story_get_content.",
    inputSchema: {
      type: "object",
      properties: {
        storyPath: { type: "string" },
        title: { type: "string" },
        sourcePath: { type: "string" },
        expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["storyPath", "sourcePath"],
      additionalProperties: false,
    },
  },
];

function storyToolError(code: string, message: string, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function workspaceRoot(session: AiSessionStatus) {
  if (!session.cwd) throw storyToolError("AI_SESSION_WORKSPACE_REQUIRED", "AI Session has no workspace.", 409);
  const root = fs.realpathSync(session.cwd);
  if (!fs.lstatSync(root).isDirectory()) throw storyToolError("AI_SESSION_WORKSPACE_INVALID", "AI Session workspace is not a directory.", 409);
  return root;
}

function requireWithinWorkspace(session: AiSessionStatus, candidate: string, mustExist = false) {
  const root = workspaceRoot(session);
  const lexicalTarget = path.resolve(candidate);
  let existing = lexicalTarget;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const canonicalBase = fs.realpathSync(existing);
  const target = mustExist ? fs.realpathSync(lexicalTarget) : path.resolve(canonicalBase, path.relative(existing, lexicalTarget));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw storyToolError("STORY_RUNTIME_PATH_OUTSIDE_WORKSPACE", "Story runtime path is outside the AI Session workspace.", 403);
  }
  if (fs.existsSync(lexicalTarget) && fs.lstatSync(lexicalTarget).isSymbolicLink()) {
    throw storyToolError("STORY_RUNTIME_PATH_SYMLINK", "Story runtime path must not be a symbolic link.", 403);
  }
  return target;
}

export class StoryAgentToolService {
  private readonly nodeAgent: NodeAgentRegistrationClient;

  constructor(nodeAgent: NodeAgentRegistrationClient) {
    this.nodeAgent = nodeAgent;
  }

  list(session: AiSessionStatus) {
    this.requireStory(session);
    return this.nodeAgent.listStoryContent(session.id);
  }

  async invoke(session: AiSessionStatus, tool: string, value: unknown) {
    if (tool === "story_list_content") {
      const { page, pageSize } = StoryContentListToolInputSchema.parse(value ?? {});
      const documents = [...await this.list(session)].reverse();
      const offset = (page - 1) * pageSize;
      return {
        documents: documents.slice(offset, offset + pageSize),
        pagination: {
          page,
          pageSize,
          totalItems: documents.length,
          totalPages: Math.ceil(documents.length / pageSize),
          hasMore: offset + pageSize < documents.length,
        },
      };
    }
    if (tool === "story_get_content") return this.get(session, value);
    if (tool === "story_set_content") return this.set(session, value);
    throw storyToolError("STORY_TOOL_NOT_FOUND", `Unknown Story tool: ${tool}`, 404);
  }

  async get(session: AiSessionStatus, value: unknown, signal?: AbortSignal) {
    this.requireStory(session);
    const input = StoryContentGetInputSchema.parse(value);
    const destination = requireWithinWorkspace(session, input.destinationPath);
    fs.mkdirSync(destination, { recursive: true });
    const items: Array<Record<string, unknown>> = [];
    for (const storyPath of input.storyPaths) {
      try {
        const target = requireWithinWorkspace(session, path.join(destination, ...StoryPathSchema.parse(storyPath).split("/")));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        const downloaded = await this.nodeAgent.downloadStoryContent(session.id, storyPath, signal);
        try {
          await pipeline(Readable.fromWeb(downloaded.body as never), fs.createWriteStream(temporary, { mode: 0o600 }));
          fs.renameSync(temporary, target);
        } catch (error) {
          fs.rmSync(temporary, { force: true });
          throw error;
        }
        items.push({ storyPath, path: target, revision: downloaded.revision });
      } catch (error) {
        items.push({ storyPath, error: {
          code: typeof error === "object" && error && "code" in error ? String(error.code) : "STORY_CONTENT_GET_FAILED",
          message: error instanceof Error ? error.message : String(error),
        } });
      }
    }
    return StoryContentGetResultSchema.parse({ items });
  }

  async set(session: AiSessionStatus, value: unknown, signal?: AbortSignal) {
    this.requireStory(session);
    const input = StoryContentSetInputSchema.parse(value);
    const sourcePath = requireWithinWorkspace(session, input.sourcePath, true);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw storyToolError("STORY_SOURCE_NOT_FILE", "Story source must be a regular file.");
    if (stat.size > STORY_DEFAULT_MAX_FILE_BYTES) throw storyToolError("STORY_FILE_TOO_LARGE", "Story source exceeds the node limit.", 413);
    return this.nodeAgent.uploadStoryContent(session.id, {
      storyPath: input.storyPath,
      title: input.title,
      expectedRevision: input.expectedRevision,
      body: Readable.toWeb(fs.createReadStream(sourcePath)) as BodyInit,
      size: stat.size,
      signal,
    });
  }

  private requireStory(session: AiSessionStatus) {
    if (!session.storyId) throw storyToolError("STORY_CONTEXT_REQUIRED", "AI Session is not assigned to a Story.", 409);
    if (!this.nodeAgent.enabled()) throw storyToolError("STORY_NODE_AGENT_REQUIRED", "Story tools require a managed controlled instance.", 409);
  }
}
