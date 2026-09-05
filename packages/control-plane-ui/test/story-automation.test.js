import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryActionAutomations.vue", import.meta.url), "utf8");
const storyViewSource = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const actionEditorSource = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryActionEditorContent.vue", import.meta.url), "utf8");

test("Story Action automation UI uses authoritative API state without parameter values", () => {
  assert.match(source, /listAutomations/);
  assert.match(source, /entry\.effectiveStatus/);
  assert.match(source, /entry\.blockedReason/);
  assert.match(source, /entry\.lastRun\?\.error/);
  assert.match(source, /controlPlaneQueryKeys\.stories/);
  assert.doesNotMatch(source, /parameterValues|\{\{parameter\}\}/);
});

test("Story details use four scroll anchors and one authoritative automation list", () => {
  for (const section of ["actions", "documents", "sessions", "automations"]) {
    assert.match(storyViewSource, new RegExp(`<TabsTrigger value="${section}">`));
  }
  assert.equal(storyViewSource.match(/<StoryActionAutomations/g)?.length, 1);
  assert.ok(storyViewSource.indexOf("<StoryActionAutomations") > storyViewSource.indexOf('ref="storySessionsSectionEl"'));
  assert.match(storyViewSource, /<PopoverContent class="story-action-automation-popover p-0"/);
  assert.match(storyViewSource, /<ScrollArea v-if="actionAutomations\(action\.id\)\.length" class="story-action-automation-popover-scroll"/);
  assert.match(storyViewSource, /story-action-automation-popover-list/);
  assert.match(storyViewSource, /story-action-automation-popover\) \{[^}]*overflow:hidden; padding:0/);
  assert.match(storyViewSource, /actionAutomations\(action\.id\)\.length/);
  assert.match(storyViewSource, /scrollToAutomation\(entry\.automation\.id\)/);
  assert.doesNotMatch(source, /"automations", props\.action\.id/);
  assert.doesNotMatch(source, /statuses\.filter\(.*actionId/);
});

test("Automation updates do not resend immutable Story and Action ownership", () => {
  assert.match(source, /updateAutomation\([^\n]+, config\)/);
  assert.match(source, /createAutomation\([^\n]+\{ storyId: props\.story\.id, actionId: action\.id, \.\.\.config \}/);
});

test("Automation run history uses the shared popover and scroll area", () => {
  assert.match(source, /<Popover>[\s\S]*<PopoverTrigger as-child>[\s\S]*story-automation-history-trigger/);
  assert.match(source, /<PopoverContent class="story-automation-history-popover p-0"[^>]*:collision-padding="12"/);
  assert.match(source, /<ScrollArea v-if="entry\.recentRuns\.length" class="story-automation-history-scroll"/);
  assert.match(source, /v-for="runEntry in entry\.recentRuns"/);
  assert.match(source, /:disabled="!automationSessionExists\(runEntry\)"/);
  assert.match(source, /instance\.aiSessions\.sessions\.some\(\(session\) => session\.id === run\.aiSessionId\)/);
  assert.match(source, /stories\.automation\.openRunSession/);
  assert.doesNotMatch(source, /story-automation-session/);
  assert.match(source, /--reka-popover-content-available-(?:width|height)/);
  assert.doesNotMatch(source, /class="story-automation-run"/);
  assert.doesNotMatch(source, /\.runs\.slice\(0, 3\)/);
});

test("Automation creation can reuse an existing Action or create one with the shared editor", () => {
  const dialogHeaderStart = source.indexOf('<DialogHeader class="story-automation-dialog-header');
  const dialogHeader = source.slice(dialogHeaderStart, source.indexOf('</DialogHeader>', dialogHeaderStart));
  assert.match(source, /v-model="selectedActionId"/);
  assert.match(source, /<ControlPlaneTimePicker[^>]+v-model="timeOfDay"/);
  assert.doesNotMatch(source, /type="time"/);
  assert.match(dialogHeader, /<TabsTrigger value="existing"/);
  assert.match(dialogHeader, /<TabsTrigger value="new"/);
  assert.match(dialogHeader, /class="story-automation-dialog-header space-y-0"/);
  assert.match(dialogHeader, /story-automation-dialog-heading[\s\S]*<DialogTitle[\s\S]*<DialogDescription/);
  assert.match(source, /story-automation-dialog-header-create \{[^}]*grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/);
  assert.match(source, /story-automation-dialog-heading \{ display:grid;[^}]*text-align:left/);
  assert.match(source, /story-automation-dialog-header-create \.story-automation-dialog-heading \{ grid-column:1; grid-row:1; align-self:center/);
  assert.doesNotMatch(source, /(?<!header-create )\.story-automation-dialog-heading \{[^}]*align-self:center/);
  assert.match(source, /story-automation-action-mode \{ grid-column:2; grid-row:1;[^}]*align-self:center; justify-self:center/);
  assert.match(source, /story-automation-dialog-header\.story-automation-dialog-header-create > :not\(\[hidden\]\) ~ :not\(\[hidden\]\) \{ margin-top:0; margin-bottom:0/);
  assert.match(source, /story-automation-action-mode \{ grid-column:1; grid-row:2;[^}]*justify-content:center; justify-self:center/);
  assert.match(source, /story-automation-dialog\) \{ max-width:480px/);
  assert.match(source, /story-automation-dialog\.story-automation-dialog-with-action\) \{ max-width:840px/);
  assert.doesNotMatch(source, /story-automation-dialog-create/);
  assert.equal(source.match(/<StoryActionEditorContent/g)?.length, 1);
  assert.equal(storyViewSource.match(/<StoryActionEditorContent/g)?.length, 1);
  assert.match(actionEditorSource, /<AiSessionPanel/);
  assert.match(actionEditorSource, /creation-mode="preset"/);
  assert.match(actionEditorSource, /launchableAppsForInstance/);
  assert.match(actionEditorSource, /creation-initial-preset/);
  assert.doesNotMatch(source, /newActionPrompt|story-automation-inline-action|@create-action|<Textarea/);
  assert.match(storyViewSource, /createAutomationWithAction/);
  assert.match(source, /await props\.createWithAction/);
  assert.ok(source.indexOf("await props.createWithAction") < source.indexOf("editorOpen.value = false", source.indexOf("async function saveWithNewAction")));
  assert.match(storyViewSource, /sharedControlPlaneClient\.stories\.createAutomationWithAction\(story\.id/);
  assert.equal(actionEditorSource.match(/<AiSessionPanel/g)?.length, 1);
});
