import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  STORY_DEFAULT_MAX_FILE_BYTES,
  STORY_DEFAULT_MAX_IDLE_AI_SESSIONS,
  StoryActionSchema,
  StoryCreateInputSchema,
  StoryDocumentOrderInputSchema,
  StoryPathSchema,
  StorySchema,
  StorySessionRetentionSettingsSchema,
  StoryUpdateInputSchema,
  type Story,
  type StoryCreateInput,
  type StorySessionRetentionSettings,
  type StoryUpdateInput,
} from "@task-handoff/protocol/stories";
import { createId } from "../../shared/persistence/store.ts";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import type { NodeAgentRepository, StoryDocumentRecord, StoryRecord } from "./database/repository.ts";
import { StoryOperationCoordinator } from "./operation-coordinator.ts";

export type StoryWriteInput = {
  storyPath: string;
  title?: string;
  expectedRevision?: string;
  stream: NodeJS.ReadableStream;
};

export type StoryChangeReason =
  | "created" | "updated" | "archived" | "restored" | "deleted"
  | "content.written" | "document.updated" | "document.reordered" | "document.deleted";

type StoryChangeCallback = (change: StoryChangeReason, story: Story) => void;
export type StoryAutomationContext = Pick<Story, "id" | "archivedAt" | "actions">;

export class NodeStoryStore {
  readonly coordinator: StoryOperationCoordinator;
  private readonly paths: NodeAgentStorePaths;
  private readonly ownerNodeId: string;
  private readonly repository: NodeAgentRepository;
  private readonly maxFileBytes: number;
  private onChange?: StoryChangeCallback;

  constructor(
    paths: NodeAgentStorePaths,
    ownerNodeId: string,
    repository: NodeAgentRepository,
    maxFileBytes = STORY_DEFAULT_MAX_FILE_BYTES,
    onChange?: StoryChangeCallback,
  ) {
    this.paths = paths;
    this.ownerNodeId = ownerNodeId;
    this.repository = repository;
    this.maxFileBytes = maxFileBytes;
    this.onChange = onChange;
    this.coordinator = new StoryOperationCoordinator();
  }

  async init() {
    fs.mkdirSync(this.paths.storyMutationsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.storyTrashDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.paths.storyMutationsDir, 0o700);
    fs.chmodSync(this.paths.storyTrashDir, 0o700);
    await this.recoverFileMutations();
  }

  setOnChange(callback: StoryChangeCallback) { this.onChange = callback; }

  async list() {
    const records = await this.repository.stories.list();
    return Promise.all(records.map((story) => this.project(story)));
  }

  async get(id: string) {
    const story = await this.repository.stories.get(id);
    return story ? this.project(story) : undefined;
  }

  async require(id: string) {
    const story = await this.repository.stories.get(id);
    if (!story) throw storyError("STORY_NOT_FOUND", "Story was not found.", 404);
    return story;
  }

  async exists(id: string) {
    return Boolean(await this.repository.stories.get(id));
  }

  async automationContext(id: string): Promise<StoryAutomationContext | undefined> {
    const story = await this.repository.stories.get(id);
    if (!story) return undefined;
    if (await this.repository.deletionIntents.get(id)) {
      throw storyError("STORY_DELETING", "Story is being deleted.", 409);
    }
    const actions = (await this.repository.actions.list(id)).map(({ storyId: _storyId, displayOrder: _displayOrder, sessionPreset, ...action }) =>
      StoryActionSchema.parse({ ...action, sessionPreset: sessionPreset || undefined }));
    return { id: story.id, archivedAt: story.archivedAt || undefined, actions };
  }

  async create(input: StoryCreateInput) {
    const parsed = StoryCreateInputSchema.parse(input);
    const timestamp = new Date().toISOString();
    const story = await this.repository.transaction(async (repository) => {
      const record = await repository.stories.insert({
        id: createId("story"), title: parsed.title, description: parsed.description,
        createdAt: timestamp, updatedAt: timestamp,
        maxIdleAiSessions: parsed.maxIdleAiSessions ?? STORY_DEFAULT_MAX_IDLE_AI_SESSIONS,
        nextDocumentSequence: 1,
      });
      const actions = (parsed.actions || []).map((action, displayOrder) => ({
        storyId: record.id, id: createId("story_action"), title: action.title,
        promptTemplate: action.promptTemplate, targetInstanceId: action.targetInstanceId,
        sessionPreset: action.sessionPreset, displayOrder,
      }));
      await repository.actions.replace(record.id, actions);
      return record;
    });
    const projected = await this.project(story);
    this.onChange?.("created", projected);
    return projected;
  }

  async retentionSettings(id: string): Promise<StorySessionRetentionSettings> {
    return StorySessionRetentionSettingsSchema.parse({ maxIdleAiSessions: (await this.require(id)).maxIdleAiSessions });
  }

  async update(id: string, input: StoryUpdateInput, emit = true) {
    const parsed = StoryUpdateInputSchema.parse(input);
    const timestamp = new Date().toISOString();
    const updated = await this.repository.transaction(async (repository) => {
      const current = await repository.stories.get(id);
      if (!current) throw storyError("STORY_NOT_FOUND", "Story was not found.", 404);
      if (await repository.deletionIntents.get(id)) throw storyError("STORY_DELETING", "Story is being deleted.", 409);
      if (parsed.actions !== undefined) {
        const existingActions = await repository.actions.list(id);
        const retained = new Set(parsed.actions.flatMap((action) => action.id ? [action.id] : []));
        const removedIds = existingActions.map((action) => action.id).filter((actionId) => !retained.has(actionId));
        const references = await repository.automations.referencingActions(id, removedIds);
        if (references.length) {
          throw storyError(
            "STORY_ACTION_AUTOMATION_IN_USE",
            "Story Action is referenced by an Automation.",
            409,
            { automationIds: references.map((automation) => automation.id) },
          );
        }
        await repository.actions.replace(id, parsed.actions.map((action, displayOrder) => ({
          storyId: id, id: action.id || createId("story_action"), title: action.title,
          promptTemplate: action.promptTemplate, targetInstanceId: action.targetInstanceId,
          sessionPreset: action.sessionPreset, displayOrder,
        })));
      }
      return repository.stories.update(id, {
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description || null } : {}),
        ...(parsed.maxIdleAiSessions !== undefined ? { maxIdleAiSessions: parsed.maxIdleAiSessions } : {}),
        updatedAt: timestamp,
      });
    });
    const projected = await this.project(updated!);
    if (emit) this.onChange?.("updated", projected);
    return projected;
  }

  async archive(id: string) { return this.setArchived(id, true); }
  async restore(id: string) { return this.setArchived(id, false); }

  private async setArchived(id: string, archived: boolean) {
    await this.require(id);
    const timestamp = new Date().toISOString();
    const updated = await this.repository.stories.update(id, { archivedAt: archived ? timestamp : null, updatedAt: timestamp });
    const projected = await this.project(updated!);
    this.onChange?.(archived ? "archived" : "restored", projected);
    return projected;
  }

  async deleteRecord(id: string) {
    const existing = await this.get(id);
    if (!existing) return false;
    const deleted = await this.repository.stories.delete(id);
    if (deleted) this.onChange?.("deleted", existing);
    return deleted;
  }

  notifyDeleted(story: Story) { this.onChange?.("deleted", story); }
  notifyUpdated(story: Story) { this.onChange?.("updated", story); }

  async listContent(id: string) {
    const story = await this.require(id);
    return (await this.project(story)).documents;
  }

  async pageContent(id: string, page: number, pageSize: number) {
    const story = await this.require(id);
    const { items, totalItems } = await this.repository.documents.page(id, page, pageSize);
    const totalPages = Math.ceil(totalItems / pageSize);
    return {
      storyCreatedAt: story.createdAt,
      documents: items,
      pagination: { page, pageSize, totalItems, totalPages, hasMore: page * pageSize < totalItems },
    };
  }

  async readContent(id: string, storyPath: string) {
    const release = await this.coordinator.acquire(id);
    try {
      await this.require(id);
      const normalized = StoryPathSchema.parse(storyPath);
      if (!await this.repository.documents.get(id, normalized)) throw storyError("STORY_CONTENT_NOT_INDEXED", "Story content is not indexed.", 404);
      const opened = this.openRegularFileWithinRoot(id, normalized);
      const stream = fs.createReadStream("", { fd: opened.fd, autoClose: true });
      let done = false;
      const finish = () => { if (!done) { done = true; release(); } };
      stream.once("close", finish);
      stream.once("error", finish);
      return { stream, size: opened.size, revision: opened.revision };
    } catch (error) {
      release();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.removeMissingDocument(id, storyPath);
        throw storyError("STORY_CONTENT_NOT_FOUND", "Story content file was not found.", 404);
      }
      throw error;
    }
  }

  async writeContent(id: string, input: StoryWriteInput) {
    return this.coordinator.run(id, async () => {
      const story = await this.require(id);
      if (story.archivedAt) throw storyError("STORY_ARCHIVED", "Archived Story content is read-only.", 409);
      const storyPath = StoryPathSchema.parse(input.storyPath);
      const existing = await this.repository.documents.get(id, storyPath);
      if (existing) {
        if (!input.expectedRevision) throw storyError("STORY_REVISION_REQUIRED", "expectedRevision is required when replacing Story content.", 409);
        const current = this.openRegularFileWithinRoot(id, storyPath);
        fs.closeSync(current.fd);
        if (current.revision !== input.expectedRevision) throw storyError("STORY_REVISION_CONFLICT", "Story content changed since it was read.", 409);
      } else if (!input.title?.trim()) {
        throw storyError("STORY_CONTENT_TITLE_REQUIRED", "A title is required for new Story content.", 400);
      }
      this.ensureStoryParent(id, storyPath);
      const mutationId = createId("story_file_mutation");
      const target = this.filePath(id, storyPath);
      const temporary = `${target}.${mutationId}.tmp`;
      const backup = `${target}.${mutationId}.bak`;
      const timestamp = new Date().toISOString();
      if (!existing && fs.existsSync(target)) throw storyError("STORY_PATH_CONFLICT", "Story path already exists on disk.", 409);
      await this.repository.fileMutations.insert({
        id: mutationId, storyId: id, operation: "write", storyPath,
        title: input.title?.trim(), temporaryName: temporary, backupName: backup,
        phase: "receiving", createdAt: timestamp, updatedAt: timestamp,
      });
      let bytes = 0;
      let committed = false;
      try {
        const limiter = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            bytes += chunk.byteLength;
            callback(bytes > this.maxFileBytes ? storyError("STORY_FILE_TOO_LARGE", "Story content exceeds the node limit.", 413) : null, chunk);
          },
        });
        await pipeline(input.stream as NodeJS.ReadableStream & AsyncIterable<Uint8Array>, limiter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        this.fsyncFile(temporary);
        await this.repository.fileMutations.update(mutationId, { phase: "prepared", updatedAt: new Date().toISOString() });
        if (existing) fs.renameSync(target, backup);
        fs.renameSync(temporary, target);
        this.fsyncDirectory(path.dirname(target));
        await this.repository.fileMutations.update(mutationId, { phase: "files-staged", updatedAt: new Date().toISOString() });
        await this.repository.transaction(async (repository) => {
          const currentStory = await repository.stories.get(id);
          if (!currentStory) throw storyError("STORY_NOT_FOUND", "Story was not found.", 404);
          if (existing) {
            await repository.documents.update(id, storyPath, { title: input.title?.trim() || existing.title });
          } else {
            const documents = await repository.documents.list(id);
            await repository.documents.insert({
              storyId: id, storyPath, title: input.title!.trim(),
              indexedSequence: currentStory.nextDocumentSequence,
              displayOrder: documents.length,
            });
            await repository.stories.update(id, { nextDocumentSequence: currentStory.nextDocumentSequence + 1, updatedAt: new Date().toISOString() });
          }
          if (existing) await repository.stories.update(id, { updatedAt: new Date().toISOString() });
          await repository.fileMutations.update(mutationId, { phase: "database-committed", updatedAt: new Date().toISOString() });
        });
        committed = true;
        fs.rmSync(backup, { force: true });
        await this.repository.fileMutations.update(mutationId, { phase: "cleanup", updatedAt: new Date().toISOString() });
        await this.repository.fileMutations.delete(mutationId);
        const opened = this.openRegularFileWithinRoot(id, storyPath);
        fs.closeSync(opened.fd);
        const projected = await this.get(id);
        if (projected) this.onChange?.("content.written", projected);
        return { storyPath, revision: opened.revision, size: bytes };
      } catch (error) {
        if (!committed) await this.rollbackFileMutation(mutationId, target, temporary, backup, Boolean(existing));
        throw error;
      }
    });
  }

  async updateDocument(id: string, currentPath: string, input: { title?: string; storyPath?: string }) {
    return this.coordinator.run(id, async () => {
      const story = await this.require(id);
      if (story.archivedAt) throw storyError("STORY_ARCHIVED", "Archived Story content is read-only.", 409);
      const current = StoryPathSchema.parse(currentPath);
      const existing = await this.repository.documents.get(id, current);
      if (!existing) throw storyError("STORY_CONTENT_NOT_INDEXED", "Story content is not indexed.", 404);
      const next = input.storyPath ? StoryPathSchema.parse(input.storyPath) : current;
      if (next !== current && await this.repository.documents.get(id, next)) throw storyError("STORY_PATH_CONFLICT", "Story path is already indexed.", 409);
      if (next === current) {
        await this.repository.transaction(async (repository) => {
          await repository.documents.update(id, current, { title: input.title?.trim() || existing.title });
          await repository.stories.update(id, { updatedAt: new Date().toISOString() });
        });
      } else {
        this.openAndClose(id, current);
        this.ensureStoryParent(id, next);
        const source = this.filePath(id, current);
        const target = this.filePath(id, next);
        if (fs.existsSync(target)) throw storyError("STORY_PATH_CONFLICT", "Story path already exists on disk.", 409);
        const mutationId = createId("story_file_mutation");
        const timestamp = new Date().toISOString();
        await this.repository.fileMutations.insert({ id: mutationId, storyId: id, operation: "rename", storyPath: current, nextStoryPath: next, title: input.title?.trim(), temporaryName: source, backupName: target, phase: "prepared", createdAt: timestamp, updatedAt: timestamp });
        let committed = false;
        try {
          fs.renameSync(source, target);
          this.fsyncDirectory(path.dirname(source));
          if (path.dirname(source) !== path.dirname(target)) this.fsyncDirectory(path.dirname(target));
          await this.repository.fileMutations.update(mutationId, { phase: "files-staged", updatedAt: new Date().toISOString() });
          await this.repository.transaction(async (repository) => {
            await repository.documents.replacePath(id, current, { ...existing, storyPath: next, title: input.title?.trim() || existing.title });
            await repository.stories.update(id, { updatedAt: new Date().toISOString() });
            await repository.fileMutations.update(mutationId, { phase: "database-committed", updatedAt: new Date().toISOString() });
          });
          committed = true;
          await this.repository.fileMutations.update(mutationId, { phase: "cleanup", updatedAt: new Date().toISOString() });
          await this.repository.fileMutations.delete(mutationId);
        } catch (error) {
          if (!committed) {
            if (fs.existsSync(target) && !fs.existsSync(source)) fs.renameSync(target, source);
            await this.repository.fileMutations.delete(mutationId);
          }
          throw error;
        }
      }
      const projected = (await this.get(id))!;
      this.onChange?.("document.updated", projected);
      return projected;
    });
  }

  async reorderDocuments(id: string, input: unknown) {
    const { storyPaths } = StoryDocumentOrderInputSchema.parse(input);
    const documents = await this.repository.documents.list(id);
    const existing = documents.map((document) => document.storyPath);
    if (storyPaths.length !== existing.length || new Set(storyPaths).size !== storyPaths.length || existing.some((value) => !storyPaths.includes(value))) {
      throw storyError("STORY_DOCUMENT_ORDER_INVALID", "Document order must contain every indexed storyPath exactly once.", 400);
    }
    await this.repository.transaction(async (repository) => {
      await repository.documents.reorder(id, storyPaths);
      await repository.stories.update(id, { updatedAt: new Date().toISOString() });
    });
    const projected = (await this.get(id))!;
    this.onChange?.("document.reordered", projected);
    return projected;
  }

  async deleteDocument(id: string, storyPath: string) {
    return this.coordinator.run(id, async () => {
      const story = await this.require(id);
      if (story.archivedAt) throw storyError("STORY_ARCHIVED", "Archived Story content is read-only.", 409);
      const normalized = StoryPathSchema.parse(storyPath);
      if (!await this.repository.documents.get(id, normalized)) return false;
      const target = this.filePath(id, normalized);
      const backup = `${target}.${createId("story_file_mutation")}.deleted`;
      const mutationId = createId("story_file_mutation");
      const timestamp = new Date().toISOString();
      await this.repository.fileMutations.insert({ id: mutationId, storyId: id, operation: "delete", storyPath: normalized, backupName: backup, phase: "prepared", createdAt: timestamp, updatedAt: timestamp });
      let committed = false;
      try {
        this.openAndClose(id, normalized);
        fs.renameSync(target, backup);
        this.fsyncDirectory(path.dirname(target));
        await this.repository.fileMutations.update(mutationId, { phase: "files-staged", updatedAt: new Date().toISOString() });
        await this.repository.transaction(async (repository) => {
          await repository.documents.delete(id, normalized);
          await repository.stories.update(id, { updatedAt: new Date().toISOString() });
          await repository.fileMutations.update(mutationId, { phase: "database-committed", updatedAt: new Date().toISOString() });
        });
        committed = true;
        fs.rmSync(backup, { force: true });
        await this.repository.fileMutations.update(mutationId, { phase: "cleanup", updatedAt: new Date().toISOString() });
        await this.repository.fileMutations.delete(mutationId);
      } catch (error) {
        if (!committed) {
          if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
          await this.repository.fileMutations.delete(mutationId);
        }
        throw error;
      }
      const projected = await this.get(id);
      if (projected) this.onChange?.("document.deleted", projected);
      return true;
    });
  }

  stopAccepting() { this.coordinator.stopAccepting(); }
  drain() { return this.coordinator.drain(); }

  private async project(story: StoryRecord): Promise<Story> {
    const actions = (await this.repository.actions.list(story.id)).map(({ storyId: _storyId, displayOrder: _displayOrder, sessionPreset, ...action }) => StoryActionSchema.parse({ ...action, sessionPreset: sessionPreset || undefined }));
    const documents = await this.repository.documents.list(story.id);
    const valid = [];
    for (const document of documents) {
      try {
        const opened = this.openRegularFileWithinRoot(story.id, document.storyPath);
        fs.closeSync(opened.fd);
        valid.push({ title: document.title, storyPath: document.storyPath, revision: opened.revision });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.removeMissingDocument(story.id, document.storyPath);
      }
    }
    return StorySchema.parse({
      id: story.id, ownerNodeId: this.ownerNodeId, title: story.title,
      description: story.description || undefined, actions, documents: valid,
      createdAt: story.createdAt, updatedAt: story.updatedAt, archivedAt: story.archivedAt || undefined,
    });
  }

  private storyRoot(id: string) { return path.resolve(this.paths.storyContentDir, StorySchema.shape.id.parse(id)); }

  private filePath(id: string, storyPath: string) {
    const root = this.storyRoot(id);
    const target = path.resolve(root, ...StoryPathSchema.parse(storyPath).split("/"));
    if (target === root || !target.startsWith(`${root}${path.sep}`)) throw storyError("STORY_PATH_OUTSIDE_ROOT", "Story path is outside the Story directory.", 400);
    return target;
  }

  private ensureStoryParent(id: string, storyPath: string) {
    const target = this.filePath(id, storyPath);
    try {
      const stat = fs.lstatSync(this.paths.storyContentDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw storyError("STORY_PATH_UNSAFE", "Story content root must be a real directory.", 409);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(this.paths.storyContentDir, { recursive: true, mode: 0o700 });
    }
    fs.chmodSync(this.paths.storyContentDir, 0o700);
    let current = this.paths.storyContentDir;
    for (const segment of path.relative(this.paths.storyContentDir, path.dirname(target)).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw storyError("STORY_PATH_UNSAFE", "Story path parent must be a real directory.", 409);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fs.mkdirSync(current, { mode: 0o700 });
      }
      fs.chmodSync(current, 0o700);
    }
  }

  private openRegularFileWithinRoot(id: string, storyPath: string) {
    const target = this.filePath(id, storyPath);
    this.assertExistingParentsSafe(this.storyRoot(id), path.dirname(target));
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    if (!noFollow) throw storyError("STORY_NOFOLLOW_UNAVAILABLE", "Safe no-follow file access is unavailable on this platform.", 500);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw storyError("STORY_CONTENT_NOT_FILE", "Story content must be a regular file.", 409);
      if (stat.size > this.maxFileBytes) throw storyError("STORY_FILE_TOO_LARGE", "Story content exceeds the node limit.", 413);
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < stat.size) {
        const bytes = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!bytes) break;
        hash.update(buffer.subarray(0, bytes));
        position += bytes;
      }
      return { fd, size: stat.size, revision: hash.digest("hex") };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  private assertExistingParentsSafe(root: string, parent: string) {
    const relative = path.relative(this.paths.storyContentDir, parent);
    let current = this.paths.storyContentDir;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw storyError("STORY_PATH_UNSAFE", "Story path parent must be a real directory.", 409);
    }
    if (!parent.startsWith(root)) throw storyError("STORY_PATH_OUTSIDE_ROOT", "Story path is outside the Story directory.", 400);
  }

  private openAndClose(id: string, storyPath: string) { const opened = this.openRegularFileWithinRoot(id, storyPath); fs.closeSync(opened.fd); }
  private fsyncFile(filePath: string) { const fd = fs.openSync(filePath, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  private fsyncDirectory(directory: string) { if (process.platform === "win32") return; const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

  private async removeMissingDocument(id: string, storyPath: string) {
    if (!await this.repository.documents.get(id, storyPath)) return;
    await this.repository.transaction(async (repository) => {
      await repository.documents.delete(id, storyPath);
      await repository.stories.update(id, { updatedAt: new Date().toISOString() });
    });
    const story = await this.get(id);
    if (story) this.onChange?.("document.deleted", story);
  }

  private async rollbackFileMutation(id: string, target: string, temporary: string, backup: string, replaced: boolean) {
    fs.rmSync(temporary, { force: true });
    if (replaced && fs.existsSync(backup)) {
      fs.rmSync(target, { force: true });
      fs.renameSync(backup, target);
    } else if (!replaced) fs.rmSync(target, { force: true });
    await this.repository.fileMutations.delete(id);
  }

  private async recoverFileMutations() {
    for (const intent of await this.repository.fileMutations.list()) {
      await this.coordinator.run(intent.storyId, async () => {
        const target = this.filePath(intent.storyId, intent.nextStoryPath || intent.storyPath);
        if (intent.phase === "database-committed" || intent.phase === "cleanup") {
          if (intent.operation === "write") {
            if (intent.temporaryName) fs.rmSync(intent.temporaryName, { force: true });
            if (intent.backupName) fs.rmSync(intent.backupName, { force: true });
          } else if (intent.operation === "delete" && intent.backupName) {
            fs.rmSync(intent.backupName, { force: true });
          }
        } else if (intent.operation === "write") {
          const temporaryExists = Boolean(intent.temporaryName && fs.existsSync(intent.temporaryName));
          const indexed = Boolean(await this.repository.documents.get(intent.storyId, intent.storyPath));
          if (intent.backupName && fs.existsSync(intent.backupName)) {
            fs.rmSync(target, { force: true });
            fs.renameSync(intent.backupName, target);
          } else if (!indexed && (intent.phase === "files-staged" || (intent.phase === "prepared" && !temporaryExists))) {
            fs.rmSync(target, { force: true });
          }
          if (intent.temporaryName) fs.rmSync(intent.temporaryName, { force: true });
        } else if (intent.operation === "rename" && intent.temporaryName && fs.existsSync(target) && !fs.existsSync(intent.temporaryName)) {
          fs.renameSync(target, intent.temporaryName);
        } else if (intent.operation === "delete" && intent.backupName && fs.existsSync(intent.backupName) && !fs.existsSync(target)) {
          fs.renameSync(intent.backupName, target);
        }
        await this.repository.fileMutations.delete(intent.id);
      });
    }
  }
}

function storyError(code: string, message: string, statusCode: number, details?: unknown) {
  return Object.assign(new Error(message), { code, statusCode, ...(details === undefined ? {} : { details }) });
}
