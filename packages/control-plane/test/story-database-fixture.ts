import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { openNodeAgentDatabase } from "../src/node-agent/stories/database/database.ts";
import { createNodeAgentRepository } from "../src/node-agent/stories/database/repository.ts";

export async function createStoryDatabaseFixture(prefix = "task-handoff-story-db-") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const paths = nodeAgentStorePaths(dataDir);
  const database = await openNodeAgentDatabase(paths);
  const repository = createNodeAgentRepository(database);
  return {
    dataDir,
    paths,
    database,
    repository,
    async close() {
      await repository.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function seedStoryAction(repository: Awaited<ReturnType<typeof createStoryDatabaseFixture>>["repository"], storyId = "story_1", actionId = "action_1") {
  const timestamp = "2026-09-05T00:00:00.000Z";
  await repository.transaction(async (transaction) => {
    await transaction.stories.insert({ id: storyId, title: "Story", createdAt: timestamp, updatedAt: timestamp, maxIdleAiSessions: 5, nextDocumentSequence: 1 });
    await transaction.actions.replace(storyId, [{ storyId, id: actionId, title: "Action", promptTemplate: "Run", targetInstanceId: "instance_1", displayOrder: 0 }]);
  });
}
