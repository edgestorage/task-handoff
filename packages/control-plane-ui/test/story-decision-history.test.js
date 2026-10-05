import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  STORY_DECISION_VISIBLE_DECIDED_LIMIT,
  splitStoryDecisions,
  storyDecisionMeta,
} from "../src/apps/control-plane/story/storyDecisionPresentation.ts";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryDecisionPanel.vue", import.meta.url), "utf8");

function decision(id, status, extra = {}) {
  return {
    id,
    storyId: "story_1",
    sessionId: "session_1",
    question: `Question ${id}`,
    options: [],
    allowFreeText: true,
    status,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

test("only the most recent decided decisions stay in the main list", () => {
  const input = [
    decision("pending_1", "pending"),
    decision("decided_new", "decided"),
    decision("decided_old", "decided"),
    decision("cancelled_1", "cancelled"),
    decision("decided_oldest", "decided"),
    decision("expired_1", "expired"),
  ];
  const { visible, history } = splitStoryDecisions(input);
  assert.equal(STORY_DECISION_VISIBLE_DECIDED_LIMIT, 1);
  assert.deepEqual(visible.map((item) => item.id), ["pending_1", "decided_new", "cancelled_1", "expired_1"]);
  assert.deepEqual(history.map((item) => item.id), ["decided_old", "decided_oldest"]);
});

test("a recently decided decision stays in the main list until a newer one replaces it", () => {
  const single = splitStoryDecisions([decision("decided_1", "decided")]);
  assert.deepEqual(single.visible.map((item) => item.id), ["decided_1"]);
  assert.deepEqual(single.history, []);
  const replaced = splitStoryDecisions([
    decision("decided_new", "decided"),
    decision("decided_1", "decided"),
  ]);
  assert.deepEqual(replaced.visible.map((item) => item.id), ["decided_new"]);
  assert.deepEqual(replaced.history.map((item) => item.id), ["decided_1"]);
});

test("decision meta shows the selected option or free text plus the continued turn", () => {
  const t = (key, values) => values?.text ? `${key}(${values.text})` : key;
  const option = decision("decided_option", "decided", {
    options: [{ id: "continue", label: "Continue" }],
    selectedOptionId: "continue",
    decidedTurnId: "turn_1",
  });
  assert.equal(storyDecisionMeta(option, t), "stories.decisions.selected(Continue) · stories.decisions.decidedTurn");
  const freeText = decision("decided_text", "decided", { response: "  Continue  ", decidedTurnId: "turn_2" });
  assert.equal(storyDecisionMeta(freeText, t), "stories.decisions.reply(Continue) · stories.decisions.decidedTurn");
  assert.equal(storyDecisionMeta(decision("cancelled_1", "cancelled"), t), "");
});

test("the panel folds older decided rows behind the session-style history disclosure", () => {
  assert.match(panel, /v-for="decision in visibleDecisions"/);
  assert.match(panel, /v-for="decision in historyDecisions"/);
  assert.match(panel, /v-if="historyDecisions\.length" class="story-decision-history"/);
  assert.match(panel, /class="story-decision-history-summary" :aria-expanded="historyOpen" @click="toggleHistory"/);
  assert.match(panel, /if \(historyOpen\.value\) beginDisclosureTransition\(event\.currentTarget as Element\)/);
  assert.match(panel, /<Transition[\s\S]*?name="decision-history-disclosure"/);
  assert.match(panel, /v-if="historyOpen" class="story-decision-history-disclosure"/);
  assert.match(panel, /@before-leave="prepareDisclosureLeave"/);
  assert.match(panel, /@after-leave="finishDisclosureLeave"/);
});

test("the panel resets its expanded history and pending retry when the selected Story changes", () => {
  assert.match(panel, /watch\(\(\) => props\.story\.id, \(\) => \{\s*historyOpen\.value = false;\s*reset\(\);\s*\}\);/);
  const actions = fs.readFileSync(new URL("../src/apps/control-plane/story/useStoryDecisionActions.ts", import.meta.url), "utf8");
  assert.match(actions, /function reset\(\) \{\s*actionError\.value = null;\s*resumePendingId\.value = "";\s*resumeInput\.value = null;\s*\}/);
});

test("the shared answer block clears its draft when the decision changes", () => {
  const answer = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryDecisionAnswer.vue", import.meta.url), "utf8");
  assert.match(answer, /watch\(\(\) => props\.decision\.id, \(\) => \{\s*optionId\.value = "";\s*replyPicked\.value = false;\s*response\.value = "";\s*\}\);/);
});
