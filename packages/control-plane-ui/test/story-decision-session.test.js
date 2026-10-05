import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { storyDecisionSessionInstance } from "../src/apps/control-plane/story/storyDecisionSession.ts";

const root = new URL("../src/apps/control-plane/", import.meta.url);
const read = (relativePath) => fs.readFileSync(new URL(relativePath, root), "utf8");

test("a decision resolves the instance that hosts its AI Session from the loaded snapshots", () => {
  const instances = [
    { id: "instance-a", aiSessions: { sessions: [{ id: "session-1" }] } },
    { id: "instance-b", aiSessions: { sessions: [{ id: "session-2" }, { id: "session-3" }] } },
  ];
  assert.equal(storyDecisionSessionInstance(instances, { sessionId: "session-3" })?.id, "instance-b");
  assert.equal(storyDecisionSessionInstance(instances, { sessionId: "session-missing" }), undefined);
  assert.equal(storyDecisionSessionInstance([], { sessionId: "session-1" }), undefined);
});

test("Story decision rows open their source AI Session from the question itself", () => {
  const panel = read("story/StoryDecisionPanel.vue");
  assert.match(panel, /const props = defineProps<\{ story: Story; disabled\?: boolean; instances: InstanceWithAiSessions\[\] \}>\(\);/);
  assert.match(panel, /const emit = defineEmits<\{ "open-session": \[instanceId: string, sessionId: string\] \}>\(\);/);
  assert.match(panel, /:disabled="!sessionOpenable\(decision\)"/);
  assert.match(panel, /@click="openSession\(decision\)"/);
  assert.match(panel, /:title="t\(sessionOpenable\(decision\) \? 'stories\.decisions\.openSession' : 'stories\.decisions\.sessionUnavailable'\)"/);
  assert.match(panel, /function sessionOpenable\(decision: StoryDecision\) \{\s*const instance = storyDecisionSessionInstance\(props\.instances, decision\);\s*return Boolean\(instance && instance\.connectionStatus === "online"\);\s*\}/);
  assert.match(panel, /emit\("open-session", instance\.id, decision\.sessionId\);/);
  // The same affordance covers the folded history rows, so a decided decision still leads back to its Session.
  assert.equal((panel.match(/@click="openSession\(decision\)"/g) ?? []).length, 2);
});

test("the Story view feeds the decision panel its instances and routes the session open", () => {
  const view = read("story/StoryView.vue");
  assert.match(view, /<StoryDecisionPanel[^>]*:instances="storyInstances"[^>]*@open-session="\(instanceId, sessionId\) => openStorySessionById\(selectedResource\.story, instanceId, sessionId\)"/);
  assert.match(view, /import \{ storyDecisionSessionInstance \} from "\.\/storyDecisionSession";/);
});

test("Story decision cards in the approval center keep a small entry into the source AI Session", () => {
  const inbox = read("action-inbox/ActionInbox.vue");
  const workbench = read("ControlPlaneWorkbench.vue");
  assert.match(inbox, /"open-story-session": \[item: StoryDecisionItem\];/);
  assert.match(inbox, /class="action-inbox-open-session"[^>]*:aria-label="t\('stories\.decisions\.openSession'\)"[^>]*@click="emit\('open-story-session', item\)"/);
  assert.match(inbox, /<ExternalLink :size="12" \/>/);
  assert.match(inbox, /\.action-inbox-open-session \{ flex: 0 0 auto;/);
  assert.match(workbench, /@open-story-session="openActionInboxStoryDecisionSession"/);
  assert.match(workbench, /function openActionInboxStoryDecisionSession\(item: Extract<ActionInboxItem, \{ type: "story-decision" \}>\) \{/);
  assert.match(workbench, /storySelection\.value = \{ kind: "session", ownerNodeId: item\.story\.ownerNodeId, storyId: item\.story\.id, instanceId: instance\.id, sessionId: item\.decision\.sessionId \};/);
  assert.match(workbench, /nodeFilter\.value = toggleNodeVisibility\(nodeFilter\.value, item\.story\.ownerNodeId, true, nodeFilterOptions\.value\.map\(\(node\) => node\.id\)\);/);
  assert.match(workbench, /actionInboxError\.value = t\("stories\.decisions\.sessionUnavailable"\);/);
  assert.match(workbench, /setWorkbenchView\("story"\);/);
});

test("Story decision cards open the Story detail from the Story name", () => {
  const inbox = read("action-inbox/ActionInbox.vue");
  const workbench = read("ControlPlaneWorkbench.vue");
  assert.match(inbox, /"open-story": \[item: StoryDecisionItem\];/);
  assert.match(inbox, /class="action-inbox-source action-inbox-story-link"[^>]*:title="item\.story\.title"[^>]*@click="emit\('open-story', item\)"/);
  assert.match(workbench, /@open-story="openActionInboxStory"/);
  assert.match(workbench, /function openActionInboxStory\(item: Extract<ActionInboxItem, \{ type: "story-decision" \}>\) \{/);
  assert.match(workbench, /storySelection\.value = \{ kind: "story", ownerNodeId: item\.story\.ownerNodeId, storyId: item\.story\.id \};/);
  assert.match(workbench, /nodeFilter\.value = toggleNodeVisibility\(nodeFilter\.value, item\.story\.ownerNodeId, true, nodeFilterOptions\.value\.map\(\(node\) => node\.id\)\);/);
  assert.match(workbench, /setWorkbenchView\("story"\);/);
});
