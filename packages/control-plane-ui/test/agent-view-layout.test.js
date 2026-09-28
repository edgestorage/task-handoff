import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const agentView = read("src/apps/control-plane/agent/AgentView.vue");
const agentGraph = read("src/apps/control-plane/agent/AgentGraph.vue");
const agentEditor = read("src/apps/control-plane/agent/AgentEditor.vue");

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

test("Agent call graph stays reachable from the Story-style list options", () => {
  assert.match(agentView, /<DropdownMenuRadioItem value="list">/);
  assert.match(agentView, /<DropdownMenuRadioItem value="graph">/);
  assert.match(agentView, /:aria-label="t\('agents\.listOptions'\)"/);
  assert.match(agentView, /const viewMode = ref<"list" \| "graph">\("list"\)/);
});

test("Agent view text stays at or above the 12px floor", () => {
  for (const [name, source] of Object.entries({ "AgentView.vue": agentView, "AgentGraph.vue": agentGraph, "AgentEditor.vue": agentEditor })) {
    for (const match of source.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
      assert.ok(Number(match[1]) >= 12, `${name} must not render text below 12px (found ${match[1]}px)`);
    }
  }
});
