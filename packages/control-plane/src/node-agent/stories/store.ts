import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  STORY_DEFAULT_MAX_IDLE_AI_SESSIONS,
  STORY_DEFAULT_MAX_FILE_BYTES,
  StoryActionSchema,
  StoryCreateInputSchema,
  StoryPathSchema,
  StoryDocumentOrderInputSchema,
  StorySchema,
  StoryUpdateInputSchema,
  StorySessionRetentionSettingsSchema,
  type StorySessionRetentionSettings,
  type Story,
  type StoryCreateInput,
  type StoryUpdateInput,
} from "@task-handoff/protocol/stories";
import { JsonCollection, createId } from "../../shared/persistence/store.ts";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";

const StoredStoryDocumentSchema = z.object({
  title: z.string().trim().min(1).max(240),
  storyPath: StoryPathSchema,
}).strict();

const StoredStorySchema = z.object({
  id: StorySchema.shape.id,
  title: StorySchema.shape.title,
  description: StorySchema.shape.description,
  documents: z.array(StoredStoryDocumentSchema).max(500).default([]),
  actions: StorySchema.shape.actions,
  createdAt: StorySchema.shape.createdAt,
  updatedAt: StorySchema.shape.updatedAt,
  archivedAt: StorySchema.shape.archivedAt,
  maxIdleAiSessions: StorySessionRetentionSettingsSchema.shape.maxIdleAiSessions.default(STORY_DEFAULT_MAX_IDLE_AI_SESSIONS),
}).strict();

type StoredStory = z.infer<typeof StoredStorySchema>;

export type StoryWriteInput = {
  storyPath: string;
  title?: string;
  expectedRevision?: string;
  stream: NodeJS.ReadableStream;
};

export type StoryChangeReason =
  | "created"
  | "updated"
  | "archived"
  | "restored"
  | "deleted"
  | "content.written"
  | "document.updated"
  | "document.reordered"
  | "document.deleted";

type StoryChangeCallback = (change: StoryChangeReason, story: Story) => void;

function storyError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

export class NodeStoryStore {
  private readonly records: JsonCollection<StoredStory>;
  private readonly paths: NodeAgentStorePaths;
  private readonly ownerNodeId: string;
  private readonly maxFileBytes: number;
  private onChange?: StoryChangeCallback;

  constructor(
    paths: NodeAgentStorePaths,
    ownerNodeId: string,
    maxFileBytes = STORY_DEFAULT_MAX_FILE_BYTES,
    onChange?: StoryChangeCallback,
  ) {
    this.paths = paths;
    this.ownerNodeId = ownerNodeId;
    this.maxFileBytes = maxFileBytes;
    this.onChange = onChange;
    this.records = new JsonCollection(paths.storyRegistryDir, { schema: StoredStorySchema });
  }

  init() {
    this.records.init();
    fs.mkdirSync(this.paths.storyContentDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.paths.storyContentDir, 0o700);
  }

  setOnChange(callback: StoryChangeCallback) {
    this.onChange = callback;
  }

  list() {
    return this.records.list().map((story) => this.project(story));
  }

  get(id: string) {
    const story = this.records.get(id);
    return story ? this.project(story) : undefined;
  }

  require(id: string) {
    const story = this.records.get(id);
    if (!story) throw storyError("STORY_NOT_FOUND", "Story was not found.", 404);
    return story;
  }

  create(input: StoryCreateInput) {
    const parsed = StoryCreateInputSchema.parse(input);
    const timestamp = new Date().toISOString();
    const id = createId("story");
    const story = StoredStorySchema.parse({
      id,
      title: parsed.title,
      description: parsed.description,
      actions: (parsed.actions || []).map((action) => StoryActionSchema.parse({
        ...action,
        id: createId("story_action"),
      })),
      documents: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      maxIdleAiSessions: parsed.maxIdleAiSessions ?? STORY_DEFAULT_MAX_IDLE_AI_SESSIONS,
    });
    fs.mkdirSync(this.storyRoot(id), { recursive: true, mode: 0o700 });
    const projected = this.project(this.records.put(story));
    this.onChange?.("created", projected);
    return projected;
  }

  retentionSettings(id: string): StorySessionRetentionSettings {
    return StorySessionRetentionSettingsSchema.parse({ maxIdleAiSessions: this.require(id).maxIdleAiSessions });
  }

  update(id: string, input: StoryUpdateInput) {
    const current = this.require(id);
    const parsed = StoryUpdateInputSchema.parse(input);
    const updated = this.records.put(StoredStorySchema.parse({
      ...current,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description || undefined } : {}),
      ...(parsed.actions !== undefined ? { actions: parsed.actions.map((action) => StoryActionSchema.parse({
        ...action,
        id: action.id || createId("story_action"),
      })) } : {}),
      ...(parsed.maxIdleAiSessions !== undefined ? { maxIdleAiSessions: parsed.maxIdleAiSessions } : {}),
      updatedAt: new Date().toISOString(),
    }));
    const projected = this.project(updated);
    this.onChange?.("updated", projected);
    return projected;
  }

  archive(id: string) {
    const current = this.require(id);
    const timestamp = new Date().toISOString();
    const projected = this.project(this.records.put({ ...current, archivedAt: timestamp, updatedAt: timestamp }));
    this.onChange?.("archived", projected);
    return projected;
  }

  restore(id: string) {
    const current = this.require(id);
    const projected = this.project(this.records.put({ ...current, archivedAt: undefined, updatedAt: new Date().toISOString() }));
    this.onChange?.("restored", projected);
    return projected;
  }

  delete(id: string) {
    const existing = this.require(id);
    const projected = this.project(existing);
    fs.rmSync(this.storyRoot(id), { recursive: true, force: true });
    const deleted = this.records.delete(id);
    this.onChange?.("deleted", projected);
    return deleted;
  }

  listContent(id: string) {
    return this.project(this.require(id)).documents;
  }

  filePath(id: string, storyPath: string) {
    this.require(id);
    const normalized = StoryPathSchema.parse(storyPath);
    const root = this.storyRoot(id);
    const target = path.resolve(root, ...normalized.split("/"));
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw storyError("STORY_PATH_OUTSIDE_ROOT", "Story path is outside the Story directory.", 400);
    }
    return target;
  }

  readContent(id: string, storyPath: string) {
    const story = this.require(id);
    if (!story.documents.some((document) => document.storyPath === storyPath)) {
      throw storyError("STORY_CONTENT_NOT_INDEXED", "Story content is not indexed.", 404);
    }
    const filePath = this.filePath(id, storyPath);
    const stat = this.regularFileStat(filePath);
    return { filePath, size: stat.size, revision: this.hashFile(filePath) };
  }

  async writeContent(id: string, input: StoryWriteInput) {
    const story = this.require(id);
    if (story.archivedAt) throw storyError("STORY_ARCHIVED", "Archived Story content is read-only.", 409);
    const storyPath = StoryPathSchema.parse(input.storyPath);
    const existing = story.documents.find((document) => document.storyPath === storyPath);
    if (existing) {
      if (!input.expectedRevision) throw storyError("STORY_REVISION_REQUIRED", "expectedRevision is required when replacing Story content.", 409);
      const current = this.readContent(id, storyPath);
      if (current.revision !== input.expectedRevision) throw storyError("STORY_REVISION_CONFLICT", "Story content changed since it was read.", 409);
    } else if (!input.title?.trim()) {
      throw storyError("STORY_CONTENT_TITLE_REQUIRED", "A title is required for new Story content.", 400);
    }
    const target = this.filePath(id, storyPath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let bytes = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.byteLength;
        if (bytes > this.maxFileBytes) {
          callback(storyError("STORY_FILE_TOO_LARGE", "Story content exceeds the node limit.", 413));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(input.stream as NodeJS.ReadableStream & AsyncIterable<Uint8Array>, limiter, fs.createWriteStream(temporary, { mode: 0o600 }));
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    const documents = existing
      ? story.documents.map((document) => document.storyPath === storyPath
        ? { ...document, ...(input.title?.trim() ? { title: input.title.trim() } : {}) }
        : document)
      : [...story.documents, { title: input.title!.trim(), storyPath }];
    const projected = this.project(this.records.put({ ...story, documents, updatedAt: new Date().toISOString() }));
    this.onChange?.("content.written", projected);
    return { storyPath, revision: this.hashFile(target), size: bytes };
  }

  updateDocument(id: string, currentPath: string, input: { title?: string; storyPath?: string }) {
    const story = this.require(id);
    const current = StoryPathSchema.parse(currentPath);
    const index = story.documents.findIndex((document) => document.storyPath === current);
    if (index < 0) throw storyError("STORY_CONTENT_NOT_INDEXED", "Story content is not indexed.", 404);
    const nextPath = input.storyPath ? StoryPathSchema.parse(input.storyPath) : current;
    if (nextPath !== current && story.documents.some((document) => document.storyPath === nextPath)) {
      throw storyError("STORY_PATH_CONFLICT", "Story path is already indexed.", 409);
    }
    if (nextPath !== current) {
      const source = this.filePath(id, current);
      const target = this.filePath(id, nextPath);
      this.regularFileStat(source);
      try {
        fs.lstatSync(target);
        throw storyError("STORY_PATH_CONFLICT", "Story path already exists on disk.", 409);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(source, target);
    }
    const documents = [...story.documents];
    documents[index] = {
      title: input.title?.trim() || documents[index]!.title,
      storyPath: nextPath,
    };
    const projected = this.project(this.records.put({ ...story, documents, updatedAt: new Date().toISOString() }));
    this.onChange?.("document.updated", projected);
    return projected;
  }

  reorderDocuments(id: string, input: unknown) {
    const story = this.require(id);
    const { storyPaths } = StoryDocumentOrderInputSchema.parse(input);
    const existingPaths = story.documents.map((document) => document.storyPath);
    if (storyPaths.length !== existingPaths.length
      || new Set(storyPaths).size !== storyPaths.length
      || existingPaths.some((storyPath) => !storyPaths.includes(storyPath))) {
      throw storyError("STORY_DOCUMENT_ORDER_INVALID", "Document order must contain every indexed storyPath exactly once.", 400);
    }
    const byPath = new Map(story.documents.map((document) => [document.storyPath, document]));
    const documents = storyPaths.map((storyPath) => byPath.get(storyPath)!);
    const projected = this.project(this.records.put({ ...story, documents, updatedAt: new Date().toISOString() }));
    this.onChange?.("document.reordered", projected);
    return projected;
  }

  deleteDocument(id: string, storyPath: string) {
    const story = this.require(id);
    const normalized = StoryPathSchema.parse(storyPath);
    if (!story.documents.some((document) => document.storyPath === normalized)) return false;
    fs.rmSync(this.filePath(id, normalized), { force: true });
    const projected = this.project(this.records.put({
      ...story,
      documents: story.documents.filter((document) => document.storyPath !== normalized),
      updatedAt: new Date().toISOString(),
    }));
    this.onChange?.("document.deleted", projected);
    return true;
  }

  private project(story: StoredStory): Story {
    const valid = story.documents.flatMap((document) => {
      const filePath = this.filePathWithoutLookup(story.id, document.storyPath);
      try {
        this.regularFileStat(filePath);
        return [{ ...document, revision: this.hashFile(filePath) }];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
    if (valid.length !== story.documents.length) {
      story = this.records.put({ ...story, documents: valid.map(({ revision: _revision, ...document }) => document), updatedAt: new Date().toISOString() });
    }
    const { maxIdleAiSessions: _maxIdleAiSessions, ...publicStory } = story;
    return StorySchema.parse({ ...publicStory, ownerNodeId: this.ownerNodeId, documents: valid });
  }

  private storyRoot(id: string) {
    return path.resolve(this.paths.storyContentDir, StorySchema.shape.id.parse(id));
  }

  private filePathWithoutLookup(id: string, storyPath: string) {
    const root = this.storyRoot(id);
    const target = path.resolve(root, ...StoryPathSchema.parse(storyPath).split("/"));
    if (!target.startsWith(`${root}${path.sep}`)) throw storyError("STORY_PATH_OUTSIDE_ROOT", "Story path is outside the Story directory.", 400);
    return target;
  }

  private regularFileStat(filePath: string) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw storyError("STORY_CONTENT_NOT_FILE", "Story content must be a regular file.", 409);
    if (stat.size > this.maxFileBytes) throw storyError("STORY_FILE_TOO_LARGE", "Story content exceeds the node limit.", 413);
    return stat;
  }

  private hashFile(filePath: string) {
    const hash = crypto.createHash("sha256");
    const descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      let bytesRead = 0;
      do {
        bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      fs.closeSync(descriptor);
    }
    return hash.digest("hex");
  }
}
