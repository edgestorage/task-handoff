import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(path) {
  return fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

test("queue and goal height transitions preserve their existing DOM sibling structure", () => {
  const transition = source("components/ai-session/AiSessionHeightTransition.vue");
  const dock = source("apps/control-plane/ai-board/AiSessionFloatingDock.vue");
  const panel = source("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const result = source("components/ai-session/AiSessionResult.vue");

  assert.match(transition, /<Transition[\s\S]*?:css="false"[\s\S]*?<slot \/>/);
  assert.match(transition, /getBoundingClientRect\(\)\.height/);
  assert.match(transition, /prefers-reduced-motion/);
  assert.match(transition, /target\.style\.height = "0px"/);
  assert.match(transition, /function enter[\s\S]*?target\.style\.height = "auto"[\s\S]*?getBoundingClientRect\(\)\.height/);
  const beforeEnterBody = transition.slice(
    transition.indexOf("function beforeEnter"),
    transition.indexOf("function enter"),
  );
  assert.doesNotMatch(beforeEnterBody, /getBoundingClientRect/);
  assert.match(dock, /<AiSessionHeightTransition>[\s\S]*?<AiSessionQueue[\s\S]*?<\/AiSessionHeightTransition>[\s\S]*?<AiSessionHeightTransition>[\s\S]*?<AiSessionGoalBadge/);
  assert.match(panel, /<AiSessionHeightTransition>[\s\S]*?<AiSessionQueue[\s\S]*?<\/AiSessionHeightTransition>[\s\S]*?<AiSessionHeightTransition>[\s\S]*?<AiSessionGoalBadge/);
  assert.match(result, /<AiSessionHeightTransition>[\s\S]*?<AiSessionQueue[\s\S]*?<\/AiSessionHeightTransition>/);
});

test("queue item count changes animate dynamic row height", () => {
  const queue = source("components/ai-session/AiSessionQueue.vue");

  assert.match(queue, /<TransitionGroup name="ai-session-queue-item"[\s\S]*?class="ai-session-detail-queue-item-shell"/);
  assert.match(queue, /\.ai-session-detail-queue-item-shell \{[\s\S]*?grid-template-rows: 1fr;[\s\S]*?transition:\s*grid-template-rows/);
  assert.match(queue, /\.ai-session-queue-item-enter-from,[\s\S]*?\.ai-session-queue-item-leave-to \{[\s\S]*?grid-template-rows: 0fr;/);
  assert.match(queue, /prefers-reduced-motion[\s\S]*?\.ai-session-detail-queue-item-shell/);
});
