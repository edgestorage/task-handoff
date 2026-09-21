import assert from "node:assert/strict";
import test from "node:test";
import { STORY_AGENT_TOOL_NAMES } from "@task-handoff/protocol/story-agent-tools";
import { codexThreadConfig } from "../src/codex-app-server/story-tool-config.ts";
import { openCodeSessionPermissionRules } from "../src/opencode/story-tool-permissions.ts";

test("Codex Story MCP config is isolated per thread allowlist", () => {
  assert.deepEqual(codexThreadConfig("high", ["story_list_content", "story_list_actions"]), {
    model_reasoning_effort: "high",
    "mcp_servers.task_handoff_story.enabled": true,
    "mcp_servers.task_handoff_story.enabled_tools": ["story_list_content", "story_list_actions"],
  });
  assert.deepEqual(codexThreadConfig(undefined, []), {
    "mcp_servers.task_handoff_story.enabled": false,
  });
});

test("OpenCode preserves base rules and appends exact Story allow and deny rules", () => {
  const rules = openCodeSessionPermissionRules(undefined, ["story_list_actions"], [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "story_list_content", pattern: "*", action: "allow" },
  ]);

  assert.deepEqual(rules[0], { permission: "bash", pattern: "*", action: "ask" });
  assert.equal(rules.length, STORY_AGENT_TOOL_NAMES.length + 1);
  for (const name of STORY_AGENT_TOOL_NAMES) {
    assert.equal(rules.findLast((rule) => rule.permission === name)?.action, name === "story_list_actions" ? "allow" : "deny");
  }
});

test("OpenCode explicit permission mode remains ahead of Story-specific last-match rules", () => {
  const rules = openCodeSessionPermissionRules("full-access", []);
  assert.deepEqual(rules[0], { permission: "*", pattern: "*", action: "allow" });
  assert.equal(rules.at(-1)?.action, "deny");
});

test("OpenCode distinguishes omitted Story policy from an explicit empty allowlist", () => {
  assert.equal(openCodeSessionPermissionRules(undefined, undefined), undefined);

  const denied = openCodeSessionPermissionRules(undefined, [], [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "story_list_content", pattern: "*", action: "allow" },
  ]);
  assert.equal(denied.length, STORY_AGENT_TOOL_NAMES.length + 1);
  assert.deepEqual(denied[0], { permission: "bash", pattern: "*", action: "ask" });
  assert.ok(STORY_AGENT_TOOL_NAMES.every((name) => denied.findLast((rule) => rule.permission === name)?.action === "deny"));
});
