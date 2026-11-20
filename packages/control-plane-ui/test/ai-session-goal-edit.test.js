import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../src/", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("goal editing reuses the composer draft flow on both control-plane surfaces", () => {
  const badge = read("components/ai-session/AiSessionGoalBadge.vue");
  const composer = read("components/ai-session/AiSessionComposer.vue");
  const dock = read("apps/control-plane/ai-board/AiSessionFloatingDock.vue");
  const board = read("apps/control-plane/ai-board/AiSessionBoardView.vue");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const en = read("i18n/locales/en-US/sessions.ts");
  const zh = read("i18n/locales/zh-CN/sessions.ts");

  assert.match(badge, /@click="\$emit\('edit'\)"/);
  assert.match(badge, /edit: \[\];/);
  assert.match(composer, /cancelEditLabel\?: string;/);
  assert.match(composer, /cancelEditLabel \|\| t\('sessions\.composer\.cancelQueuedEdit'\)/);

  for (const surface of [panel, board]) {
    assert.match(surface, /goalComposerEdit/);
    assert.match(surface, /messageDraft\.value = .*goal\.objective/);
    assert.match(surface, /messageAttachments\.value = \[\];/);
    assert.match(surface, /messageMentionBindings\.value = \[\];/);
    assert.match(surface, /command: "goal", argument: `edit \$\{objective\}`/);
    assert.match(surface, /cancelGoalComposerEdit\(\)/);
    assert.match(surface, /goalComposerEdit\.value\)/);
    assert.match(surface, /!queueComposerEdit\.value && !goalComposerEdit\.value/);
  }

  assert.match(panel, /@edit="editSelectedGoal"/);
  assert.match(panel, /@cancel-edit="cancelComposerEdit"/);
  assert.match(panel, /sessions\.composer\.editingGoal/);
  assert.match(panel, /sessions\.composer\.saveGoal/);
  assert.match(board, /@edit-goal="editSelectedGoal"/);
  assert.match(board, /@cancel-edit="cancelComposerEdit"/);
  assert.match(board, /sessions\.composer\.editingGoal/);
  assert.match(board, /sessions\.composer\.saveGoal/);
  assert.match(dock, /@edit="\$emit\('editGoal'\)"/);
  assert.match(dock, /:submit-label="submitLabel"/);
  assert.match(dock, /:cancel-edit-label="cancelEditLabel"/);
  assert.match(en, /edit: "Edit goal"/);
  assert.match(en, /editingGoal: "Editing goal"/);
  assert.match(zh, /edit: "编辑目标"/);
  assert.match(zh, /editingGoal: "正在编辑目标"/);
});
