import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { STORY_TOOL_DESCRIPTIONS } from "./src/story-tool-contract.ts";
import { StoryAgentToolService } from "./src/web/story-tools.ts";

function document(index) {
  return {
    title: `Document ${index}`,
    storyPath: `document-${index}.md`,
  };
}

function serviceWithDocuments(documents) {
  return new StoryAgentToolService({
    enabled: () => true,
    listStoryContent: async (_sessionId, page, pageSize) => {
      const newest = [...documents].reverse();
      const offset = (page - 1) * pageSize;
      return {
        storyCreatedAt: "2026-09-05T00:00:00.000Z",
        documents: newest.slice(offset, offset + pageSize),
        pagination: {
          page,
          pageSize,
          totalItems: newest.length,
          totalPages: Math.ceil(newest.length / pageSize),
          hasMore: offset + pageSize < newest.length,
        },
      };
    },
  });
}

const session = { id: "session-1", storyId: "story-1" };

test("Story tool descriptions explain the list-get-set workflow", () => {
  assert.match(STORY_TOOL_DESCRIPTIONS.story_list_content, /ordered newest to oldest/);
  assert.match(STORY_TOOL_DESCRIPTIONS.story_list_content, /page 1/);
  assert.match(STORY_TOOL_DESCRIPTIONS.story_get_content, /story_list_content/);
  assert.match(STORY_TOOL_DESCRIPTIONS.story_set_content, /expectedRevision/);
});

test("story_list_content keeps the empty input compatible and returns the newest documents first", async () => {
  const service = serviceWithDocuments(Array.from({ length: 23 }, (_, index) => document(index + 1)));

  const result = await service.invoke(session, "story_list_content", {});

  assert.equal("storyCreatedAt" in result, false);
  assert.deepEqual(result.documents.map((item) => item.storyPath), Array.from({ length: 20 }, (_, index) => `document-${23 - index}.md`));
  assert.deepEqual(result.pagination, {
    totalItems: 23,
    nextPage: 2,
  });
});

test("story_list_content returns later pages without changing the authoritative document order", async () => {
  const documents = Array.from({ length: 7 }, (_, index) => document(index + 1));
  const service = serviceWithDocuments(documents);

  const result = await service.invoke(session, "story_list_content", { page: 3, pageSize: 3 });

  assert.deepEqual(result.documents.map((item) => item.storyPath), ["document-1.md"]);
  assert.deepEqual(result.pagination, {
    totalItems: 7,
  });
  assert.deepEqual(documents.map((item) => item.storyPath), Array.from({ length: 7 }, (_, index) => `document-${index + 1}.md`));
});

test("story_list_content rejects unknown or out-of-range pagination input", async () => {
  const service = serviceWithDocuments([]);

  await assert.rejects(() => service.invoke(session, "story_list_content", { cursor: "next" }));
  await assert.rejects(() => service.invoke(session, "story_list_content", { page: 0 }));
  await assert.rejects(() => service.invoke(session, "story_list_content", { pageSize: 101 }));
});

test("story_set_content returns the authoritative title and stored size", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "story-tool-set-"));
  try {
    fs.writeFileSync(path.join(workspace, "draft.md"), "release");
    const service = new StoryAgentToolService({
      enabled: () => true,
      uploadStoryContent: async () => ({
        title: "Authoritative title",
        storyPath: "release.md",
        revision: "a".repeat(64),
        size: 7,
      }),
    });
    const result = await service.invoke({ ...session, cwd: workspace }, "story_set_content", {
      storyPath: "release.md",
      title: "Requested title",
      sourcePath: path.join(workspace, "draft.md"),
    });
    assert.deepEqual(result, {
      title: "Authoritative title",
      storyPath: "release.md",
      revision: "a".repeat(64),
      size: 7,
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
