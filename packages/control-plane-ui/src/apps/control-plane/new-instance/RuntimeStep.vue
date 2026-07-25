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
          <ControlPlaneSelectItem v-for="image in images" :key="image.id" :value="image.id">{{ image.name }} · {{ availabilityLabel(image.id) }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
    </div>

    <Card v-if="selectedRuntime?.type === 'docker'" class="docker-runtime-check" :data-state="dockerRuntimeCheckState">
      <CardContent class="docker-runtime-check-content">
        <CircleCheck v-if="dockerRuntimeCheckState === 'online'" :size="18" />
        <LoaderCircle v-else-if="dockerRuntimeCheckState === 'checking'" class="docker-runtime-check-spin" :size="18" />
        <CircleAlert v-else :size="18" />
        <div>
          <strong>{{ dockerCheckTitle }}</strong>
          <span>{{ dockerRuntimeCheckMessage || dockerCheckFallback }}</span>
          <span v-if="dockerRuntimeCheckState === 'offline'">{{ installGuidance.message }}</span>
        </div>
        <Button v-if="dockerRuntimeCheckState === 'offline'" as-child variant="outline" size="sm">
          <a :href="installGuidance.url" target="_blank" rel="noopener noreferrer">
            <ExternalLink :size="14" />
            <span>{{ installGuidance.label }}</span>
          </a>
        </Button>
        <Button v-if="dockerRuntimeCheckState === 'idle' || dockerRuntimeCheckState === 'offline' || dockerRuntimeCheckState === 'error'" variant="outline" size="sm" @click="$emit('check-docker-runtime')">
          <RefreshCw :size="14" />
          <span>{{ dockerRuntimeCheckState === "idle" ? "Check Docker" : "Retry check" }}</span>
        </Button>
      </CardContent>
    </Card>

    <div v-if="selectedRuntimeRequiresImage && newImageOpen" class="step-fields inline-create">
      <label>
        <span>Name</span>
        <ControlPlaneInput v-model="newImage.name" placeholder="Image name" />
      </label>
      <label>
        <span>Image ref</span>
        <ControlPlaneInput v-model="newImage.reference" placeholder="docker.io/example/image:v1" />
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
        <ControlPlaneSelect v-model="instanceCodexModelValue" placeholder="No model">
          <ControlPlaneSelectItem :value="noModelValue">No model</ControlPlaneSelectItem>
          <ControlPlaneSelectItem :value="defaultModelValue">Global default</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="model in codexModels" :key="`instance-codex-${model.id}`" :value="model.id">{{ modelOptionLabel(model) }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
      <label v-if="claudeModels.length">
        <span>Claude model</span>
        <ControlPlaneSelect v-model="instanceClaudeModelValue" placeholder="No model">
          <ControlPlaneSelectItem :value="noModelValue">No model</ControlPlaneSelectItem>
          <ControlPlaneSelectItem :value="defaultModelValue">Global default</ControlPlaneSelectItem>
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
import { CircleAlert, CircleCheck, ExternalLink, LoaderCircle, Plus, RefreshCw } from "@lucide/vue";
import { computed } from "vue";
import type { ImageProfile, ModelConfig, Node, NodeImageAvailability, NodeRuntime } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import type { InstanceDraft, NewImageDraft, RuntimeDraft } from "./newInstanceTypes";
import { dockerInstallGuidance, type DockerRuntimeCheckState } from "./dockerRuntimeGuidance";

const props = defineProps<{
  canCreateImage: boolean;
  creatingImage: boolean;
  dockerRuntimeCheckMessage: string;
  dockerRuntimeCheckState: DockerRuntimeCheckState;
  images: ImageProfile[];
  imageAvailability: NodeImageAvailability[];
  instanceDraft: InstanceDraft;
  models: ModelConfig[];
  newImage: NewImageDraft;
  newImageOpen: boolean;
  nodes: Node[];
  runtimeDraft: RuntimeDraft;
  runtimesForSelectedNode: NodeRuntime[];
  selectedRuntime?: NodeRuntime;
  selectedRuntimeRequiresImage: boolean;
  selectedNodePlatform: string;
  sourceSummary: string;
}>();

const defaultModelValue = "__default__";
const noModelValue = "__none__";
const installGuidance = computed(() => dockerInstallGuidance(props.selectedNodePlatform));
const dockerCheckTitle = computed(() => props.dockerRuntimeCheckState === "online"
  ? "Docker is ready"
  : props.dockerRuntimeCheckState === "checking"
    ? "Checking Docker"
    : props.dockerRuntimeCheckState === "offline"
      ? "Docker is not available"
      : props.dockerRuntimeCheckState === "error"
        ? "Docker check failed"
        : "Docker must be checked");
const dockerCheckFallback = computed(() => props.dockerRuntimeCheckState === "idle"
  ? "The Docker daemon must be checked before this instance can be created."
  : "Docker could not be verified on the selected node.");
const availabilityLabel = (imageId: string) => {
  const status = props.imageAvailability.find((item) => item.image.id === imageId)?.status || "unknown";
  return status === "available" ? "Available" : status === "pull-required" ? "Will be pulled" : "Availability unknown";
};
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
  "check-docker-runtime": [];
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

.docker-runtime-check {
  box-shadow: none;
}

.docker-runtime-check[data-state="online"] {
  border-color: color-mix(in srgb, var(--status-success) 45%, var(--line-subtle));
}

.docker-runtime-check[data-state="offline"],
.docker-runtime-check[data-state="error"] {
  border-color: color-mix(in srgb, var(--status-warning) 55%, var(--line-subtle));
}

.docker-runtime-check-content {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}

.docker-runtime-check-content > div {
  display: grid;
  gap: 3px;
}

.docker-runtime-check-content strong {
  color: var(--text-strong);
  font-size: 12px;
}

.docker-runtime-check-content span {
  color: var(--text-muted);
  font-size: 11px;
}

.docker-runtime-check-spin {
  animation: docker-runtime-check-spin 0.9s linear infinite;
}

@keyframes docker-runtime-check-spin {
  to { transform: rotate(360deg); }
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

  .docker-runtime-check-content {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .docker-runtime-check-content > .inline-flex {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
