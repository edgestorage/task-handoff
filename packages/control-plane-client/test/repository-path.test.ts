import assert from "node:assert/strict";
import test from "node:test";

import type { RepositoryContext } from "@task-handoff/protocol/repository";
import { repositoryFileLocation, repositoryRelativeFilePath } from "../src/repository-path.ts";

const context: RepositoryContext = {
  availability: "available",
  sessionKind: "ai-session",
  sessionId: "session_path",
  observedAt: "2026-11-07T10:00:00.000Z",
  repositoryRoot: "/workspace/project",
  cwdRelativePath: "packages/ui",
};

test("repository file paths resolve relative, absolute and file URLs against session context", () => {
  assert.equal(repositoryRelativeFilePath("proposal.md", context), "packages/ui/proposal.md");
  assert.equal(repositoryRelativeFilePath("../spec.md#design", context), "packages/spec.md");
  assert.equal(repositoryRelativeFilePath("/workspace/project/docs/a%20b.md", context), "docs/a b.md");
  assert.equal(repositoryRelativeFilePath("file:///workspace/project/README.md", context), "README.md");
  assert.deepEqual(repositoryFileLocation("README.md#L8C3-L12C9", context), { path: "packages/ui/README.md", line: 8, column: 3 });
});

test("repository file paths cannot escape the authoritative repository root", () => {
  assert.equal(repositoryRelativeFilePath("../../../secret.txt", context), undefined);
  assert.equal(repositoryRelativeFilePath("/workspace/other/secret.txt", context), undefined);
});
