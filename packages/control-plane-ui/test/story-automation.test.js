import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { timezoneOffsetLabel } from "../src/lib/timezones.ts";

const source = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryActionAutomations.vue", import.meta.url), "utf8");
const storyViewSource = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const actionEditorSource = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryActionEditorContent.vue", import.meta.url), "utf8");
const timezoneSource = fs.readFileSync(new URL("../src/lib/timezones.ts", import.meta.url), "utf8");
const timezonePickerSource = fs.readFileSync(new URL("../src/apps/control-plane/shared/ControlPlaneTimezonePicker.vue", import.meta.url), "utf8");
const timePickerSource = fs.readFileSync(new URL("../src/apps/control-plane/shared/ControlPlaneTimePicker.vue", import.meta.url), "utf8");
const schedulePresentationSource = fs.readFileSync(new URL("../src/apps/control-plane/story/storyAutomationPresentation.ts", import.meta.url), "utf8");
const commandListSource = fs.readFileSync(new URL("../src/components/ui/command/CommandList.vue", import.meta.url), "utf8");

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

test("Automation timezone uses the shared list and defaults to the browser timezone", () => {
  assert.match(source, /<ControlPlaneTimezonePicker v-model="timezone"/);
  assert.match(source, /:options="availableTimezoneOptions"/);
  assert.doesNotMatch(source, /<Input v-model="timezone"/);
  assert.match(source, /const timezone = ref\(currentTimezone\(\)\)/);
  assert.match(source, /timezone\.value = currentTimezone\(\)/);
  assert.match(timezoneSource, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone \|\| "UTC"/);
  assert.match(timezoneSource, /supportedValuesOf\?: \(key: "timeZone"\)/);
  assert.match(timezonePickerSource, /<CommandInput/);
  assert.match(timezonePickerSource, /<ScrollArea class="control-plane-timezone-scroll"/);
  assert.match(timezonePickerSource, /<CommandList class="control-plane-timezone-list" :scrollable="false">/);
  assert.match(timezonePickerSource, /--reka-popover-content-available-height/);
  assert.match(timezonePickerSource, /\.control-plane-timezone-list \[role="option"\]:hover/);
  assert.match(timezonePickerSource, /\.control-plane-timezone-list \[role="option"\]\[data-highlighted\]/);
  assert.match(timezonePickerSource, /class="control-plane-timezone-offset"/);
  assert.match(timezonePickerSource, /color:var\(--text-muted\)/);
  assert.match(commandListSource, /scrollable:\s*true/);
  assert.match(commandListSource, /props\.scrollable && 'max-h-\[300px\] overflow-y-auto overflow-x-hidden'/);
});

test("Timezone options show their current UTC offset", () => {
  const summer = new Date("2026-09-14T00:00:00.000Z");
  const winter = new Date("2026-01-14T00:00:00.000Z");

  assert.equal(timezoneOffsetLabel("Asia/Shanghai", summer), "UTC+8");
  assert.equal(timezoneOffsetLabel("Asia/Kathmandu", summer), "UTC+5:45");
  assert.equal(timezoneOffsetLabel("UTC", summer), "UTC+0");
  assert.equal(timezoneOffsetLabel("America/New_York", summer), "UTC-4");
  assert.equal(timezoneOffsetLabel("America/New_York", winter), "UTC-5");
  assert.equal(timezoneOffsetLabel("Invalid/Timezone", summer), undefined);
});

test("Automation schedule editor presents semantic controls while preserving the wire model", () => {
  assert.match(source, /<ToggleGroup type="single"[^>]+story-automation-schedule-kinds/);
  assert.match(source, /<ToggleGroup type="multiple"[^>]+:model-value="weekdays"/);
  assert.match(source, /v-for="option in dayOfMonthOptions"/);
  assert.doesNotMatch(source, /v-model\.number="dayOfMonth"/);
  assert.match(source, /intervalMs: normalizedValue \* intervalUnitMs\[intervalUnit\.value\]/);
  assert.match(source, /setIntervalFromMilliseconds\(schedule\.intervalMs\)/);
  assert.match(schedulePresentationSource, /dayOfMonth === -1/);
  assert.match(schedulePresentationSource, /stories\.automation\.lastDay/);
  assert.match(source, /storyAutomationDayOfMonthLabel\(schedule\.dayOfMonth, t\)/);
  assert.match(storyViewSource, /storyAutomationDayOfMonthLabel\(schedule\.dayOfMonth, t\)/);
});

test("Automation schedule controls use the compact settings scale", () => {
  assert.match(source, /\.story-automation-schedule-kinds \{[^}]*display:inline-flex;[^}]*width:fit-content;[^}]*height:32px;/);
  assert.match(source, /\.story-automation-schedule-kinds :deep\(button\) \{[^}]*height:26px;[^}]*font-size:12px;/);
  assert.match(source, /\.story-automation-weekdays :deep\(button\) \{[^}]*height:32px; min-height:32px;/);
  assert.match(source, /\.story-automation-schedule-sentence \{[^}]*color:inherit; font-size:inherit;/);
  assert.match(source, /\.story-automation-interval-sentence \{[^}]*color:var\(--text-muted\); font-size:12px;/);
  assert.match(source, /\.story-automation-schedule-sentence :deep\(input\)[^}]*height:32px; min-height:32px;/);
  assert.match(source, /class="story-automation-timing-row"[^>]*story-automation-monthly-timing-row/);
  assert.match(source, /\.story-automation-timing-row \{[^}]*display:flex;[^}]*color:var\(--text-muted\);[^}]*font-size:12px;/);
  assert.match(source, /\.story-automation-weekdays :deep\(button\[data-state="on"\]\) \{[^}]*background:hsl\(var\(--accent\)\);[^}]*color:hsl\(var\(--accent-foreground\)\)/);
});

test("Shared time picker accepts compact input and uses a constrained portal popover", () => {
  assert.match(timePickerSource, /digits\.length === 3 \|\| digits\.length === 4/);
  assert.match(timePickerSource, /@keydown\.up\.prevent="stepTime\(1\)"/);
  assert.match(timePickerSource, /<PopoverContent class="control-plane-time-picker-popover/);
  assert.match(timePickerSource, /<ScrollArea class="control-plane-time-picker-scroll"/);
  assert.match(timePickerSource, /--reka-popover-content-available-height/);
  assert.match(timePickerSource, /\.control-plane-time-picker:focus-within \{ box-shadow:0 0 0 1px hsl\(var\(--ring\)\); \}/);
  assert.doesNotMatch(timePickerSource, /border-color:var\(--ring\)/);
  assert.doesNotMatch(timePickerSource, /control-plane-time-picker:focus-within[^}]*border-color/);
  assert.match(timePickerSource, /open\.value = false/);
});
