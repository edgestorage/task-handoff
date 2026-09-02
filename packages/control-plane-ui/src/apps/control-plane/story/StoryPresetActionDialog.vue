<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="story-editor-dialog story-action-editor-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("stories.actionEditor.saveAsTitle") }}</DialogTitle>
        <DialogDescription>{{ t("stories.actionEditor.saveAsDescription") }}</DialogDescription>
      </DialogHeader>
      <div v-if="saving" class="story-preset-saving">{{ t("stories.actionEditor.saving") }}</div>
      <div v-else class="story-editor-fields">
        <label>
          {{ t("stories.actionEditor.story") }}
          <ControlPlaneSelect v-model="storyId" :placeholder="t('stories.actionEditor.selectStory')">
            <ControlPlaneSelectItem v-for="story in stories" :key="story.id" :value="story.id">{{ story.title }}</ControlPlaneSelectItem>
          </ControlPlaneSelect>
        </label>
        <label>{{ t("stories.actionEditor.title") }}<Input v-model="title" :placeholder="t('stories.actionEditor.titlePlaceholder')" /></label>
        <label>{{ t("stories.actionEditor.promptTemplate") }}<Textarea v-model="promptTemplate" :placeholder="t('stories.actionEditor.promptPlaceholder')" /></label>
        <label>
          {{ t("stories.actionEditor.targetInstance") }}
          <ControlPlaneSelect v-model="targetInstanceId" :placeholder="t('stories.actionEditor.selectTargetInstance')">
            <ControlPlaneSelectItem v-for="instance in instances" :key="instance.id" :value="instance.id">{{ instance.name }}</ControlPlaneSelectItem>
          </ControlPlaneSelect>
        </label>
        <div class="story-action-preset">
          <div class="story-action-preset-title">{{ t("stories.actionEditor.sessionPreset") }}</div>
          <div class="story-action-preset-grid">
            <label>{{ t("stories.actionEditor.agent") }}<ControlPlaneSelect v-model="agent" :placeholder="t('stories.actionEditor.defaultAgent')"><ControlPlaneSelectItem value="codex">{{ t("common.products.codex") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="claude">{{ t("common.products.claude") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="opencode">{{ t("common.products.opencode") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.messageMode") }}<ControlPlaneSelect v-model="mode" :placeholder="t('stories.actionEditor.defaultValue')"><ControlPlaneSelectItem value="auto">{{ t("stories.actionEditor.auto") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="queue">{{ t("stories.actionEditor.queue") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="steer">{{ t("stories.actionEditor.steer") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="immediate">{{ t("stories.actionEditor.immediate") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.permission") }}<ControlPlaneSelect v-model="permissionMode" :placeholder="t('stories.actionEditor.defaultPermission')"><ControlPlaneSelectItem value="ask">{{ t("stories.actionEditor.ask") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="auto-review">{{ t("stories.actionEditor.autoReview") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="full-access">{{ t("stories.actionEditor.fullAccess") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.reasoningEffort") }}<ControlPlaneSelect v-model="reasoningEffort" :placeholder="t('stories.actionEditor.defaultValue')"><ControlPlaneSelectItem v-for="effort in reasoningEfforts" :key="effort" :value="effort">{{ t(`stories.actionEditor.reasoning.${effort}`) }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.modelEntityId") }}<Input v-model="modelEntityId" :placeholder="t('stories.actionEditor.optionalModelId')" /></label>
            <label>{{ t("stories.actionEditor.modelName") }}<Input v-model="modelName" :placeholder="t('stories.actionEditor.optionalModelName')" /></label>
            <label>{{ t("stories.actionEditor.workingFolder") }}<ControlPlaneSelect v-model="cwdFolderId" :placeholder="t('stories.actionEditor.defaultValue')"><ControlPlaneSelectItem v-for="folder in cwdFolders" :key="folder.id" :value="folder.id">{{ folder.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.gitMode") }}<ControlPlaneSelect v-model="gitMode" :placeholder="t('stories.actionEditor.defaultValue')"><ControlPlaneSelectItem value="current-folder">{{ t("stories.actionEditor.currentFolder") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="worktree">{{ t("stories.actionEditor.worktree") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.gitBranch") }}<Input v-model="gitBranch" :placeholder="t('stories.actionEditor.optionalBranch')" /></label>
          </div>
        </div>
      </div>
      <div v-if="errorMessage" class="story-preset-error" role="alert">{{ errorMessage }}</div>
      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="$emit('update:open', false)">{{ t("common.actions.cancel") }}</Button>
        <Button :disabled="!storyId || !title.trim() || !promptTemplate.trim() || !targetInstanceId" @click="save">{{ saving ? t("stories.actionEditor.saving") : t("common.actions.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { Story, StorySessionPreset } from "@task-handoff/protocol/stories";
import type { NodeLocalFolder } from "../../../api/types";
import { createBrowserUuid } from "../../../lib/random-id";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import Input from "../../../components/ui/input/Input.vue";
import Textarea from "../../../components/ui/textarea/Textarea.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";

const props = withDefaults(defineProps<{
  open: boolean;
  stories: Story[];
  instances: Array<{ id: string; name: string }>;
  localFoldersByInstanceId?: Record<string, NodeLocalFolder[]>;
  initial?: {
    storyId?: string;
    title?: string;
    promptTemplate?: string;
    targetInstanceId?: string;
    sessionPreset?: StorySessionPreset;
  };
}>(), {
  localFoldersByInstanceId: () => ({}),
  initial: () => ({}),
});

const emit = defineEmits<{ "update:open": [value: boolean]; saved: [] }>();
const { t } = useI18n();

const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

const storyId = ref("");
const title = ref("");
const promptTemplate = ref("");
const targetInstanceId = ref("");
const agent = ref("");
const mode = ref("");
const permissionMode = ref("");
const reasoningEffort = ref("");
const modelEntityId = ref("");
const modelName = ref("");
const cwdFolderId = ref("");
const gitMode = ref("");
const gitBranch = ref("");
const saving = ref(false);
const errorMessage = ref("");

const cwdFolders = computed(() => props.localFoldersByInstanceId[targetInstanceId.value] || []);

watch(() => props.open, (open) => {
  if (!open) return;
  const initial = props.initial;
  storyId.value = initial.storyId || "";
  title.value = initial.title || "";
  promptTemplate.value = initial.promptTemplate || "";
  targetInstanceId.value = initial.targetInstanceId || props.instances[0]?.id || "";
  const preset = initial.sessionPreset || {};
  agent.value = preset.agent || "";
  mode.value = preset.mode || "";
  permissionMode.value = preset.permissionMode || "";
  reasoningEffort.value = preset.reasoningEffort || "";
  modelEntityId.value = preset.modelSelection?.modelEntityId || "";
  modelName.value = preset.modelSelection?.modelName || "";
  cwdFolderId.value = preset.cwdFolderId || "";
  gitMode.value = preset.gitSelection?.mode || "";
  gitBranch.value = preset.gitSelection?.branch || "";
  errorMessage.value = "";
}, { immediate: true });

async function save() {
  const story = props.stories.find((candidate) => candidate.id === storyId.value);
  if (!story || saving.value) return;
  if (!title.value.trim() || !promptTemplate.value.trim() || !targetInstanceId.value) return;

  const hasPreset = Boolean(agent.value || mode.value || permissionMode.value || reasoningEffort.value
    || (modelEntityId.value && modelName.value) || cwdFolderId.value || (gitMode.value && gitBranch.value));
  const sessionPreset = hasPreset ? {
    ...(agent.value ? { agent: agent.value } : {}),
    ...(mode.value ? { mode: mode.value } : {}),
    ...(permissionMode.value ? { permissionMode: permissionMode.value } : {}),
    ...(reasoningEffort.value ? { reasoningEffort: reasoningEffort.value } : {}),
    ...(modelEntityId.value && modelName.value ? { modelSelection: { modelEntityId: modelEntityId.value, modelName: modelName.value } } : {}),
    ...(cwdFolderId.value ? { cwdFolderId: cwdFolderId.value } : {}),
    ...(gitMode.value && gitBranch.value ? { gitSelection: { mode: gitMode.value, branch: gitBranch.value } } : {}),
  } as StorySessionPreset : undefined;

  const actions = [...story.actions];
  actions.push({
    id: createBrowserUuid(),
    title: title.value.trim(),
    promptTemplate: promptTemplate.value.trim(),
    targetInstanceId: targetInstanceId.value,
    parameters: [],
    ...(sessionPreset ? { sessionPreset } : {}),
  });

  saving.value = true;
  errorMessage.value = "";
  try {
    const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: story.ownerNodeId, input: { actions } }),
    });
    if (!response.ok) throw new Error((await response.json()).error?.message || t("stories.actionEditor.savePresetFailed"));
    emit("update:open", false);
    emit("saved");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.story-editor-dialog {
  max-width: 460px;
}

.story-action-editor-dialog {
  max-width: 640px;
}

.story-editor-fields {
  display: grid;
  gap: 14px;
}

.story-editor-fields label {
  display: grid;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
}

.story-action-preset {
  display: grid;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.story-action-preset-title {
  color: var(--text-muted);
  font-size: 12px;
}

.story-action-preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.story-preset-saving {
  padding: 16px 0;
  color: var(--text-muted);
  font-size: 13px;
}

.story-preset-error {
  color: var(--danger);
  font-size: 12px;
}
</style>
