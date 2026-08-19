import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  commandTokenAt,
  matchingCommands,
  parseAiSessionCommand,
  replaceCommandToken,
} from "../src/components/ai-session/commands.ts";

const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
const settings = fs.readFileSync(new URL("../src/apps/control-plane/settings/SettingsModal.vue", import.meta.url), "utf8");
const appearance = fs.readFileSync(new URL("../src/apps/control-plane/settings/AppearanceSettingsSection.vue", import.meta.url), "utf8");

test("command menu only opens at the beginning of the composer", () => {
  assert.deepEqual(commandTokenAt("/re", 3, "/"), { start: 0, end: 3, query: "re" });
  assert.equal(commandTokenAt("open /re", 8, "/"), undefined);
  assert.equal(commandTokenAt("/rename task", 12, "/"), undefined);
  assert.deepEqual(matchingCommands("re").map((item) => item.name), ["review", "rename"]);
});

test("command selection and parsing honor a custom trigger", () => {
  const command = matchingCommands("ren")[0];
  const replaced = replaceCommandToken("!ren", 4, "!", command);
  assert.deepEqual(replaced, { value: "!rename ", cursor: 8 });
  assert.deepEqual(parseAiSessionCommand("!rename New thread", "!", "codex"), { command: "rename", argument: "New thread" });
  assert.deepEqual(parseAiSessionCommand("!goal", "!", "codex"), { command: "goal" });
  assert.equal(parseAiSessionCommand("Use !goal here", "!", "codex"), undefined);
});

test("command parsing is disabled for non-Codex sessions", () => {
  assert.equal(parseAiSessionCommand("/review", "/", "claude"), undefined);
  assert.equal(parseAiSessionCommand("/goal keep this as a normal message", "/", undefined), undefined);
});

test("the composer plus button opens the same command menu as the command trigger", () => {
  assert.match(composer, /function openCommandMenu\(\)[\s\S]*emit\("update:modelValue", trigger\)[\s\S]*commandOpen\.value = true/);
  assert.match(composer, /:aria-label="t\('sessions\.composer\.openCommands'\)"[\s\S]*@click="openCommandMenu"/);
  assert.doesNotMatch(composer, /add-context/);
});

test("composer arrow keys are only consumed by a menu with selectable items", () => {
  assert.doesNotMatch(composer, /@keydown\.(?:up|down)(?:\.[^=\s]+)*=/);
  assert.match(composer, /if \(event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"\) \{[\s\S]*const moved = moveActiveMention[\s\S]*if \(moved\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);/);
  assert.match(composer, /if \(commandOpen\.value\) \{[\s\S]*const length = commandCandidates\.value\.length;[\s\S]*if \(!length\) return false;/);
  assert.match(composer, /if \(!mentions\.open\.value\) return false;[\s\S]*const length = mentions\.candidates\.value\.length;[\s\S]*if \(!length\) return false;/);
});

test("the composer offers steer while the session is running and no action request is in flight", () => {
  assert.match(composer, /const canSteer = computed\(\(\) => !editing\.value && props\.sessionBusy && hasDraft\.value\);/);
  assert.doesNotMatch(composer, /const canSteer = computed\(\(\) =>[^;]*props\.busy[^;]*\);/);
  assert.match(composer, /v-if="canSteer"[\s\S]*:disabled="busy"[\s\S]*@click="emit\('steer'\)"/);
});

test("the Codex composer exposes exactly three permission modes beside the plus button", () => {
  assert.match(composer, /class="ai-session-composer__leading">[\s\S]*<Plus :size="18" \/>[\s\S]*<DropdownMenu v-if="permissionProvider === 'codex'">/);
  assert.match(composer, /value: "ask", label: t\("sessions\.permission\.ask"\)/);
  assert.match(composer, /value: "auto-review", label: t\("sessions\.permission\.autoReview"\)/);
  assert.match(composer, /value: "full-access", label: t\("sessions\.permission\.fullAccess"\)/);
  assert.doesNotMatch(composer, /config\.toml|permissionOptions\.value\.push/);
  assert.match(composer, /emit\("run", permissionProvider\.value === "codex" \? permissionMode\.value : undefined\)/);
  assert.match(composer, /useAiSessionPermissionMode/);
  assert.match(composer, /props\.permissionMode !== undefined[\s\S]*emit\("update:permissionMode", value\)/);
  assert.doesNotMatch(composer, /permissionMode\.value = "ask"/);
  assert.match(composer, /\.ai-session-composer__permission-trigger\s*\{[^}]*background: transparent;/s);
  assert.match(composer, /\.ai-session-composer__tool:not\(:disabled\):is\(:hover, :focus-visible\),\s*\.ai-session-composer__permission-trigger:not\(:disabled\):is\(:hover, :focus-visible\)\s*\{[^}]*background: color-mix/s);
  assert.match(composer, /\.ai-session-permission-menu__item\[data-danger="true"\]:is\(:hover, :focus, \[data-highlighted\]\)\)\s*\{[^}]*color: var\(--status-danger\) !important;/s);
});

test("command and mention triggers share one settings save", () => {
  assert.match(appearance, /t\("settings\.composer\.title"\)/);
  assert.match(appearance, /@click="emit\('saveTriggers'\)"/);
  assert.match(settings, /updateControlPlaneSettings\(\{[\s\S]*commandTrigger: commandTrigger\.value,[\s\S]*mentionTrigger: mentionTrigger\.value/);
  assert.doesNotMatch(settings, /saveMentionTrigger|saveCommandTrigger/);
});
