import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { selectNextInputSuggestion } from "../src/components/ai-session/next-input-suggestion.ts";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const composer = read("../src/components/ai-session/AiSessionComposer.vue");
const settings = read("../src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
const panel = read("../src/apps/control-plane/instance-detail/AiSessionPanel.vue");
const dock = read("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue");
const enInstances = read("../src/i18n/locales/en-US/instances.ts");
const zhInstances = read("../src/i18n/locales/zh-CN/instances.ts");

const suggestion = {
  text: "继续修复测试。",
  turnId: "turn_1",
  generatedAt: "2026-11-25T00:00:31.000Z",
};
const session = (overrides = {}) => ({
  status: "idle",
  queue: { pendingCount: 0 },
  nextInputSuggestion: suggestion,
  ...overrides,
});

test("a suggestion is only selected for the current settled turn", () => {
  assert.deepEqual(selectNextInputSuggestion(session(), "turn_1"), suggestion);
  assert.equal(selectNextInputSuggestion(undefined, "turn_1"), undefined);
  assert.equal(selectNextInputSuggestion(session({ status: "running" }), "turn_1"), undefined);
  assert.equal(selectNextInputSuggestion(session({ queue: { pendingCount: 1 } }), "turn_1"), undefined);
  assert.equal(selectNextInputSuggestion(session({ lineage: { kind: "subagent" } }), "turn_1"), undefined);
  assert.equal(selectNextInputSuggestion(session(), "turn_2"), undefined);
  assert.equal(selectNextInputSuggestion(session({ nextInputSuggestion: undefined }), "turn_1"), undefined);
});

test("summary patches keep a valid suggestion and detail merging never introduces one", () => {
  const patched = { ...session(), lastMessage: "streamed text", updatedAt: "2026-11-25T00:02:00.000Z" };
  assert.deepEqual(selectNextInputSuggestion(patched, "turn_1"), suggestion);
  const detail = { status: "idle", queue: { pendingCount: 0 }, turns: [{ id: "turn_1", status: "completed" }] };
  assert.equal(selectNextInputSuggestion({ ...session(), ...detail }, "turn_1"), suggestion);
});

test("the composer only shows a suggestion after explicit placeholder, busy, draft, attachment and consumption gates", () => {
  assert.match(composer, /const suggestionVisible = computed\(\(\) => Boolean\([\s\S]*!props\.placeholder[\s\S]*props\.nextInputSuggestion\?\.text[\s\S]*!props\.busy[\s\S]*!props\.sessionBusy[\s\S]*!editing\.value[\s\S]*!props\.modelValue[\s\S]*!attachments\.value\.length[\s\S]*!consumedSuggestions\.has\(nextInputSuggestionKey\.value\)[\s\S]*\)\);/);
  assert.match(composer, /const displayedPlaceholder = computed\(\(\) => \(\s*props\.placeholder\s*\|\| \(suggestionVisible\.value \? props\.nextInputSuggestion!\.text : t\("sessions\.composer\.followUp"\)\)\s*\)\);/);
  assert.match(composer, /:style="suggestionInputStyle"/);
  assert.match(composer, /:aria-describedby="suggestionVisible \? suggestionHintId : undefined"/);
  assert.match(composer, /t\('sessions\.composer\.acceptSuggestionHint'\)/);
  assert.match(composer, /<button\s+v-if="suggestionVisible"\s+ref="suggestionBadgeEl"\s+type="button"\s+class="ai-session-composer__suggestion-badge"\s+:aria-label="t\('sessions\.composer\.acceptSuggestionHint'\)"\s+:title="t\('sessions\.composer\.acceptSuggestionHint'\)"\s+@click="acceptNextInputSuggestion"/);
  assert.match(composer, /t\('sessions\.composer\.suggestionLabel'\)/);
  assert.match(composer, /<kbd class="ai-session-composer__suggestion-key">\{\{ t\('sessions\.composer\.suggestionKey'\) \}\}<\/kbd>/);
  assert.match(composer, /const suggestionInputStyle = computed\(\(\) => suggestionVisible\.value[\s\S]*?paddingRight: `\$\{\(suggestionBadgeWidth\.value \|\| SUGGESTION_BADGE_FALLBACK_WIDTH\) \+ 28\}px`/);
  assert.match(composer, /new ResizeObserver\(measureSuggestionBadge\)/);
});

test("Tab accepts a suggestion after command and mention handling without sending", () => {
  const command = composer.indexOf("if (commandOpen.value)");
  const mention = composer.indexOf("if (mentions.open.value)");
  const accept = composer.indexOf('event.key === "Tab"\n    && !event.shiftKey');
  assert.ok(command >= 0 && mention > command && accept > mention, "command, mention, then suggestion");
  const block = composer.slice(accept, composer.indexOf("if (event.key !== \"Enter\"", accept));
  assert.match(block, /!event\.altKey[\s\S]*!event\.ctrlKey[\s\S]*!event\.metaKey[\s\S]*!event\.isComposing/);
  assert.match(block, /acceptNextInputSuggestion\(\)/);
  const acceptHandler = composer.indexOf("function acceptNextInputSuggestion()");
  assert.ok(acceptHandler > accept, "shared accept handler follows the keyboard handlers");
  const handler = composer.slice(acceptHandler, composer.indexOf("function moveActiveMention", acceptHandler));
  assert.match(handler, /rememberConsumedSuggestion\(nextInputSuggestionKey\.value\)/);
  assert.match(handler, /draft\.value = props\.nextInputSuggestion!\.text/);
  assert.match(handler, /setSelectionRange\(props\.nextInputSuggestion!\.text\.length, props\.nextInputSuggestion!\.text\.length\)/);
  assert.match(handler, /element\.focus\(\)/);
  assert.match(handler, /resizeInput\(\)/);
  assert.doesNotMatch(handler, /emit\("run"\)/);
  assert.match(composer, /if \(consumedSuggestions\.size <= 2_000\) return;/);
  assert.match(composer, /if \(consumedSuggestions\.size <= 1_500\) break;/);
});

test("instance settings default off and require both capability owners", () => {
  assert.match(settings, /const aiSessionNextInputSuggestionEnabled = ref\(false\);/);
  assert.match(settings, /supportsNodeAiSessionNextInputSuggestion\(nodeCapabilities\)[\s\S]*&& supportsAiSessionNextInputSuggestion\(props\.instance\?\.capabilities\)/);
  assert.match(settings, /:disabled="savingGeneral \|\| !nextInputSuggestionSupported"/);
  assert.match(settings, /aiSessionNextInputSuggestionUnsupported/);
  assert.match(settings, /aiSessionNextInputSuggestionEnabled\.value !== props\.instance\.config\.aiSessionNextInputSuggestionEnabled/);
  assert.match(settings, /\.\.\.\(nextInputSuggestionSupported\.value \? \{ aiSessionNextInputSuggestionEnabled: aiSessionNextInputSuggestionEnabled\.value \} : \{\}\)/);
  assert.match(settings, /catch \(cause\) \{[\s\S]*aiSessionNextInputSuggestionEnabled\.value = props\.instance\.config\.aiSessionNextInputSuggestionEnabled === true;/);
});

test("instance settings expose every reasoning mode, default to none, and require both capability owners", () => {
  assert.match(settings, /const aiSessionNextInputSuggestionReasoningEffort = ref<AiSessionNextInputSuggestionReasoningEffort>\(AI_SESSION_NEXT_INPUT_SUGGESTION_DEFAULT_REASONING_EFFORT\);/);
  assert.match(settings, /<ControlPlaneSelect v-model="aiSessionNextInputSuggestionReasoningEffort"[\s\S]*?<ControlPlaneSelectItem value="session">/);
  assert.match(settings, /<ControlPlaneSelectItem v-for="effort in AI_SESSION_REASONING_EFFORTS"[\s\S]*?:value="effort"/);
  assert.match(settings, /supportsNodeAiSessionNextInputSuggestionReasoningEffort\(nodeCapabilities\)[\s\S]*&& supportsAiSessionNextInputSuggestionReasoningEffort\(props\.instance\?\.capabilities\)/);
  assert.match(settings, /:disabled="savingGeneral \|\| !nextInputSuggestionReasoningEffortSupported"/);
  assert.match(settings, /aiSessionNextInputSuggestionReasoningUnsupported/);
  assert.match(settings, /aiSessionNextInputSuggestionReasoningEffort\.value !== props\.instance\.config\.aiSessionNextInputSuggestionReasoningEffort/);
  assert.match(settings, /\.\.\.\(nextInputSuggestionReasoningEffortSupported\.value \? \{ aiSessionNextInputSuggestionReasoningEffort: aiSessionNextInputSuggestionReasoningEffort\.value \} : \{\}\)/);
  assert.match(settings, /catch \(cause\) \{[\s\S]*aiSessionNextInputSuggestionReasoningEffort\.value = props\.instance\.config\.aiSessionNextInputSuggestionReasoningEffort;/);
  assert.match(enInstances, /aiSessionNextInputSuggestionReasoning: "Reasoning effort"[\s\S]*aiSessionNextInputSuggestionFollowSession: "Follow session"/);
  assert.match(zhInstances, /aiSessionNextInputSuggestionReasoning: "思考程度"[\s\S]*aiSessionNextInputSuggestionFollowSession: "跟随会话"/);
});

test("detail panels read suggestions from the summary and validate the visible turn", () => {
  for (const source of [panel, dock]) {
    assert.match(source, /import \{ selectNextInputSuggestion \} from "\.\.\/\.\.\/\.\.\/components\/ai-session\/next-input-suggestion";/);
    assert.match(source, /latestTurnRef\?\.id\s*\|\| aiSessionTurns\([\s\S]*?\)\.at\(-1\)\?\.id/);
    assert.match(source, /selectNextInputSuggestion\(session, latestTurnId\)/);
  }
});
