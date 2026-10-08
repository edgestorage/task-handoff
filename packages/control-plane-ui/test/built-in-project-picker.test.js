import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const nodeDetail = fs.readFileSync(new URL("../src/apps/control-plane/settings/NodeDetailPanel.vue", import.meta.url), "utf8");

test("the project picker renders built-in projects apart from user projects", () => {
  // Built-in entries render before a plain separator; the separator carries no
  // group heading, and the user list is filtered to non-built-in folders.
  assert.match(
    panel,
    /v-for="folder in filteredNewSessionBuiltinFolders"[\s\S]*?<DropdownMenuSeparator v-if="filteredNewSessionBuiltinFolders\.length && filteredNewSessionFolders\.length" \/>[\s\S]*?v-for="folder in filteredNewSessionFolders"/,
  );
  assert.match(panel, /partitionInstanceCwdFolders\(newSessionFolders\.value\)\.user/);
  assert.match(panel, /partitionInstanceCwdFolders\(newSessionFolders\.value\)\.builtin/);
  assert.doesNotMatch(panel, /session-ai-project-group-label/);
});

test("node folder settings keep built-in projects read-only", () => {
  assert.match(nodeDetail, /<template v-if="folder\.origin !== 'builtin'">[\s\S]*?renameLocalFolder[\s\S]*?removeNodeLocalFolder[\s\S]*?<\/template>/);
  assert.match(nodeDetail, /<Badge v-if="folder\.origin === 'builtin'" variant="secondary">\{\{ t\("settings\.nodeDetail\.builtinProject"\) \}\}<\/Badge>/);
  assert.match(nodeDetail, /nodeLocalFolderDisplayName\(folder, locale\)/);
});
