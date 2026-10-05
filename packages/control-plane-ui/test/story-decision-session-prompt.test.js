import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { storyDecisionItemsOutsideSessionDisplay } from "../src/apps/control-plane/action-inbox/storyDecisionItems.ts";
import {
  inSessionDisplayedDecisionIds,
  releaseInSessionDisplayedDecisions,
  retainInSessionDisplayedDecisions,
} from "../src/apps/control-plane/story/sessionDecisionDisplay.ts";

const root = new URL("../src/", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("the session prompt shows only its own pending decisions above the composer", () => {
  const prompt = read("components/ai-session/AiSessionDecisionPrompt.vue");

  // Hide the whole card until the current session actually has a pending decision.
  assert.match(prompt, /<section v-if="pendingDecisions\.length" class="ai-session-detail-decisions">/);
  assert.match(prompt, /const query = useQuery\(storyDecisionsQueryOptions\(\(\) => props\.storyId, \(\) => props\.nodeId\)\);/);
  assert.match(prompt, /\.filter\(\(decision\) => decision\.status === "pending" && decision\.sessionId === props\.sessionId\)/);

  // Decisions are answered inline through the shared answer block and action state machine.
  assert.match(prompt, /import StoryDecisionAnswer from "\.\.\/\.\.\/apps\/control-plane\/story\/StoryDecisionAnswer\.vue";/);
  assert.match(prompt, /<StoryDecisionAnswer[\s\S]*?:decision="decision"[\s\S]*?:disabled="disabled"[\s\S]*?:busy="busyId === decision\.id"[\s\S]*?@submit="\(input\) => submit\(decision, input\)"[\s\S]*?@cancel="cancel\(decision\)"/);
  assert.match(prompt, /useStoryDecisionActions\(\(\) => props\.storyId, \(\) => props\.nodeId\)/);
  assert.doesNotMatch(prompt, /<Textarea/);
  assert.doesNotMatch(prompt, /sharedControlPlaneClient/);
  assert.match(prompt, /stories\.decisions\.resumePending/);
  assert.match(prompt, /stories\.decisions\.retry/);
  assert.match(prompt, /stories\.decisions\.context/);
});

test("the prompt reads as one floating card that continues into the composer", () => {
  const prompt = read("components/ai-session/AiSessionDecisionPrompt.vue");

  // Same visual language as the queue card: divider-delineated rows on the raised surface.
  assert.match(prompt, /\.ai-session-detail-decisions\s*\{[^}]*border:\s*1px solid var\(--line\);[^}]*border-radius:\s*18px 18px 0 0;[^}]*background:\s*var\(--surface-raised\);/);
  assert.match(prompt, /\.ai-session-detail-decisions-head\s*\{[^}]*min-height:\s*34px;[^}]*border-bottom:\s*1px solid var\(--line\);[^}]*font-size:\s*12px;/);
  assert.match(prompt, /\.ai-session-detail-decisions-title\s*\{\s*color:\s*var\(--text-strong\);\s*font-weight:\s*500;\s*\}/);
  assert.match(prompt, /\.ai-session-detail-decision\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*10px 12px;/);
  assert.match(prompt, /\.ai-session-detail-decision \+ \.ai-session-detail-decision\s*\{\s*border-top:\s*1px solid var\(--line\);\s*\}/);
  assert.match(prompt, /\.ai-session-detail-decision-question\s*\{[^}]*color:\s*var\(--text-strong\);[^}]*font-size:\s*13px;[^}]*font-weight:\s*500;/);
  assert.match(prompt, /\.ai-session-detail-decisions-list :deep\(\[data-reka-scroll-area-viewport\]\)\s*\{\s*max-height:\s*260px;\s*\}/);

  // The header names the block and counts the pending questions.
  assert.match(prompt, /<CircleHelp :size="14" aria-hidden="true" \/>/);
  assert.match(prompt, /\{\{ t\("stories\.decisions\.title"\) \}\}/);
  assert.match(prompt, /\{\{ pendingDecisions\.length \}\}/);
});

test("the session panel prioritizes decisions above the queued messages", () => {
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const styles = read("apps/control-plane/instance-detail/AiSessionPanel.css");

  assert.match(panel, /import AiSessionDecisionPrompt from "\.\.\/\.\.\/\.\.\/components\/ai-session\/AiSessionDecisionPrompt\.vue";/);
  assert.match(panel, /class="session-ai-compose-stack"[\s\S]*<AiSessionDecisionPrompt[\s\S]*v-if="selectedSession\?\.storyId"[\s\S]*:disabled="instance\.connectionStatus !== 'online'"[\s\S]*:node-id="instance\.nodeId"[\s\S]*:session-id="selectedSession\.id"[\s\S]*:story-id="selectedSession\.storyId"[\s\S]*<AiSessionQueue/);

  // The decision card and the queue share the same inset, so they read as one stack above the input.
  assert.match(styles, /\.session-ai-compose-decisions\s*\{\s*z-index:\s*0;\s*margin:\s*0 28px -1px;\s*\}/);
  assert.match(styles, /\.session-ai-compose-decisions \+ \.session-ai-compose-queue :deep\(\.ai-session-detail-queue-head\)\s*\{\s*border-top-left-radius:\s*0;\s*border-top-right-radius:\s*0;\s*\}/);
});

test("Story panels and the session prompt answer through one revisioned state machine", () => {
  const actions = read("apps/control-plane/story/useStoryDecisionActions.ts");
  // Requests pin the Story they were issued for, so an in-flight answer cannot land in another Story's snapshot.
  assert.match(actions, /const target = currentTarget\(\);[\s\S]*?decideStoryDecision\(target\.storyId, decision\.id, target\.nodeId, \{[\s\S]*?expectedRevision: decision\.revision,[\s\S]*?\.\.\.input,[\s\S]*?\.\.\.\(retry \? \{ retry: true \} : \{\}\),/);
  assert.match(actions, /cancelStoryDecision\(target\.storyId, decision\.id, target\.nodeId, \{ expectedRevision: decision\.revision \}\)/);
  assert.match(actions, /const resumePending = isStoryDecisionResumePending\(cause\);/);
  assert.match(actions, /controlPlaneQueryKeys\.storyDecisions\(target\.nodeId, target\.storyId\)/);
});

test("decisions already shown inside their session leave the floating approval card", () => {
  const inboxItem = (decisionId, sessionId) => ({
    type: "story-decision",
    key: `story-decision:story_1:${decisionId}`,
    story: { id: "story_1", ownerNodeId: "node_1" },
    decision: { id: decisionId, sessionId, status: "pending" },
  });
  const current = inboxItem("decision-current", "session-1");
  const other = inboxItem("decision-other", "session-2");

  assert.deepEqual(storyDecisionItemsOutsideSessionDisplay([current, other], new Set()).map((item) => item.decision.id), ["decision-current", "decision-other"]);
  retainInSessionDisplayedDecisions(["decision-current"]);
  assert.deepEqual([...inSessionDisplayedDecisionIds().value], ["decision-current"]);
  assert.deepEqual(
    storyDecisionItemsOutsideSessionDisplay([current, other], inSessionDisplayedDecisionIds().value).map((item) => item.decision.id),
    ["decision-other"],
  );

  // 计数式登记：同一决策被多个会话视图同时展示时，先卸载的那个不会提前恢复浮层展示。
  retainInSessionDisplayedDecisions(["decision-current"]);
  releaseInSessionDisplayedDecisions(["decision-current"]);
  assert.equal(inSessionDisplayedDecisionIds().value.has("decision-current"), true);
  releaseInSessionDisplayedDecisions(["decision-current"]);
  assert.equal(inSessionDisplayedDecisionIds().value.size, 0);
  assert.deepEqual(
    storyDecisionItemsOutsideSessionDisplay([current, other], inSessionDisplayedDecisionIds().value).map((item) => item.decision.id),
    ["decision-current", "decision-other"],
  );
});

test("the prompt owns the in-session display registry and the workbench consumes it", () => {
  const prompt = read("components/ai-session/AiSessionDecisionPrompt.vue");
  const display = read("apps/control-plane/story/sessionDecisionDisplay.ts");
  const workbench = read("apps/control-plane/ControlPlaneWorkbench.vue");

  assert.match(prompt, /useInSessionDecisionDisplay\(computed\(\(\) => pendingDecisions\.value\.map\(\(decision\) => decision\.id\)\)\)/);
  assert.match(display, /onBeforeUnmount\(\(\) => \{\s*releaseInSessionDisplayedDecisions\(registered\);/);
  assert.match(display, /watch\(\(\) => toValue\(decisionIds\), \(next\) => \{/);
  assert.match(workbench, /storyDecisionItemsOutsideSessionDisplay\(storyDecisionInbox\.items\.value, inSessionDisplayedDecisionIds\(\)\.value\)/);
});
