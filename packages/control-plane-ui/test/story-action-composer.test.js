import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const actionEditor = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryActionEditorContent.vue", import.meta.url), "utf8");
const presetActionDialog = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryPresetActionDialog.vue", import.meta.url), "utf8");
const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");

test("Story preset actions reuse the complete new-session creation panel", () => {
  assert.match(actionEditor, /<AiSessionPanel[\s\S]*?creation-embedded[\s\S]*?creation-mode="preset"[\s\S]*?creation-only/);
  assert.match(actionEditor, /:creation-instances="instances"[\s\S]*?:launchable-apps="launchableAppsForInstance\(selectedInstance, t\)"/);
  assert.match(actionEditor, /@creation-preset-submit="emit\('submit', \$event\)"[\s\S]*?@update:creation-instance="emit\('update:targetInstanceId', \$event\)"/);
  assert.match(actionEditor, /@update:creation-submit-ready="emit\('update:submitReady', \$event\)"/);
  assert.match(storyView, /<DialogFooter>[\s\S]*?common\.actions\.cancel[\s\S]*?<Button :disabled="!actionCreationSubmitReady \|\| actionSaving" @click="submitActionCreation"/);
  assert.doesNotMatch(storyView, /actionDraftModelGroups|actionDraftPermissionMode|actionDraftGitBranch/);
  assert.match(panel, /props\.creationMode === "preset"[\s\S]*?emit\("creationPresetSubmit", \{/);
  assert.match(panel, /:submit-hidden="creationMode === 'preset'"/);
  assert.match(panel, /defineExpose\(\{ submitCreation \}\)/);
  assert.match(storyView, /const sessionPreset: StorySessionPreset = \{\s*\.\.\.draft\.sessionPreset,[\s\S]*?mode: actionDraftMode\.value/);
});

test("save as preset action reuses the shared Story action editor", () => {
  assert.match(presetActionDialog, /<StoryActionEditorContent[\s\S]*?v-model:mode="mode"[\s\S]*?v-model:target-instance-id="targetInstanceId"[\s\S]*?v-model:title="title"/);
  assert.match(presetActionDialog, /:instances="instances"[\s\S]*?:node-local-folders-by-node-id="nodeLocalFoldersByNodeId"/);
  assert.match(presetActionDialog, /@submit="save"[\s\S]*?@update:submit-ready="submitReady = \$event"/);
  assert.doesNotMatch(presetActionDialog, /story-action-preset-grid|Textarea v-model="promptTemplate"/);
  assert.match(panel, /:node-local-folders-by-node-id="presetSaveFoldersByNodeId"/);
});

test("preset composer mode keeps unsupported attachments out of Story actions", () => {
  assert.match(panel, /:attachments-disabled="creationMode === 'preset'"/);
  assert.match(composer, /function handlePaste\(event: ClipboardEvent\) \{\s*if \(editing\.value \|\| props\.attachmentsDisabled\) return;/);
  assert.match(composer, /function handleDrop\(event: DragEvent\) \{\s*if \(props\.attachmentsDisabled\)/);
  assert.match(composer, /v-if="!submitHidden"\s*type="submit"/);
});

test("preset mode does not mutate session defaults or persisted new-session drafts", () => {
  assert.match(panel, /if \(props\.creationMode === "preset"\) \{\s*newSessionPermissionMode\.value = permissionMode;\s*return;\s*\}/);
  assert.match(panel, /watch\(\(\) => props\.instance\.id, \(instanceId\) => \{\s*if \(props\.creationMode === "preset"\) return;/);
  assert.match(panel, /watch\(\[newSessionDraft, newSessionMentionBindings\],[\s\S]*?if \(props\.creationMode === "preset"\) return;[\s\S]*?persistAiSessionDraftPayload/);
  const presetBranch = panel.indexOf('if (props.creationMode === "preset") {', panel.indexOf("async function createNewSession"));
  assert.ok(presetBranch > 0);
  assert.ok(presetBranch < panel.indexOf("const references = referencesForBindings", presetBranch));
  assert.match(panel, /props\.creationMode === "preset" && props\.instance\.id === initialCreationInstanceId && current/);
  assert.match(panel, /props\.creationMode === "preset" && props\.instance\.id === initialCreationInstanceId && newSessionApp\.value === props\.creationInitialPreset\?\.agent/);
});

test("preset Git options keep the current branch immutable and select branches only for worktrees", () => {
  assert.match(panel, /creationMode === "preset" \? "sessions\.panel\.currentBranchMode" : "sessions\.panel\.currentFolderMode"/);
  assert.match(panel, /newSessionWorkspace\.branches\.length && \(creationMode !== 'preset' \|\| newSessionWorkspaceMode === 'worktree'\)/);
  assert.match(panel, /props\.creationMode !== "preset" \|\| newSessionWorkspaceMode\.value === "worktree"/);
});
