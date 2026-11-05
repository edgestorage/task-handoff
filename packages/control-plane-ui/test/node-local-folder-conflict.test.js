import assert from "node:assert/strict";
import test from "node:test";

import { createOrReuseNodeLocalFolder, resolveExistingNodeLocalFolder } from "../src/apps/control-plane/shared/nodeLocalFolderConflict.ts";

const existing = { id: "folder_existing", path: "/workspace/existing" };
const conflict = {
  code: "NODE_LOCAL_FOLDER_ALREADY_EXISTS",
  details: { folderId: existing.id },
};

test("a duplicate project create reuses the authoritative existing folder", async () => {
  let loads = 0;
  const folder = await resolveExistingNodeLocalFolder({
    error: conflict,
    knownFolders: [],
    loadFolders: async () => {
      loads += 1;
      return [existing];
    },
    nodeId: "node_remote",
    path: "/workspace/existing/",
  });

  assert.equal(folder, existing);
  assert.equal(loads, 1);
});

test("the create wrapper selects an existing project after a duplicate response", async () => {
  const folder = await createOrReuseNodeLocalFolder({
    createFolder: async () => {
      throw conflict;
    },
    knownFolders: [existing],
    loadFolders: async () => [],
    nodeId: "node_remote",
    path: existing.path,
  });

  assert.equal(folder, existing);
});

test("a cached project is reused without another node request", async () => {
  let loads = 0;
  const folder = await resolveExistingNodeLocalFolder({
    error: { code: "NODE_LOCAL_FOLDER_ALREADY_EXISTS" },
    knownFolders: [{ id: "folder_cached", path: "C:\\Workspace\\Project" }],
    loadFolders: async () => {
      loads += 1;
      return [];
    },
    nodeId: "node_remote",
    path: "c:/workspace/project/",
  });

  assert.equal(folder?.id, "folder_cached");
  assert.equal(loads, 0);
});

test("other create failures are not converted into reused projects", async () => {
  let loads = 0;
  const folder = await resolveExistingNodeLocalFolder({
    error: { code: "NODE_FOLDER_PATH_UNREADABLE" },
    knownFolders: [existing],
    loadFolders: async () => {
      loads += 1;
      return [existing];
    },
    nodeId: "node_remote",
    path: existing.path,
  });

  assert.equal(folder, undefined);
  assert.equal(loads, 0);
});
