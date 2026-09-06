<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="story-editor-dialog story-action-editor-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("stories.actionEditor.saveAsTitle") }}</DialogTitle>
        <DialogDescription>{{ t("stories.actionEditor.saveAsDescription") }}</DialogDescription>
      </DialogHeader>
      <div v-if="saving" class="story-preset-saving">{{ t("stories.actionEditor.saving") }}</div>
      <ScrollArea v-else class="story-preset-action-scroll" :horizontal="false">
        <div class="story-preset-action-fields">
          <label>
            {{ t("stories.actionEditor.story") }}
            <ControlPlaneSelect v-model="storyId" :placeholder="t('stories.actionEditor.selectStory')">
              <ControlPlaneSelectItem v-for="story in stories" :key="story.id" :value="story.id">{{ story.title }}</ControlPlaneSelectItem>
            </ControlPlaneSelect>
          </label>
          <StoryActionEditorContent
            ref="actionCreationPanel"
            v-model:mode="mode"
            v-model:target-instance-id="targetInstanceId"
            v-model:title="title"
            :initial-preset="initialSessionPreset"
            :initial-prompt="promptTemplate"
            :instances="instances"
            :node-local-folders-by-node-id="nodeLocalFoldersByNodeId"
            :revision="revision"
            :submitting="saving"
            @submit="save"
            @update:submit-ready="submitReady = $event"
          />
        </div>
      </ScrollArea>
      <div v-if="errorMessage" class="story-preset-error" role="alert">{{ errorMessage }}</div>
      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="$emit('update:open', false)">{{ t("common.actions.cancel") }}</Button>
        <Button :disabled="!storyId || !submitReady || saving" @click="submitCreation">{{ saving ? t("stories.actionEditor.saving") : t("common.actions.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { Story, StorySessionPreset } from "@task-handoff/protocol/stories";
import type { InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { createBrowserUuid } from "../../../lib/random-id";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import StoryActionEditorContent from "./StoryActionEditorContent.vue";
import type { AiSessionCreationPresetDraft } from "../instance-detail/AiSessionPanel.vue";

const props = withDefaults(defineProps<{
  open: boolean;
  stories: Story[];
  instances: InstanceWithAiSessions[];
  nodeLocalFoldersByNodeId?: Record<string, NodeLocalFolder[]>;
  initial?: {
    storyId?: string;
    title?: string;
    promptTemplate?: string;
    targetInstanceId?: string;
    sessionPreset?: StorySessionPreset;
  };
}>(), {
  nodeLocalFoldersByNodeId: () => ({}),
  initial: () => ({}),
});

const emit = defineEmits<{ "update:open": [value: boolean]; saved: [] }>();
const { t } = useI18n();

const storyId = ref("");
const title = ref("");
const promptTemplate = ref("");
const targetInstanceId = ref("");
const mode = ref<StorySessionPreset["mode"] | "">("");
const initialSessionPreset = ref<StorySessionPreset | undefined>(undefined);
const revision = ref(0);
const submitReady = ref(false);
const saving = ref(false);
const errorMessage = ref("");
const actionCreationPanel = ref<InstanceType<typeof StoryActionEditorContent>>();

watch(() => props.open, (open) => {
  if (!open) return;
  revision.value += 1;
  const initial = props.initial;
  storyId.value = initial.storyId || "";
  title.value = initial.title || "";
  promptTemplate.value = initial.promptTemplate || "";
  targetInstanceId.value = initial.targetInstanceId || props.instances[0]?.id || "";
  initialSessionPreset.value = initial.sessionPreset;
  mode.value = initial.sessionPreset?.mode || "";
  submitReady.value = false;
  errorMessage.value = "";
}, { immediate: true });

function submitCreation() {
  actionCreationPanel.value?.submitCreation();
}

async function save(draft: AiSessionCreationPresetDraft) {
  const story = props.stories.find((candidate) => candidate.id === storyId.value);
  if (!story || saving.value) return;
  const trimmedTitle = title.value.trim();
  const promptTemplate = draft.prompt.trim();
  const targetInstanceId = draft.instanceId;
  if (!trimmedTitle || !promptTemplate || !targetInstanceId) return;

  const sessionPreset: StorySessionPreset = {
    ...draft.sessionPreset,
    ...(mode.value ? { mode: mode.value } : {}),
  };
  const actions = [...story.actions];
  actions.push({
    id: createBrowserUuid(),
    title: trimmedTitle,
    promptTemplate,
    targetInstanceId,
    sessionPreset,
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

.story-preset-action-scroll {
  min-height: 0;
}

.story-preset-action-fields {
  display: grid;
  gap: 14px;
  padding-right: 8px;
}

.story-preset-action-fields label {
  display: grid;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
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
