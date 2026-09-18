import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexStoryMcpArgs } from "./src/managed-app-definitions/codex/story-mcp-config.ts";
import { openCodeServerConfig } from "./src/managed-app-definitions/opencode/server-config.ts";

test("Codex receives an ephemeral MCP configuration without embedding its token", () => {
  const args = codexStoryMcpArgs({
    TASK_HANDOFF_AGENT_TOOLS_ENDPOINT: "http://127.0.0.1:8080/api/internal/agent-tools",
    TASK_HANDOFF_AGENT_TOOLS_TOKEN: "private-token",
  });

  assert.deepEqual(args, [
    "-c",
    "mcp_servers.task_handoff_story.url=\"http://127.0.0.1:8080/api/internal/agent-tools/mcp\"",
    "-c",
    "mcp_servers.task_handoff_story.bearer_token_env_var=\"TASK_HANDOFF_AGENT_TOOLS_TOKEN\"",
  ]);
  assert.equal(args.join(" ").includes("private-token"), false);
});

test("OpenCode merges the managed file plugin with its model configuration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-plugin-"));
  const pluginPath = path.join(directory, "story-plugin.mjs");
  fs.writeFileSync(pluginPath, "export default {};");
  try {
    const config = openCodeServerConfig({
      TASK_HANDOFF_OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "provider/model", plugin: ["existing-plugin"] }),
      TASK_HANDOFF_OPENCODE_STORY_PLUGIN: pluginPath,
    });
    assert.equal(config.model, "provider/model");
    assert.deepEqual(config.plugin, ["existing-plugin", new URL(`file://${pluginPath}`).href]);
    assert.equal(JSON.stringify(config).includes("TOKEN"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
