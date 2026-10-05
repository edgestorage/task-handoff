import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { applyStoryDecisionUpdate, isStoryDecisionResumePending, storyDecisionInboxItems, storyDecisionNodes } from "../src/apps/control-plane/action-inbox/storyDecisionItems.ts";

const root = new URL("../src/apps/control-plane/", import.meta.url);
const read = (relativePath) => fs.readFileSync(new URL(relativePath, root), "utf8");

function story(id, extra = {}) {
  return { id, ownerNodeId: "node-a", title: `Story ${id}`, documents: [], actions: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...extra };
}

function decision(id, createdAt, extra = {}) {
  return { id, storyId: "story-1", sessionId: "session-1", question: `Question ${id}`, options: [], allowFreeText: true, status: "pending", revision: 1, createdAt, updatedAt: createdAt, ...extra };
}

test("the inbox projects pending decisions of live stories newest first", () => {
  const items = storyDecisionInboxItems([
    {
      story: story("story-1"),
      decisions: [
        decision("decision-old", "2026-01-01T00:00:00.000Z"),
        decision("decision-done", "2026-01-03T00:00:00.000Z", { status: "decided" }),
        decision("decision-new", "2026-01-02T00:00:00.000Z"),
      ],
    },
    {
      story: story("story-2", { archivedAt: "2026-01-01T00:00:00.000Z" }),
      decisions: [decision("decision-archived", "2026-01-04T00:00:00.000Z")],
    },
  ]);
  assert.deepEqual(items.map((item) => item.key), [
    "story-decision:node-a:story-1:decision-new",
    "story-decision:node-a:story-1:decision-old",
  ]);
  assert.deepEqual(items.map((item) => item.type), ["story-decision", "story-decision"]);
  assert.equal(items[0].story.title, "Story story-1");
  assert.equal(items[0].decision.question, "Question decision-new");
  assert.deepEqual(storyDecisionInboxItems([]), []);
});

test("deciding writes the authoritative response back into the Story decision snapshot", () => {
  const current = { decisions: [decision("decision-1", "2026-01-01T00:00:00.000Z"), decision("decision-2", "2026-01-02T00:00:00.000Z")] };
  const updated = { ...current.decisions[0], status: "decided", revision: 2, selectedOptionId: "continue" };
  const next = applyStoryDecisionUpdate(current, updated);
  assert.deepEqual(next.decisions.map((item) => [item.id, item.status]), [["decision-1", "decided"], ["decision-2", "pending"]]);
  const appended = applyStoryDecisionUpdate({ decisions: [] }, updated);
  assert.deepEqual(appended.decisions.map((item) => item.id), ["decision-1"]);
  assert.equal(applyStoryDecisionUpdate(undefined, updated), undefined);
});

test("only nodes that declare decision tools take part in the inbox", () => {
  const node = (id, decisions) => ({ id, capabilities: { agent: { capabilities: { stories: { agentToolCapabilities: { decisions } } } } } });
  assert.deepEqual(storyDecisionNodes([
    node("node-a", true),
    node("node-b", false),
    { id: "node-c", capabilities: {} },
    { id: "node-d" },
  ]).map((entry) => entry.id), ["node-a"]);
  assert.deepEqual(storyDecisionNodes([]), []);
});

test("legacy resuming replies require an explicit confirmed retry", () => {
  assert.equal(isStoryDecisionResumePending({ code: "STORY_DECISION_RESUME_PENDING" }), true);
  assert.equal(isStoryDecisionResumePending(new Error("STORY_DECISION_RESUME_PENDING")), false);
  assert.equal(isStoryDecisionResumePending(undefined), false);
  const workbench = read("ControlPlaneWorkbench.vue");
  assert.match(workbench, /if \(!isStoryDecisionResumePending\(error\) \|\| !window\.confirm\(t\("stories\.decisions\.resumePending"\)\)\) throw error;/);
  assert.match(workbench, /\{ expectedRevision: item\.decision\.revision, \.\.\.input, retry: true \}/);
});

test("the inbox source reuses the Story view queries and heals unavailable nodes", () => {
  const source = read("action-inbox/useStoryDecisionInbox.ts");
  assert.match(source, /storyDecisionNodes\(nodesQuery\.data\.value \|\| \[\]\)/);
  assert.match(source, /storyNodeQueryOptions\(node\.id, enabled\)/);
  assert.match(source, /storyDecisionsQueryOptions\(story\.id, story\.ownerNodeId, enabled\)/);
  // 快照式查询不自愈：节点恢复在线后必须补拉曾经不可用的目录与失败的决策。
  assert.match(source, /unavailableNodeIds\.includes\(node\.id\)/);
  assert.match(source, /if \(query\.isError\) void query\.refetch\(\)/);
});

test("the workbench merges Story decisions into the approval center with a dedicated busy key", () => {
  const workbench = read("ControlPlaneWorkbench.vue");
  assert.match(workbench, /useStoryDecisionInbox\(\(\) => !standaloneMode\.value\)/);
  assert.match(workbench, /mergeActionInboxItems\(\s*aiSessionApprovalItems\(boardInstancesWithAiSessions\.value\),\s*operationApprovalStore\.snapshot\.value\.requests,\s*storyDecisionItemsOutsideSessionDisplay\(storyDecisionInbox\.items\.value, inSessionDisplayedDecisionIds\(\)\.value\),/);
  assert.match(workbench, /:busy-key="aiApprovalBusyKey \|\| operationApprovalBusyKey \|\| storyDecisionBusyKey"/);
  assert.match(workbench, /@decide-story="decideActionInboxStoryDecision"/);
  assert.match(workbench, /@cancel-story="cancelActionInboxStoryDecision"/);
  assert.match(workbench, /decideStoryDecision\(item\.story\.id, item\.decision\.id, item\.story\.ownerNodeId, \{ expectedRevision: item\.decision\.revision, \.\.\.input \}\)/);
  assert.match(workbench, /cancelStoryDecision\(item\.story\.id, item\.decision\.id, item\.story\.ownerNodeId, \{ expectedRevision: item\.decision\.revision \}\)/);
  assert.match(workbench, /queryClient\.setQueryData\(key, \(current: StoryDecisionList \| undefined\) => applyStoryDecisionUpdate\(current, updated\)\)/);
  assert.match(workbench, /if \(item\.type === "story-decision"\) return `\$\{t\("navigation\.storyDecision"\)\} · \$\{item\.story\.title\}`/);
});

test("Story cards answer through the shared decision block while the busy key disables it", () => {
  const inbox = read("action-inbox/ActionInbox.vue");
  const answer = read("story/StoryDecisionAnswer.vue");
  const en = fs.readFileSync(new URL("../../i18n/locales/en-US/navigation.ts", root), "utf8");
  const zh = fs.readFileSync(new URL("../../i18n/locales/zh-CN/navigation.ts", root), "utf8");
  assert.match(inbox, /v-else-if="item\.type === 'story-decision'"/);
  assert.match(inbox, /t\('navigation\.storyDecision'\)/);
  assert.match(inbox, /\{\{ item\.decision\.question \}\}/);
  assert.match(inbox, /\{\{ item\.story\.title \}\}/);
  assert.match(inbox, /import StoryDecisionAnswer from "\.\.\/story\/StoryDecisionAnswer\.vue"/);
  assert.match(inbox, /<StoryDecisionAnswer[\s\S]*?:decision="item\.decision"[\s\S]*?:disabled="Boolean\(busyKey\)"[\s\S]*?:busy="busyKey === item\.key"[\s\S]*?@submit="\(input\) => emit\('decide-story', item, input\)"[\s\S]*?@cancel="emit\('cancel-story', item\)"/);
  assert.doesNotMatch(inbox, /storyReplies/);
  assert.doesNotMatch(inbox, /<Textarea/);
  assert.match(answer, /busy \? t\("stories\.decisions\.submitting"\) : t\("stories\.decisions\.submit"\)/);
  assert.match(en, /storyDecision: "Story decision",/);
  assert.match(zh, /storyDecision: "Story 决策",/);
});

test("the decisions panel consumes the shared snapshot shape written by the inbox", () => {
  const panel = read("story/StoryDecisionPanel.vue");
  const actions = read("story/useStoryDecisionActions.ts");
  assert.match(panel, /useQuery\(storyDecisionsQueryOptions\(\(\) => props\.story\.id, \(\) => props\.story\.ownerNodeId\)\)/);
  assert.match(panel, /if \(data\) decisions\.value = data\.decisions;/);
  // 提交、重试与取消的状态机统一在 useStoryDecisionActions 中，写回审批中心同一个快照键。
  assert.match(panel, /useStoryDecisionActions\(\(\) => props\.story\.id, \(\) => props\.story\.ownerNodeId\)/);
  assert.doesNotMatch(panel, /sharedControlPlaneClient\.stories\.decideStory/);
  assert.match(actions, /controlPlaneQueryKeys\.storyDecisions\(target\.nodeId, target\.storyId\)/);
  assert.match(actions, /queryClient\.setQueryData\(key, \(current: StoryDecisionList \| undefined\) => applyStoryDecisionUpdate\(current, updated\)\)/);
});
