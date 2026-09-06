import assert from "node:assert/strict";
import test from "node:test";
import { STORY_DYNAMIC_TOOLS, StoryAgentToolService } from "./src/web/story-tools.ts";

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
  const tools = new Map(STORY_DYNAMIC_TOOLS.map((tool) => [tool.name, tool]));

  assert.match(tools.get("story_list_content").description, /ordered newest to oldest/);
  assert.match(tools.get("story_list_content").description, /page 1/);
  assert.match(tools.get("story_get_content").description, /story_list_content/);
  assert.match(tools.get("story_set_content").description, /expectedRevision/);
  assert.equal(tools.get("story_list_content").inputSchema.properties.page.default, 1);
  assert.equal(tools.get("story_list_content").inputSchema.properties.pageSize.default, 20);
});

test("story_list_content keeps the empty input compatible and returns the newest documents first", async () => {
  const service = serviceWithDocuments(Array.from({ length: 23 }, (_, index) => document(index + 1)));

  const result = await service.invoke(session, "story_list_content", {});

  assert.equal(result.storyCreatedAt, "2026-09-05T00:00:00.000Z");
  assert.deepEqual(result.documents.map((item) => item.storyPath), Array.from({ length: 20 }, (_, index) => `document-${23 - index}.md`));
  assert.deepEqual(result.pagination, {
    page: 1,
    pageSize: 20,
    totalItems: 23,
    totalPages: 2,
    hasMore: true,
  });
});

test("story_list_content returns later pages without changing the authoritative document order", async () => {
  const documents = Array.from({ length: 7 }, (_, index) => document(index + 1));
  const service = serviceWithDocuments(documents);

  const result = await service.invoke(session, "story_list_content", { page: 3, pageSize: 3 });

  assert.deepEqual(result.documents.map((item) => item.storyPath), ["document-1.md"]);
  assert.deepEqual(result.pagination, {
    page: 3,
    pageSize: 3,
    totalItems: 7,
    totalPages: 3,
    hasMore: false,
  });
  assert.deepEqual(documents.map((item) => item.storyPath), Array.from({ length: 7 }, (_, index) => `document-${index + 1}.md`));
});

test("story_list_content rejects unknown or out-of-range pagination input", async () => {
  const service = serviceWithDocuments([]);

  await assert.rejects(() => service.invoke(session, "story_list_content", { cursor: "next" }));
  await assert.rejects(() => service.invoke(session, "story_list_content", { page: 0 }));
  await assert.rejects(() => service.invoke(session, "story_list_content", { pageSize: 101 }));
});
