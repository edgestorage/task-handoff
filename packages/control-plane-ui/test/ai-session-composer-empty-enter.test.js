import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
const controlledComposer = fs.readFileSync(
  new URL("../../controlled-instance-ui/src/components/ai-session/AiSessionComposer.vue", import.meta.url),
  "utf8",
);

test("Enter on an empty composer does not submit or interrupt the session", () => {
  assert.match(
    composer,
    /if \(event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing\) \{[\s\S]*if \(props\.submitHidden\) return;[\s\S]*event\.preventDefault\(\);[\s\S]*if \(editing\.value \? !props\.modelValue\.trim\(\) : !hasDraft\.value\) \{\s*return;\s*\}[\s\S]*submit\(\);/,
  );
});

test("the stop affordance stays available through the submit button", () => {
  assert.match(composer, /const canRun = computed\(\(\) => !props\.disabled && \(editing\.value \? props\.modelValue\.trim\(\)\.length > 0 : hasDraft\.value \|\| \(!props\.busy && props\.canInterrupt\)\)\);/);
  assert.match(composer, /function submit\(\) \{[\s\S]*if \(!props\.busy && canRun\.value\) \{[\s\S]*emit\("run"/);
});

test("the controlled-instance composer also ignores Enter without a draft", () => {
  assert.match(
    controlledComposer,
    /function handleInputKeydown\(event: KeyboardEvent\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*if \(!hasDraft\.value\) \{\s*return;\s*\}[\s\S]*submit\(\);/,
  );
});
