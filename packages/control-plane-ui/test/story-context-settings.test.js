import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { controlPlaneDomainQueryKeys } from "../src/api/queryInvalidation.ts";
import { controlPlaneQueryKeys } from "../src/api/queryKeys.ts";
import { controlPlaneEventDomains } from "../src/apps/control-plane/eventInvalidation.ts";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const storiesApi = fs.readFileSync(new URL("../../control-plane-client/src/stories.ts", import.meta.url), "utf8");

test("Story context settings load only after advanced editing is open", () => {
  assert.match(storyView, /enabled: computed\(\(\) => Boolean\(editorOpen\.value[\s\S]*?editorAdvancedOpen\.value[\s\S]*?editing\.value[\s\S]*?storyContextStoryId\.value[\s\S]*?storyContextVisible\.value\)\)/);
  assert.match(storyView, /queryFn: \(\) => sharedControlPlaneClient\.stories\.contextSettings\(storyContextStoryId\.value, draftNodeId\.value\)/);
  assert.match(storyView, /if \(!storyContextSettingsQuery\.isEnabled\.value\) return;/);
});

test("Story context controls follow the normalized node capability", () => {
  assert.match(storyView, /function storyContextStateForNode\(ownerNode: Node \| undefined, readyState: "ready" \| "loading"\): StorySettingsState/);
  assert.match(storyView, /if \(!capabilities\.settings \|\| \(!capabilities\.projects && !capabilities\.sessionPrompting\)\) return "hidden"/);
  assert.match(storyView, /<fieldset v-if="storyContextVisible"/);
  assert.match(storyView, /draftStoryContextProjectsSupported/);
  assert.match(storyView, /draftStoryContextPromptSupported/);
});

test("Story context refetches settle back to ready even when cached data is structurally unchanged", () => {
  const dataWatch = storyView.slice(
    storyView.indexOf("watch([() => storyContextSettingsQuery.isEnabled.value, () => storyContextSettingsQuery.data.value]"),
    storyView.indexOf("watch(() => storyContextSettingsQuery.isFetching.value"),
  );
  assert.match(dataWatch, /if \(!enabled \|\| !settings\) return;/);
  assert.match(dataWatch, /applyStoryContextSettings\(settings\);/);
  assert.match(dataWatch, /flush: "sync", immediate: true/);
  const fetchingWatch = storyView.slice(
    storyView.indexOf("watch(() => storyContextSettingsQuery.isFetching.value"),
    storyView.indexOf("watch(() => storyContextSettingsQuery.error.value"),
  );
  assert.match(fetchingWatch, /if \(!storyContextSettingsQuery\.isEnabled\.value\) return;/);
  assert.match(fetchingWatch, /if \(fetching\) \{/);
  assert.match(fetchingWatch, /const settings = storyContextSettingsQuery\.data\.value;/);
  assert.match(fetchingWatch, /applyStoryContextSettings\(settings\);/);
});

test("Story context drafts preserve order and unavailable folder ids", () => {
  assert.match(storyView, /draftProjectFolderIds\.value = \[\.\.\.draftProjectFolderIds\.value, folderId\]/);
  assert.match(storyView, /\[next\[index\], next\[target\]\] = \[next\[target\], next\[index\]\]/);
  assert.match(storyView, /draftProjectFolderIds\.value\.filter\(\(id\) => id !== folderId\)/);
  assert.match(storyView, /storyContextFolder\(folderId\)\?\.name \|\| t\("stories\.editor\.storyContextProjectUnavailable"\)/);
  assert.match(storyView, /storyContextFolder\(folderId\)\?\.path \|\| folderId/);
});

test("Story context saves after Story fields and before Agent tools and entry Agents", () => {
  const save = storyView.slice(storyView.indexOf("async function saveStory()"), storyView.indexOf("async function adoptCreatedStory"));
  const contextIndex = save.indexOf("updateContextSettings");
  const agentToolsIndex = save.indexOf("updateAgentToolSettings");
  const entryAgentsIndex = save.indexOf("updateStoryEntries");
  assert.ok(contextIndex > save.indexOf("stories.update") || contextIndex > save.indexOf("stories.create"));
  assert.ok(contextIndex < agentToolsIndex);
  assert.ok(agentToolsIndex < entryAgentsIndex);
  assert.match(save, /projectFolderIds: \[\.\.\.draftProjectFolderIds\.value\]/);
  assert.match(save, /appendedPrompt: draftStoryContextPrompt\.value/);
});

test("new Stories read the default context revision before the first write", () => {
  assert.match(storyView, /const expectedRevision = storyContextRevisionLoaded\.value\s*\? storyContextRevision\.value\s*: \(await sharedControlPlaneClient\.stories\.contextSettings\(story\.id, story\.ownerNodeId\)\)\.revision/);
  assert.match(storyView, /expectedRevision,\s*projectFolderIds: \[\.\.\.draftProjectFolderIds\.value\],\s*appendedPrompt: draftStoryContextPrompt\.value/);
  assert.match(storyView, /applyStoryContextSettings\(settings\);\s*queryClient\.setQueryData\(controlPlaneQueryKeys\.storyContextSettings\(story\.ownerNodeId, story\.id\), settings\)/);
});

test("context conflicts keep the editor and draft open for retry", () => {
  assert.match(storyView, /storyContextError\.value = translateApiError\(error, t, t\("stories\.editor\.storyContextUnavailable"\)\)/);
  assert.match(storyView, /if \(!createdStory\) \{\s*storyEditorError\.value = translateApiError\(cause, t, t\("stories\.errors\.saveFailed"\)\);/);
  assert.match(storyView, /const adopted = await adoptCreatedStory\(createdStory\);\s*if \(adopted\) storyEditorError\.value = t\("stories\.errors\.settingsApplyFailed"\)/);
});

test("clearing the prompt sends an empty authoritative value", () => {
  assert.doesNotMatch(storyView, /appendedPrompt: draftStoryContextPrompt\.value \|\|/);
  assert.match(storyView, /v-model="draftStoryContextPrompt"/);
});

test("the shared client sanitizes Story context settings and updates with a strict model", () => {
  assert.match(storiesApi, /StoryContextSettingsSchema\.parse\(sanitizeStoryContextSettings\(data\)\)/);
  assert.match(storiesApi, /StoryContextSettingsUpdateInputSchema\.parse\(input\)/);
  assert.match(storiesApi, /settings\/context\?nodeId=\$\{encodeURIComponent\(nodeId\)\}/);
});

test("the Story list wire model does not carry context settings", () => {
  assert.doesNotMatch(storiesApi, /StoryContextSettingsSchema[\s\S]{0,160}StoryListSchema/);
  assert.doesNotMatch(storyView, /contextSettings[\s\S]{0,160}story\.contextSettings/);
});

test("Story changed events invalidate context settings through the stories query prefix", () => {
  assert.deepEqual(controlPlaneEventDomains([{ type: "story.changed", topic: "stories" }]), ["stories"]);
  assert.deepEqual(controlPlaneDomainQueryKeys(["stories"]), [controlPlaneQueryKeys.stories()]);
  const contextKey = controlPlaneQueryKeys.storyContextSettings("node_one", "story_one");
  assert.deepEqual(contextKey.slice(0, controlPlaneQueryKeys.stories().length), controlPlaneQueryKeys.stories());
});
