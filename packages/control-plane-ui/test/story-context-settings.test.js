import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { STORY_CONTEXT_MAX_PROJECTS } from "@task-handoff/protocol/story-context";
import { filterProjects, moveLinkedProject, projectChoices, setProjectLinked } from "../src/apps/control-plane/story/storyProjectSelection.ts";
import { controlPlaneDomainQueryKeys } from "../src/api/queryInvalidation.ts";
import { controlPlaneQueryKeys } from "../src/api/queryKeys.ts";
import { controlPlaneEventDomains } from "../src/apps/control-plane/eventInvalidation.ts";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const storiesApi = fs.readFileSync(new URL("../../control-plane-client/src/stories.ts", import.meta.url), "utf8");

test("Story context settings load when the editor opens for related projects", () => {
  assert.match(storyView, /enabled: computed\(\(\) => Boolean\(editorOpen\.value\s*&& editing\.value\s*&& storyContextStoryId\.value\s*&& storyContextVisible\.value\)\)/);
  const query = storyView.slice(storyView.indexOf("const storyContextSettingsQuery"), storyView.indexOf("const storyAgentEntryCandidates"));
  assert.doesNotMatch(query, /editorAdvancedOpen/);
  assert.match(storyView, /queryFn: \(\) => sharedControlPlaneClient\.stories\.contextSettings\(storyContextStoryId\.value, draftNodeId\.value\)/);
  assert.match(storyView, /if \(!storyContextSettingsQuery\.isEnabled\.value\) return;/);
});

test("related projects render outside advanced settings while the prompt stays inside", () => {
  const advancedStart = storyView.indexOf('<CollapsibleContent class="story-advanced-motion">');
  const description = storyView.indexOf('{{ t("stories.editor.descriptionLabel") }}');
  const projects = storyView.indexOf('class="story-agent-tool-settings story-context-settings story-context-projects"');
  const prompt = storyView.indexOf('class="story-agent-tool-settings story-context-settings story-context-prompt-settings"');
  assert.ok(advancedStart > 0);
  assert.ok(description > 0 && description < advancedStart);
  assert.ok(projects > 0 && projects < advancedStart);
  assert.ok(prompt > advancedStart);
  const zhStories = fs.readFileSync(new URL("../src/i18n/locales/zh-CN/stories.ts", import.meta.url), "utf8");
  const enStories = fs.readFileSync(new URL("../src/i18n/locales/en-US/stories.ts", import.meta.url), "utf8");
  assert.match(zhStories, /storyContextProjects: "相关项目"/);
  assert.match(enStories, /storyContextProjects: "Related projects"/);
  assert.doesNotMatch(storyView, /storyContextProjectsNote|storyContextOrder|storyContextProjectsEmpty/);
  assert.doesNotMatch(zhStories, /storyContextProjectsNote|storyContextOrder|storyContextProjectsEmpty/);
  assert.doesNotMatch(enStories, /storyContextProjectsNote|storyContextOrder|storyContextProjectsEmpty/);
});

test("Story editor settings use flat sections instead of nested borders", () => {
  assert.match(storyView, /\.story-editor-advanced-toggle \{[^}]*border:0;/);
  assert.match(storyView, /\.story-agent-tool-settings \{[^}]*border:0;/);
  assert.match(storyView, /\.story-agent-tool-settings legend \{[^}]*color:var\(--text-muted\);/);
});

test("Story context controls follow the normalized node capability", () => {
  assert.match(storyView, /function storyContextStateForNode\(ownerNode: Node \| undefined, readyState: "ready" \| "loading"\): StorySettingsState/);
  assert.match(storyView, /if \(!capabilities\.settings \|\| \(!capabilities\.projects && !capabilities\.sessionPrompting\)\) return "hidden"/);
  assert.match(storyView, /<fieldset v-if="storyContextVisible && draftStoryContextProjectsSupported"/);
  assert.match(storyView, /<fieldset v-if="storyContextVisible && draftStoryContextPromptSupported &&/);
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
  const saved = ['missing', 'mobile'];
  const folders = [{ id: 'mobile', name: 'Client', path: '/apps/ios' }, { id: 'web', name: 'Client', path: '/apps/web' }];
  const choices = projectChoices(folders, saved, 'Unavailable');
  assert.deepEqual(choices.linked, [{ id: 'missing', name: 'Unavailable', path: 'missing' }, folders[0]]);
  assert.deepEqual(filterProjects(choices.all, ' client '), folders);
  assert.deepEqual(filterProjects(choices.all, 'WEB'), [folders[1]]);
  assert.deepEqual(filterProjects(choices.linked, 'web'), []);
  const draft = setProjectLinked(saved, 'web', true);
  assert.deepEqual(setProjectLinked(draft, 'web', true), draft);
  assert.deepEqual(moveLinkedProject(draft, 'web', -1), ['missing', 'web', 'mobile']);
  assert.deepEqual(setProjectLinked(draft, 'missing', false), ['mobile', 'web']);
  assert.deepEqual(saved, ['missing', 'mobile']);
});

test('the link limit blocks additions but allows removal and replacement', () => {
  const full = Array.from({ length: STORY_CONTEXT_MAX_PROJECTS }, (_, index) => String(index));
  assert.deepEqual(setProjectLinked(full, 'extra', true), full);
  const replaced = setProjectLinked(setProjectLinked(full, '0', false), 'extra', true);
  assert.deepEqual(replaced, [...full.slice(1), 'extra']);
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
