<template>
  <div class="story-editor-fields story-action-editor-fields">
    <label>{{ t("stories.actionEditor.title") }}<Input :model-value="title" :placeholder="t('stories.actionEditor.titlePlaceholder')" @update:model-value="emit('update:title', String($event))" /></label>
    <label>{{ t("stories.actionEditor.messageMode") }}<ControlPlaneSelect :model-value="mode" :placeholder="t('stories.actionEditor.defaultValue')" @update:model-value="emit('update:mode', $event as StorySessionPreset['mode'])"><ControlPlaneSelectItem value="auto">{{ t("stories.actionEditor.auto") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="queue">{{ t("stories.actionEditor.queue") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="steer">{{ t("stories.actionEditor.steer") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="immediate">{{ t("stories.actionEditor.immediate") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
    <AiSessionPanel
      v-if="selectedInstance"
      :key="revision"
      ref="creationPanel"
      class="story-action-creation-panel"
      :active-session="creationActiveSession"
      creation-embedded
      :creation-initial-cwd-folder-id="initialPreset?.cwdFolderId"
      :creation-initial-preset="initialPreset"
      :creation-initial-prompt="initialPrompt"
      :creation-instances="instances"
      creation-mode="preset"
      creation-only
      :creation-submit-disabled="!title.trim()"
      :creation-submitting="submitting"
      :instance="selectedInstance"
      :launchable-apps="launchableAppsForInstance(selectedInstance, t)"
      :node-local-folders="nodeLocalFoldersByNodeId[selectedInstance.nodeId] || []"
      :selected-ai-session="noSelectedAiSession"
      @creation-preset-submit="emit('submit', $event)"
      @update:creation-instance="emit('update:targetInstanceId', $event)"
      @update:creation-submit-ready="emit('update:submitReady', $event)"
    />
    <div v-else class="story-action-editor-empty">{{ t("stories.noAvailableInstance") }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { StorySessionPreset } from "@task-handoff/protocol/stories";
import type { AiSessionSummary, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import Input from "../../../components/ui/input/Input.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import AiSessionPanel, { type AiSessionCreationPresetDraft } from "../instance-detail/AiSessionPanel.vue";
import { launchableAppsForInstance, type SessionTab } from "../useInstanceSessions";

const props = defineProps<{
  initialPreset?: StorySessionPreset;
  initialPrompt?: string;
  instances: InstanceWithAiSessions[];
  mode: StorySessionPreset["mode"] | "";
  nodeLocalFoldersByNodeId: Record<string, NodeLocalFolder[]>;
  revision: number;
  submitting?: boolean;
  targetInstanceId: string;
  title: string;
}>();
const emit = defineEmits<{
  submit: [draft: AiSessionCreationPresetDraft];
  "update:mode": [mode: StorySessionPreset["mode"] | ""];
  "update:submitReady": [ready: boolean];
  "update:targetInstanceId": [instanceId: string];
  "update:title": [title: string];
}>();
const { t } = useI18n();
const creationPanel = ref<InstanceType<typeof AiSessionPanel>>();
const selectedInstance = computed(() => props.instances.find((instance) => instance.id === props.targetInstanceId));
const creationActiveSession = computed<SessionTab>(() => ({ key: "ai", label: t("navigation.ai"), status: "running", kind: "ai", aiSessions: selectedInstance.value?.aiSessions.sessions || [] }));
const noSelectedAiSession = () => undefined as AiSessionSummary | undefined;

function submitCreation() {
  creationPanel.value?.submitCreation();
}

defineExpose({ submitCreation });
</script>

<style scoped>
.story-action-editor-fields { display:grid; gap:14px; padding-right:8px; }
.story-action-editor-fields label { display:grid; gap:6px; color:var(--text-muted); font-size:12px; }
.story-action-creation-panel { width:100%; }
.story-action-editor-empty { color:var(--text-muted); font-size:12px; padding:16px; text-align:center; }
</style>
