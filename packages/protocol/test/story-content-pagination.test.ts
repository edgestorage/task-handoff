import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeStoryContentPageResult,
  StoryContentPageInputSchema,
  StoryContentPageResultSchema,
} from "../src/stories.ts";

const page = {
  storyCreatedAt: "2026-09-05T00:00:00.000Z",
  documents: [{ title: "Document", storyPath: "document.md" }],
  pagination: {
    page: 1,
    pageSize: 20,
    totalItems: 1,
    totalPages: 1,
    hasMore: false,
  },
};

test("Story content pagination input applies defaults and bounded integer coercion", () => {
  assert.deepEqual(StoryContentPageInputSchema.parse({}), { page: 1, pageSize: 20 });
  assert.deepEqual(StoryContentPageInputSchema.parse({ page: "500", pageSize: "100" }), { page: 500, pageSize: 100 });
  for (const input of [
    { page: 0 },
    { page: 501 },
    { page: 1.5 },
    { page: true },
    { page: "1.0" },
    { pageSize: 0 },
    { pageSize: 101 },
    { unknown: true },
  ]) assert.throws(() => StoryContentPageInputSchema.parse(input));
});

test("Story content pagination result requires the minimal wire fields", () => {
  assert.deepEqual(StoryContentPageResultSchema.parse(page), page);
  assert.equal("revision" in StoryContentPageResultSchema.parse(page).documents[0]!, false);
  for (const invalid of [
    { ...page, storyCreatedAt: undefined },
    { ...page, documents: [{ storyPath: "document.md" }] },
    { ...page, pagination: { ...page.pagination, hasMore: undefined } },
  ]) assert.throws(() => StoryContentPageResultSchema.parse(invalid));
});

test("Story content pagination consumer strips unknown response fields", () => {
  const sanitized = sanitizeStoryContentPageResult({
    ...page,
    internal: "ignored",
    documents: [{ ...page.documents[0], revision: "a".repeat(64) }],
    pagination: { ...page.pagination, cursor: "ignored" },
  });
  assert.deepEqual(sanitized, page);
});
