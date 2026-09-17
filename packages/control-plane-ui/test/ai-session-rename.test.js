import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const dialog = fs.readFileSync(new URL("../src/components/ai-session/AiSessionRenameDialog.vue", import.meta.url), "utf8");
const menu = fs.readFileSync(new URL("../src/components/ai-session/AiSessionCardContextMenu.vue", import.meta.url), "utf8");
const card = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const preview = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPreview.vue", import.meta.url), "utf8");
const story = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");

test("AI Session rename is gated only by the session action in list, board, and detail menus", () => {
  assert.match(menu, /v-if="canRename"[\s\S]*@select="\$emit\('renameSession'\)"/);
  assert.match(card, /:can-rename="card\.session\.actions\?\.rename === true"/);
  assert.match(panel, /:can-rename="session\.actions\?\.rename === true"/);
  assert.match(panel, /v-if="selectedSession\.actions\?\.rename === true"[\s\S]*<Pencil/);
  assert.match(board, /<AiSessionRenameDialog[\s\S]*:session="renameSessionTarget\?\.session"/);
  assert.match(story, /<AiSessionCardContextMenu[\s\S]*:can-rename="entry\.session\.actions\?\.rename === true"[\s\S]*@rename-session="renameSessionTarget = entry"/);
  assert.match(story, /<AiSessionRenameDialog[\s\S]*:instance-id="renameSessionTarget\?\.instance\.id \|\| ''"[\s\S]*:session="renameSessionTarget\?\.session"/);
});

test("renamed AI Session title is authoritative in the compact instance list", () => {
  assert.match(panel, /class="session-ai-compact-title">\{\{ session\.title \|\| displayAiSessionTitle\(session, latestPromptIndex\(session\), t\) \|\| session\.id \}\}<\/span>/);
  assert.match(panel, /class="session-ai-question" :content="displayAiSessionTitle\(session, latestPromptIndex\(session\), t\)"/);
});

test("rename dialog keeps authoritative state external and submits strict idempotent input", () => {
  assert.match(dialog, /expectedTitle\.value = props\.session\.title\?\.trim\(\) \|\| ""/);
  assert.match(dialog, /clientRequestId\.value = createBrowserUuid\(\)/);
  assert.match(dialog, /maxlength="120"/);
  assert.match(dialog, /normalized\.value\.length <= 120 && normalized\.value !== expectedTitle\.value/);
  assert.doesNotMatch(dialog, /normalized\.value\.length > 0/);
  assert.match(dialog, /expectedTitle: expectedTitle\.value/);
  assert.match(dialog, /clientRequestId: clientRequestId\.value/);
  assert.doesNotMatch(dialog, /invalidateQueries|refetchQueries|setQueryData/);
});

test("linked AppSession rename is capability gated and successful actions do not refetch projections", () => {
  assert.match(preview, /linkedAiSession\.actions\?\.rename === true/);
  assert.match(preview, /renameUnavailable/);
  const renameFunction = workbench.slice(workbench.indexOf("async function renameSession"), workbench.indexOf("async function controlWindow"));
  assert.match(renameFunction, /renameAppSession/);
  assert.doesNotMatch(renameFunction, /refetchQueries|invalidateQueries|setQueryData/);
});
