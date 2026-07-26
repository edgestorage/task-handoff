<template>
  <section class="wizard-section">
    <div class="section-head">
      <span>{{ t("instances.create.runtime") }}</span>
      <button v-if="selectedRuntimeRequiresImage" type="button" @click="$emit('update:newImageOpen', !newImageOpen)">{{ newImageOpen ? t("instances.create.useExisting") : t("instances.create.addImage") }}</button>
    </div>

    <div class="runtime-summary">
      <span>{{ t("instances.create.source") }}</span>
      <strong>{{ sourceSummary }}</strong>
      <span v-if="selectedRuntime && !selectedRuntimeRequiresImage">{{ t("instances.create.runtime") }}</span>
      <strong v-if="selectedRuntime && !selectedRuntimeRequiresImage">{{ selectedRuntime.name }} · {{ t("instances.create.noContainer") }}</strong>
    </div>

    <div class="step-fields runtime-fields">
      <label>
        <span>{{ t("instances.create.node") }}</span>
        <ControlPlaneSelect v-model="runtimeDraft.nodeId" :placeholder="t('instances.create.selectNode')">
          <ControlPlaneSelectItem v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
      <label>
        <span>{{ t("instances.create.runtime") }}</span>
        <ControlPlaneSelect v-model="runtimeDraft.runtimeId" :placeholder="t('instances.create.selectRuntime')">
          <ControlPlaneSelectItem v-for="runtime in runtimesForSelectedNode" :key="runtime.id" :value="runtime.id">{{ runtime.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
      <label v-if="selectedRuntimeRequiresImage && !newImageOpen">
        <span>{{ t("instances.create.image") }}</span>
        <ControlPlaneSelect v-model="runtimeDraft.imageId" :placeholder="t('instances.create.selectImage')">
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
          <span v-if="dockerRuntimeCheckState === 'offline'">{{ installGuidanceMessage }}</span>
        </div>
        <Button v-if="dockerRuntimeCheckState === 'offline'" as-child variant="outline" size="sm">
          <a :href="installGuidance.url" target="_blank" rel="noopener noreferrer">
            <ExternalLink :size="14" />
            <span>{{ installGuidanceLabel }}</span>
          </a>
        </Button>
        <Button v-if="dockerRuntimeCheckState === 'idle' || dockerRuntimeCheckState === 'offline' || dockerRuntimeCheckState === 'error'" variant="outline" size="sm" @click="$emit('check-docker-runtime')">
          <RefreshCw :size="14" />
          <span>{{ dockerRuntimeCheckState === "idle" ? t("instances.create.docker.check") : t("instances.create.docker.retry") }}</span>
        </Button>
      </CardContent>
    </Card>

    <div v-if="selectedRuntimeRequiresImage && newImageOpen" class="step-fields inline-create">
      <label>
        <span>{{ t("instances.create.name") }}</span>
        <ControlPlaneInput v-model="newImage.name" :placeholder="t('instances.create.imageName')" />
      </label>
      <label>
        <span>{{ t("instances.create.imageReference") }}</span>
        <!-- i18n-audit-allow-next-line code-token: example OCI image reference -->
        <ControlPlaneInput v-model="newImage.reference" placeholder="docker.io/example/image:v1" />
      </label>
      <Button variant="outline" size="sm" :disabled="!canCreateImage || creatingImage" @click="$emit('create-image')">
        <Plus :size="15" />
        <span>{{ creatingImage ? t("instances.create.creating") : t("instances.create.createImage") }}</span>
      </Button>
    </div>

    <label class="instance-name-field">
      <span>{{ t("instances.create.name") }}</span>
      <ControlPlaneInput v-model="instanceDraft.name" :placeholder="t('instances.create.optionalInstanceName')" />
    </label>

    <div v-if="codexModels.length || claudeModels.length" class="step-fields instance-model-fields">
      <label v-if="codexModels.length">
        <span>{{ t("instances.create.codexModel") }}</span>
        <ControlPlaneSelect v-model="instanceCodexModelValue" :placeholder="t('instances.create.noModel')">
          <ControlPlaneSelectItem :value="noModelValue">{{ t("instances.create.noModel") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem :value="defaultModelValue">{{ t("instances.create.globalDefault") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="model in codexModels" :key="`instance-codex-${model.id}`" :value="model.id">{{ modelOptionLabel(model) }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
      <label v-if="claudeModels.length">
        <span>{{ t("instances.create.claudeModel") }}</span>
        <ControlPlaneSelect v-model="instanceClaudeModelValue" :placeholder="t('instances.create.noModel')">
          <ControlPlaneSelectItem :value="noModelValue">{{ t("instances.create.noModel") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem :value="defaultModelValue">{{ t("instances.create.globalDefault") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="model in claudeModels" :key="`instance-claude-${model.id}`" :value="model.id">{{ modelOptionLabel(model) }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
    </div>

    <label class="config-check-field">
      <Checkbox :model-value="instanceDraft.autoImportAgentConfigs" @update:model-value="(value) => instanceDraft.autoImportAgentConfigs = value === true" />
      <span>{{ t("instances.create.autoImportConfigs") }}</span>
    </label>

  </section>
</template>

<script setup lang="ts">
import { CircleAlert, CircleCheck, ExternalLink, LoaderCircle, Plus, RefreshCw } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ImageProfile, ModelConfig, Node, NodeImageAvailability, NodeRuntime } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import type { InstanceDraft, NewImageDraft, RuntimeDraft } from "./newInstanceTypes";
import { dockerInstallGuidance, type DockerRuntimeCheckState } from "./dockerRuntimeGuidance";

const { t } = useI18n();

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
const installGuidanceLabel = computed(() => t(`instances.create.docker.install.${installGuidance.value.kind}Label`));
const installGuidanceMessage = computed(() => t(`instances.create.docker.install.${installGuidance.value.kind}Message`));
const dockerCheckTitle = computed(() => props.dockerRuntimeCheckState === "online"
  ? t("instances.create.docker.ready")
  : props.dockerRuntimeCheckState === "checking"
    ? t("instances.create.docker.checking")
    : props.dockerRuntimeCheckState === "offline"
      ? t("instances.create.docker.unavailable")
      : props.dockerRuntimeCheckState === "error"
        ? t("instances.create.docker.failed")
        : t("instances.create.docker.required"));
const dockerCheckFallback = computed(() => props.dockerRuntimeCheckState === "idle"
  ? t("instances.create.docker.mustCheck")
  : t("instances.create.docker.unverified"));
const availabilityLabel = (imageId: string) => {
  const status = props.imageAvailability.find((item) => item.image.id === imageId)?.status || "unknown";
  return status === "available"
    ? t("instances.create.availability.available")
    : status === "pull-required"
      ? t("instances.create.availability.pullRequired")
      : t("instances.create.availability.unknown");
};
const eligibleModels = computed(() => props.models.filter((model) => model.locations?.some((location) => location.type === "control-plane" || (location.type === "node" && location.nodeId === props.runtimeDraft.nodeId))));
const codexModels = computed(() => eligibleModels.value.filter((model) => model.app === "codex"));
const claudeModels = computed(() => eligibleModels.value.filter((model) => model.app === "claude"));
const modelOptionLabel = (model: ModelConfig) => model.locations?.some((location) => location.type === "control-plane")
  ? t("instances.create.modelCopyToNode", { name: model.name })
  : t("instances.create.modelOnNode", { name: model.name });
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
