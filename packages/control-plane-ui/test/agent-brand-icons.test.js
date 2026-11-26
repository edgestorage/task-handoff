import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("all AI agent providers use the shared six-agent brand registry", () => {
  const registry = read("src/components/aiAgentIcon.ts");
  assert.match(registry, /\["codex", "claude", "opencode", "gemini", "commandcode", "dsh"\]/);

  const icon = read("src/components/AiAgentIcon.vue");
  for (const source of ["codex.svg", "claudecode.svg", "opencode.svg", "gemini.svg", "command-code.svg", "deepseek.svg"]) {
    assert.match(icon, new RegExp(source.replace(".", "\\.")));
  }

  for (const source of ["assets/gemini.svg", "assets/command-code.svg"]) {
    const svg = read(`src/${source}`);
    assert.match(svg, /<path fill="currentColor"/);
    assert.doesNotMatch(svg, /fill="#[0-9a-f]{3,8}"/i);
  }

  const settings = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  assert.match(settings, /<AiAgentIcon v-if="isAiAgentId\(app\.id\)"/);

  for (const agent of ["codex", "claude", "opencode", "gemini", "commandcode", "dsh"]) {
    assert.match(read("src/i18n/locales/en-US/common.ts"), new RegExp(`${agent}:`));
    assert.match(read("src/i18n/locales/zh-CN/common.ts"), new RegExp(`${agent}:`));
  }
});

test("mobile agent icons cover the same six providers", () => {
  const mobile = fs.readFileSync(new URL("../../../apps/mobile/src/components/AiAgentIcon.tsx", import.meta.url), "utf8");
  for (const agent of ["codex", "claude", "opencode", "gemini", "commandcode", "dsh"]) {
    assert.match(mobile, new RegExp(`${agent}: \\{`));
  }
});
