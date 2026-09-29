import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const agentView = read("src/apps/control-plane/agent/AgentView.vue");
const agentGraph = read("src/apps/control-plane/agent/AgentGraph.vue");
const agentEditor = read("src/apps/control-plane/agent/AgentEditor.vue");
const agentSwitcher = read("src/apps/control-plane/agent/AgentViewSwitcher.vue");
const storyView = read("src/apps/control-plane/story/StoryView.vue");

test("Agent view reuses the Story workspace layout language", () => {
  assert.match(agentView, /\.agent-view \{[^}]*background:var\(--workspace-bg\);[^}]*padding:12px 0;/);
  assert.match(agentView, /\.agent-list-item:hover \{ background:var\(--sidebar-row-hover-bg,var\(--surface-active\)\); \}/);
  assert.match(agentView, /\.agent-list-item\.active,\.agent-list-item\.active:hover \{ background:var\(--sidebar-row-selected-bg,var\(--surface-active\)\); \}/);
  assert.match(agentView, /\.agent-sidebar-scroll-inner \{ min-width:0; padding:0 10px 12px; \}/);
  assert.match(agentView, /\.agent-content-header \{[^}]*border-bottom:1px solid var\(--line\); padding:0 0 12px;/);
  assert.match(agentView, /\.agent-card \{[^}]*border:1px solid var\(--line\);[^}]*border-radius:8px;[^}]*background:var\(--surface-raised\); \}/);
  assert.match(agentView, /\.agent-detail-scroll-inner \{[^}]*width:min\(100%,1080px\);[^}]*margin:0 auto;/);
  assert.match(agentView, /\.agent-detail-head \{[^}]*position:sticky;[^}]*background:var\(--workspace-bg\);/);
  assert.match(agentGraph, /\.agent-graph-stage \{[^}]*border-radius:8px; background:var\(--surface-raised\);/);
});

test("Agent detail head keeps runtime identity in the shared meta-line language", () => {
  assert.match(agentView, /<div class="agent-detail-runtime">[\s\S]*?<AiAgentIcon v-if="providerBrand"[\s\S]*?agent-detail-runtime-item[\s\S]*?selectedAgent\.provider[\s\S]*?agent-detail-runtime-separator[\s\S]*?selectedAgent\.model/);
  assert.match(agentView, /import AiAgentIcon from "@\/components\/AiAgentIcon\.vue";/);
  assert.match(agentView, /providerId === "codex" \|\| providerId === "claude" \|\| providerId === "opencode" \? providerId : undefined/);
  assert.match(agentView, /\.agent-detail-runtime \{[^}]*color:var\(--text-muted\);[^}]*font-size:12px;[^}]*font-weight:400;/);
});

test("Agent content switcher keeps detail and orchestrations in one control", () => {
  // 详情固定在第一项，编排按作用域分组；切换器在详情头部与画布头部是同一个组件。
  assert.match(agentSwitcher, /const DETAIL_ITEM = "__detail__";/);
  assert.match(agentSwitcher, /<DropdownMenuRadioItem :value="DETAIL_ITEM" class="agent-view-switcher-item">/);
  assert.match(agentSwitcher, /<DropdownMenuRadioItem v-for="orchestration in group\.orchestrations"/);
  assert.match(agentView, /<AgentViewSwitcher\s+mode="detail"/);
  assert.match(agentGraph, /<AgentViewSwitcher\s+mode="graph"/);
  assert.match(agentView, /const viewMode = ref<"detail" \| "graph">\("detail"\)/);
});

test("Agent view text stays at or above the 12px floor", () => {
  for (const [name, source] of Object.entries({ "AgentView.vue": agentView, "AgentGraph.vue": agentGraph, "AgentEditor.vue": agentEditor })) {
    for (const match of source.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
      assert.ok(Number(match[1]) >= 12, `${name} must not render text below 12px (found ${match[1]}px)`);
    }
  }
});

test("Agent and Story create rows render with the same single-line metrics", () => {
  // 两个侧边栏的“新建”行都是单行标签：基础行 8px 内边距 + 13px/1.3 标签行高，不能再叠纵向 padding。
  assert.match(storyView, /\.story-tree-item \{[^}]*padding:8px;/);
  assert.match(storyView, /\.story-tree-item > \.story-tree-item-copy strong \{[^}]*line-height:1\.3;/);
  assert.doesNotMatch(storyView, /\.story-new-button \{[^}]*padding-block/);
  assert.match(agentView, /\.agent-new-button \.agent-list-item-copy strong \{ line-height:1\.3; \}/);
  assert.doesNotMatch(agentView, /\.agent-new-button \{[^}]*padding-block/);
});
