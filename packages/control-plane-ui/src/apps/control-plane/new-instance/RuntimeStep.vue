<template>
  <section class="wizard-section">
    <div class="section-head">
      <span>Runtime</span>
      <button v-if="selectedRuntimeRequiresImage" type="button" @click="$emit('update:newImageOpen', !newImageOpen)">{{ newImageOpen ? "Use existing" : "Add image" }}</button>
    </div>

    <div class="runtime-summary">
      <span>Source</span>
      <strong>{{ sourceSummary }}</strong>
      <span v-if="selectedRuntime && !selectedRuntimeRequiresImage">Runtime</span>
      <strong v-if="selectedRuntime && !selectedRuntimeRequiresImage">{{ selectedRuntime.name }} · no container</strong>
    </div>

    <div class="step-fields runtime-fields">
      <label>
        <span>Node</span>
        <ControlPlaneSelect v-model="runtimeDraft.nodeId" placeholder="Select node">
          <ControlPlaneSelectItem v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
      <label>
        <span>Runtime</span>
        <ControlPlaneSelect v-model="runtimeDraft.runtimeId" placeholder="Select runtime">
          <ControlPlaneSelectItem v-for="runtime in runtimesForSelectedNode" :key="runtime.id" :value="runtime.id">{{ runtime.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
      <label v-if="selectedRuntimeRequiresImage && !newImageOpen">
        <span>Image</span>
        <ControlPlaneSelect v-model="runtimeDraft.imageId" placeholder="Select image">
          <ControlPlaneSelectItem v-for="image in images" :key="image.id" :value="image.id">{{ image.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
    </div>

    <div v-if="selectedRuntimeRequiresImage && newImageOpen" class="step-fields inline-create">
      <label>
        <span>Name</span>
        <ControlPlaneInput v-model="newImage.name" placeholder="Image name" />
      </label>
      <label>
        <span>Image ref</span>
        <ControlPlaneInput v-model="newImage.image" placeholder="task-handoff-web:latest" />
      </label>
      <Button variant="outline" size="sm" :disabled="!canCreateImage || creatingImage" @click="$emit('create-image')">
        <Plus :size="15" />
        <span>{{ creatingImage ? "Creating" : "Create image" }}</span>
      </Button>
    </div>

    <label class="instance-name-field">
      <span>Name</span>
      <ControlPlaneInput v-model="instanceDraft.name" placeholder="Optional instance name" />
    </label>

    <div v-if="codexModels.length || claudeModels.length" class="step-fields instance-model-fields">
      <label v-if="codexModels.length">
        <span>Codex model</span>
        <ControlPlaneSelect v-model="instanceCodexModelValue" placeholder="Global default">
          <ControlPlaneSelectItem :value="defaultModelValue">Global default</ControlPlaneSelectItem>
          <ControlPlaneSelectItem :value="noModelValue">No model</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="model in codexModels" :key="`instance-codex-${model.id}`" :value="model.id">{{ modelOptionLabel(model) }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
      <label v-if="claudeModels.length">
        <span>Claude model</span>
        <ControlPlaneSelect v-model="instanceClaudeModelValue" placeholder="Global default">
          <ControlPlaneSelectItem :value="defaultModelValue">Global default</ControlPlaneSelectItem>
          <ControlPlaneSelectItem :value="noModelValue">No model</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="model in claudeModels" :key="`instance-claude-${model.id}`" :value="model.id">{{ modelOptionLabel(model) }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
    </div>

    <label class="config-check-field">
      <Checkbox :model-value="instanceDraft.autoImportAgentConfigs" @update:model-value="(value) => instanceDraft.autoImportAgentConfigs = value === true" />
      <span>Auto-import Codex and Claude config whenever this instance becomes reachable</span>
    </label>

  </section>
</template>

<script setup lang="ts">
import { Plus } from "@lucide/vue";
import { computed } from "vue";
import type { ImageProfile, ModelConfig, Node, NodeRuntime } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import type { InstanceDraft, NewImageDraft, RuntimeDraft } from "./newInstanceTypes";

const props = defineProps<{
  canCreateImage: boolean;
  creatingImage: boolean;
  images: ImageProfile[];
  instanceDraft: InstanceDraft;
  models: ModelConfig[];
  newImage: NewImageDraft;
  newImageOpen: boolean;
  nodes: Node[];
  runtimeDraft: RuntimeDraft;
  runtimesForSelectedNode: NodeRuntime[];
  selectedRuntime?: NodeRuntime;
  selectedRuntimeRequiresImage: boolean;
  sourceSummary: string;
}>();

const defaultModelValue = "__default__";
const noModelValue = "__none__";
const eligibleModels = computed(() => props.models.filter((model) => model.locations?.some((location) => location.type === "control-plane" || (location.type === "node" && location.nodeId === props.runtimeDraft.nodeId))));
const codexModels = computed(() => eligibleModels.value.filter((model) => model.app === "codex"));
const claudeModels = computed(() => eligibleModels.value.filter((model) => model.app === "claude"));
const modelOptionLabel = (model: ModelConfig) => model.locations?.some((location) => location.type === "control-plane")
  ? `${model.name} · copy to node`
  : `${model.name} · this node`;
const instanceCodexModelValue = computed({
  get: () => props.instanceDraft.codexModelHash === null ? noModelValue : props.instanceDraft.codexModelHash || defaultModelValue,
  set: (value: string) => { props.instanceDraft.codexModelHash = value === defaultModelValue ? undefined : value === noModelValue ? null : value; },
});
const instanceClaudeModelValue = computed({
  get: () => props.instanceDraft.claudeModelHash === null ? noModelValue : props.instanceDraft.claudeModelHash || defaultModelValue,
  set: (value: string) => { props.instanceDraft.claudeModelHash = value === defaultModelValue ? undefined : value === noModelValue ? null : value; },
});

defineEmits<{
  "create-image": [];
  "update:newImageOpen": [open: boolean];
}>();
</script>

<style scoped>
.wizard-section {
  display: grid;
  gap: 14px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.section-head span,
.step-fields label span,
.instance-name-field span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.section-head button:not(.inline-flex) {
  border: 0;
  background: transparent;
  color: var(--status-success);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  padding: 0;
}

.section-head button:not(.inline-flex):hover,
.section-head button:not(.inline-flex):focus-visible {
  color: var(--white);
  outline: none;
}

.step-fields,
.inline-create,
.instance-name-field {
  display: grid;
  gap: 10px;
}

.runtime-fields {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.step-fields label,
.instance-name-field {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.config-check-field {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 700;
}

.config-check-field input {
  width: 15px;
  height: 15px;
  accent-color: var(--status-success);
}

.runtime-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 38px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: 0 12px;
}

.runtime-summary span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.runtime-summary strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 820px) {
  .runtime-fields {
    grid-template-columns: 1fr;
  }
}
</style>
