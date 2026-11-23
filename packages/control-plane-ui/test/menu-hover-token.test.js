import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

function ruleBody(source, selector) {
  const selectorIndex = source.indexOf(selector);
  assert.ok(selectorIndex >= 0, `missing selector: ${selector}`);
  const open = source.indexOf("{", selectorIndex);
  const close = source.indexOf("}", open);
  assert.ok(open >= 0 && close > open, `missing rule body: ${selector}`);
  return source.slice(open + 1, close);
}

const sharedMenuItems = [
  "components/ui/dropdown-menu/DropdownMenuItem.vue",
  "components/ui/dropdown-menu/DropdownMenuSubTrigger.vue",
  "components/ui/dropdown-menu/DropdownMenuCheckboxItem.vue",
  "components/ui/dropdown-menu/DropdownMenuRadioItem.vue",
  "components/ui/context-menu/ContextMenuItem.vue",
  "components/ui/context-menu/ContextMenuSubTrigger.vue",
  "components/ui/context-menu/ContextMenuCheckboxItem.vue",
  "components/ui/context-menu/ContextMenuRadioItem.vue",
  "components/ui/select/SelectItem.vue",
  "components/ui/command/CommandItem.vue",
];

test("shared menu primitives highlight with the hover surface token", () => {
  for (const path of sharedMenuItems) {
    const source = read(path);
    assert.match(source, /(?:focus|data-\[highlighted\]|data-\[state=open\]):bg-\[var\(--surface-hover\)\]/, path);
    assert.doesNotMatch(source, /(?:focus|data-\[highlighted\]|data-\[state=open\]):bg-accent\b/, path);
  }
});

test("custom menus highlight with the hover surface token", () => {
  const menuRules = [
    ["apps/control-plane/instance-detail/AiSessionPanel.css", ".session-ai-project-item[data-highlighted])"],
    ["apps/control-plane/instance-detail/AiSessionPanel.css", ".session-ai-options-item[data-highlighted])"],
    ["apps/control-plane/instance-detail/AiSessionPanel.css", ".session-ai-filter-item[data-highlighted])"],
    ["apps/control-plane/ControlPlaneWorkbench.css", ".control-plane-node-filter-menu-item:not(.selected):hover)"],
    ["apps/control-plane/instance-detail/RepositoryEnvironment.vue", ".repository-environment-trigger-menu:hover,"],
    ["apps/control-plane/shared/AppLaunchMenuItems.vue", ".app-launch-menu-item[data-highlighted])"],
    ["apps/control-plane/shared/InstanceActionMenu.css", ".instance-action-item[data-highlighted],"],
    ["apps/control-plane/shared/InstanceViewOptionsMenu.vue", ".instance-view-options-item[data-highlighted],"],
    ["apps/control-plane/instance-detail/NewWorktreeBranchPicker.vue", ".new-worktree-branch-item[data-highlighted])"],
    ["apps/control-plane/ai-board/AiSessionBoardView.vue", ".ai-board-options-item[data-highlighted]"],
    ["apps/control-plane/board/InstanceBoardView.vue", ".board-session-item[data-highlighted]"],
    ["apps/control-plane/board/InstanceBoardView.vue", ".board-launch-menu .app-launch-menu-item[data-highlighted])"],
    ["apps/control-plane/story/StoryView.vue", ".story-list-options-item[data-highlighted])"],
    ["apps/control-plane/agent/AgentGraph.vue", ".agent-graph-add-option[data-highlighted])"],
    ["apps/control-plane/settings/ModelSettingsSection.vue", "[role=\"option\"][data-highlighted])"],
    ["apps/control-plane/settings/NodeDetailPanel.vue", ".node-detail-action-item[data-highlighted])"],
    ["apps/control-plane/shared/ControlPlaneTimezonePicker.vue", "[role=\"option\"][data-highlighted])"],
    ["components/ai-session/AiSessionModelMenu.vue", ".ai-session-model-menu__item:is(:focus, [data-highlighted])"],
  ];

  for (const [path, selector] of menuRules) {
    assert.match(ruleBody(read(path), selector), /background:\s*var\(--surface-hover\);/, `${path}: ${selector}`);
  }
});
