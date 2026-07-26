import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { repositoryFileLocation, repositoryRelativeFilePath } from "../src/apps/control-plane/instance-detail/repositoryFilePath.ts";

const context = {
  availability: "available",
  sessionKind: "ai-session",
  sessionId: "session-1",
  observedAt: "2026-07-26T00:00:00.000Z",
  repositoryRoot: "/workspace/project",
  cwdRelativePath: "packages/ui",
};

test("Markdown file paths resolve against the authoritative repository context", () => {
  assert.equal(repositoryRelativeFilePath("proposal.md", context), "packages/ui/proposal.md");
  assert.equal(repositoryRelativeFilePath("../spec.md#design", context), "packages/spec.md");
  assert.equal(repositoryRelativeFilePath("/workspace/project/docs/a%20b.md", context), "docs/a b.md");
  assert.equal(repositoryRelativeFilePath("file:///workspace/project/README.md", context), "README.md");
  assert.equal(repositoryRelativeFilePath("file:///C:/workspace/project/README.md", {
    ...context,
    repositoryRoot: "C:/workspace/project",
  }), "README.md");
  assert.equal(repositoryRelativeFilePath("FILE:///C:/WORKSPACE/PROJECT/README.md", {
    ...context,
    repositoryRoot: "C:/workspace/project",
  }), "README.md");
  assert.equal(repositoryRelativeFilePath("file://server/workspace/project/README.md", {
    ...context,
    repositoryRoot: "//SERVER/Workspace/Project",
  }), "README.md");
});

test("Markdown file paths cannot escape or address a different repository", () => {
  assert.equal(repositoryRelativeFilePath("../../../secret.txt", context), undefined);
  assert.equal(repositoryRelativeFilePath("/workspace/other/secret.txt", context), undefined);
});

test("Markdown file paths preserve source line and column locations", () => {
  assert.deepEqual(repositoryFileLocation("/workspace/project/src/routes.ts:112", context), { path: "src/routes.ts", line: 112, column: undefined });
  assert.deepEqual(repositoryFileLocation("../spec.md:24:7", context), { path: "packages/spec.md", line: 24, column: 7 });
  assert.deepEqual(repositoryFileLocation("README.md#L8", context), { path: "packages/ui/README.md", line: 8, column: undefined });
  assert.deepEqual(repositoryFileLocation("README.md#L8C3-L12C9", context), { path: "packages/ui/README.md", line: 8, column: 3 });
});

test("AI session Markdown file links are routed into File Explorer", async () => {
  const root = new URL("../src/", import.meta.url);
  const [markdown, panel, workspace] = await Promise.all([
    readFile(new URL("components/ai-session/AiSessionStreamingMarkdown.vue", root), "utf8"),
    readFile(new URL("apps/control-plane/instance-detail/AiSessionPanel.vue", root), "utf8"),
    readFile(new URL("apps/control-plane/instance-detail/RepositoryWorkspace.vue", root), "utf8"),
  ]);
  assert.match(markdown, /@click="handleLinkClick"/);
  assert.match(markdown, /emit\("openFile", href\)/);
  assert.match(panel, /@open-file="openMarkdownFile/);
  assert.match(panel, /emit\("openRepositoryWorkspace"/);
  assert.match(workspace, /repositoryFileLocation\(href, props\.context\)/);
  assert.match(workspace, /void openFile\(location\)/);
});
