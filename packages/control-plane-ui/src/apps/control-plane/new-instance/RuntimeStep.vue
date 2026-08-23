<template>
  <section class="wizard-section">
    <div class="section-head">
      <span>{{ t("instances.create.runtime") }}</span>
      <button v-if="selectedRuntimeRequiresImage && runtimeDraft.environmentSourceType === 'image'" type="button" @click="$emit('update:newImageOpen', !newImageOpen)">{{ newImageOpen ? t("instances.create.useExisting") : t("instances.create.addImage") }}</button>
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
      <div v-if="selectedRuntimeRequiresImage" class="environment-source-field">
        <span>{{ t("instances.create.environmentSource") }}</span>
        <div class="environment-source-control" role="group" :aria-label="t('instances.create.environmentSource')">
          <button type="button" :class="{ active: runtimeDraft.environmentSourceType === 'image' }" :aria-pressed="runtimeDraft.environmentSourceType === 'image'" @click="selectEnvironmentSource('image')">
            <Image :size="15" />
            <span>{{ t("instances.create.image") }}</span>
          </button>
          <button type="button" :class="{ active: runtimeDraft.environmentSourceType === 'template' }" :aria-pressed="runtimeDraft.environmentSourceType === 'template'" @click="selectEnvironmentSource('template')">
            <Package :size="15" />
            <span>{{ t("instances.create.environmentTemplate") }}</span>
          </button>
        </div>
      </div>
      <div v-if="selectedRuntimeRequiresImage && runtimeDraft.environmentSourceType === 'image' && !newImageOpen" class="image-picker-field">
        <span>{{ t("instances.create.image") }}</span>
        <Popover v-model:open="imagePickerOpen">
          <PopoverTrigger as-child>
            <button type="button" class="image-picker-trigger">
              <template v-if="selectedImage">
                <ImageArtwork compact class="image-picker-trigger-artwork" :cover="selectedImage.cover" :icon-size="18" :name="selectedImage.name" />
                <span class="image-picker-trigger-copy">
                  <strong>{{ selectedImage.name }}</strong>
                  <small>{{ availabilityLabel(selectedImage.id) }}</small>
                </span>
              </template>
              <span v-else class="image-picker-placeholder">{{ t("instances.create.selectImage") }}</span>
              <ChevronDown :size="16" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            class="image-picker-popover"
            align="start"
            :collision-padding="12"
            :side-offset="6"
            :style="{ width: 'var(--reka-popover-trigger-width)', padding: '4px' }"
          >
            <label class="image-picker-search">
              <Search :size="14" />
              <input
                ref="imageSearchInput"
                v-model="imageSearch"
                type="search"
                :placeholder="t('instances.create.searchImages')"
                :aria-label="t('instances.create.searchImages')"
              />
            </label>
            <ScrollArea class="image-picker-list">
              <div class="image-picker-list-content" role="listbox" :aria-label="t('instances.create.image')">
                <section v-for="group in filteredImageGroups" :key="group.key" class="image-picker-group" role="group" :aria-label="group.label">
                  <div class="image-picker-group-label">{{ group.label }} · {{ group.images.length }}</div>
                  <div class="image-picker-options">
                    <button
                      v-for="image in group.images"
                      :key="image.id"
                      type="button"
                      role="option"
                      class="image-picker-option"
                      :class="{ selected: image.id === runtimeDraft.imageId }"
                      :aria-selected="image.id === runtimeDraft.imageId"
                      @click="selectImage(image.id)"
                    >
                      <ImageArtwork compact class="image-picker-option-artwork" :cover="image.cover" :icon-size="16" :name="image.name" />
                      <span class="image-picker-option-copy">
                        <span class="image-picker-option-head">
                          <strong>{{ image.name }}</strong>
                          <small :data-status="availabilityStatus(image.id)">{{ availabilityLabel(image.id) }}</small>
                        </span>
                        <span v-if="localizedImageDescription(image)" class="image-picker-option-description">{{ localizedImageDescription(image) }}</span>
                        <span class="image-picker-option-meta">
                          <code>{{ image.reference }}</code>
                          <span class="image-picker-option-capabilities">
                            <small v-for="capability in image.capabilities.slice(0, 3)" :key="capability">{{ capabilityLabel(capability) }}</small>
                            <small v-if="image.capabilities.length > 3">+{{ image.capabilities.length - 3 }}</small>
                          </span>
                        </span>
                      </span>
                      <Check v-if="image.id === runtimeDraft.imageId" :size="15" />
                    </button>
                  </div>
                </section>
                <div v-if="!filteredImageGroups.length" class="image-picker-empty">{{ t("instances.create.noImagesFound") }}</div>
              </div>
            </ScrollArea>
          </PopoverContent>
        </Popover>
      </div>
      <div v-if="selectedRuntimeRequiresImage && runtimeDraft.environmentSourceType === 'template'" class="image-picker-field">
        <span>{{ t("instances.create.environmentTemplate") }}</span>
        <Popover v-model:open="templatePickerOpen">
          <PopoverTrigger as-child>
            <button type="button" class="image-picker-trigger template-picker-trigger">
              <Package :size="20" />
              <span v-if="selectedTemplate" class="image-picker-trigger-copy">
                <strong>{{ selectedTemplate.name }}</strong>
                <small>{{ templateMeta(selectedTemplate) }}</small>
              </span>
              <span v-else class="image-picker-placeholder">{{ t("instances.create.selectEnvironmentTemplate") }}</span>
              <ChevronDown :size="16" />
            </button>
          </PopoverTrigger>
          <PopoverContent class="image-picker-popover" align="start" :collision-padding="12" :side-offset="6" :style="{ width: 'var(--reka-popover-trigger-width)', padding: '4px' }">
            <label class="image-picker-search">
              <Search :size="14" />
              <input ref="templateSearchInput" v-model="templateSearch" type="search" :placeholder="t('instances.create.searchEnvironmentTemplates')" :aria-label="t('instances.create.searchEnvironmentTemplates')" />
            </label>
            <ScrollArea class="image-picker-list">
              <div class="image-picker-list-content" role="listbox" :aria-label="t('instances.create.environmentTemplate')">
                <div class="image-picker-options">
                  <button v-for="template in filteredTemplates" :key="template.id" type="button" role="option" class="image-picker-option template-picker-option" :class="{ selected: template.id === runtimeDraft.environmentTemplateId }" :aria-selected="template.id === runtimeDraft.environmentTemplateId" @click="selectTemplate(template.id)">
                    <Package :size="18" />
                    <span class="image-picker-option-copy">
                      <span class="image-picker-option-head"><strong>{{ template.name }}</strong><small data-status="available">{{ t("instances.create.templateReady") }}</small></span>
                      <span class="image-picker-option-meta"><code>{{ template.imageId }}</code><small>{{ templateMeta(template) }}</small></span>
                    </span>
                    <Check v-if="template.id === runtimeDraft.environmentTemplateId" :size="15" />
                  </button>
                </div>
                <div v-if="!filteredTemplates.length" class="image-picker-empty">{{ t("instances.create.noEnvironmentTemplates") }}</div>
              </div>
            </ScrollArea>
          </PopoverContent>
        </Popover>
      </div>
      <label v-if="runtimeDraft.environmentSourceType === 'image' && selectedImage?.origin === 'market' && selectedImage.availableTags.length > 1 && !newImageOpen">
        <span>{{ t("instances.create.imageTag") }}</span>
        <ControlPlaneSelect v-model="runtimeDraft.imageTag" :placeholder="t('instances.create.selectImageTag')">
          <ControlPlaneSelectItem v-for="tag in selectableTags" :key="tag.name" :value="tag.name">
            {{ tag.name }}<template v-if="tag.status !== 'active'"> · {{ lifecycleLabel(tag.status) }}</template>
          </ControlPlaneSelectItem>
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

    <div v-if="selectedRuntimeRequiresImage && runtimeDraft.environmentSourceType === 'image' && newImageOpen" class="step-fields inline-create">
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

    <div v-if="gitSource && gitCredentialId && gitCredentialProvisioningSupported" class="git-credential-selection">
      <div class="git-credential-summary">
        <span>{{ t("instances.create.gitCredential") }}</span>
        <strong>{{ gitCredential?.name || gitCredentialId }}</strong>
        <small v-if="gitCredential">{{ gitCredential.scope.host }}{{ gitCredential.scope.pathPrefix }}</small>
      </div>
      <label class="config-check-field git-retention-field">
        <Checkbox :model-value="instanceDraft.retainGitCredential" :disabled="!canRetainGitCredential" @update:model-value="(value) => instanceDraft.retainGitCredential = value === true" />
        <span>
          {{ t("instances.create.retainGitCredential") }}
          <small>{{ t(instanceDraft.retainGitCredential ? "instances.create.retainedGitCredentialDescription" : "instances.create.operationOnlyGitCredentialDescription") }}</small>
        </span>
      </label>
    </div>
    <p v-else-if="gitSource && gitCredentialId" class="git-credential-unavailable" role="status">{{ t("instances.create.gitCredentialUnsupported") }}</p>

    <div v-if="codexModels.length || claudeModels.length || opencodeModels.length" class="step-fields instance-model-fields">
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
      <label v-if="opencodeModels.length">
        <span>{{ t("instances.create.opencodeModel") }}</span>
        <ControlPlaneSelect v-model="instanceOpenCodeModelValue" :placeholder="t('instances.create.noModel')">
          <ControlPlaneSelectItem :value="noModelValue">{{ t("instances.create.noModel") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem :value="defaultModelValue">{{ t("instances.create.globalDefault") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="model in opencodeModels" :key="`instance-opencode-${model.id}`" :value="model.id">{{ modelOptionLabel(model) }}</ControlPlaneSelectItem>
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
import { Check, ChevronDown, CircleAlert, CircleCheck, ExternalLink, Image, LoaderCircle, Package, Plus, RefreshCw, Search } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { EnvironmentTemplate, ModelConfig, Node, NodeImageAvailability, NodeRuntime, SelectableImage } from "../../../api/types";
import type { GitCredentialPublic } from "@task-handoff/protocol/managed-git-credentials";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ImageArtwork from "../shared/ImageArtwork.vue";
import { resolveImageDescription } from "../shared/imageDescription";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import type { InstanceDraft, NewImageDraft, RuntimeDraft } from "./newInstanceTypes";
import { dockerInstallGuidance, type DockerRuntimeCheckState } from "./dockerRuntimeGuidance";

const { locale, t } = useI18n();

const props = defineProps<{
  canCreateImage: boolean;
  canRetainGitCredential: boolean;
  creatingImage: boolean;
  dockerRuntimeCheckMessage: string;
  dockerRuntimeCheckState: DockerRuntimeCheckState;
  images: SelectableImage[];
  environmentTemplates: EnvironmentTemplate[];
  imageAvailability: NodeImageAvailability[];
  instanceDraft: InstanceDraft;
  gitCredential?: GitCredentialPublic;
  gitCredentialId: string;
  gitCredentialProvisioningSupported: boolean;
  gitSource: boolean;
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
const imagePickerOpen = ref(false);
const imageSearch = ref("");
const imageSearchInput = ref<HTMLInputElement>();
const templatePickerOpen = ref(false);
const templateSearch = ref("");
const templateSearchInput = ref<HTMLInputElement>();
const normalizedImageSearch = computed(() => imageSearch.value.trim().toLocaleLowerCase());
const imageMatchesSearch = (image: SelectableImage) => !normalizedImageSearch.value || [
  image.name,
  image.description,
  ...Object.values(image.localizedDescriptions || {}),
  image.reference,
  image.repository,
  image.market?.publisher,
  ...image.capabilities,
  ...image.optionalApps,
].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedImageSearch.value);
const imageGroups = computed(() => [
  { key: "market", label: t("instances.create.marketImages"), images: props.images.filter((image) => image.origin === "market") },
  { key: "custom", label: t("instances.create.customImages"), images: props.images.filter((image) => image.origin === "custom") },
]);
const filteredImageGroups = computed(() => imageGroups.value
  .map((group) => ({ ...group, images: group.images.filter(imageMatchesSearch) }))
  .filter((group) => group.images.length));
const selectedImage = computed(() => props.images.find((image) => image.id === props.runtimeDraft.imageId));
const readyTemplates = computed(() => props.environmentTemplates.filter((template) => template.status === "ready"));
const selectedTemplate = computed(() => readyTemplates.value.find((template) => template.id === props.runtimeDraft.environmentTemplateId));
const filteredTemplates = computed(() => {
  const search = templateSearch.value.trim().toLocaleLowerCase();
  return readyTemplates.value.filter((template) => !search || `${template.name} ${template.imageId || ""} ${template.platform || ""} ${template.architecture || ""}`.toLocaleLowerCase().includes(search));
});
const templateMeta = (template: EnvironmentTemplate) => [template.platform, template.architecture, formatBytes(template.sizeBytes)].filter(Boolean).join(" · ");
const formatBytes = (bytes?: number) => {
  if (bytes === undefined) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};
const localizedImageDescription = (image: SelectableImage) => resolveImageDescription(image, locale.value);
const selectableTags = computed(() => selectedImage.value?.availableTags.filter((tag) => tag.status !== "yanked") || []);
const lifecycleLabel = (status: string) => t(`instances.create.lifecycle.${status}`);
const selectImage = (imageId: string) => {
  props.runtimeDraft.imageId = imageId;
  imagePickerOpen.value = false;
};
const selectTemplate = (templateId: string) => {
  props.runtimeDraft.environmentTemplateId = templateId;
  templatePickerOpen.value = false;
};
const selectEnvironmentSource = (type: "image" | "template") => {
  props.runtimeDraft.environmentSourceType = type;
  if (type === "template") {
    props.runtimeDraft.environmentTemplateId ||= readyTemplates.value[0]?.id || "";
    props.runtimeDraft.imageTag = "";
  }
  if (type === "image") props.runtimeDraft.imageId ||= props.images[0]?.id || "";
};
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
const availabilityStatus = (imageId: string) => props.imageAvailability.find((item) => item.image.id === imageId)?.status || "unknown";
const availabilityLabel = (imageId: string) => {
  const status = availabilityStatus(imageId);
  return status === "available"
    ? t("instances.create.availability.available")
    : status === "pull-required"
      ? t("instances.create.availability.pullRequired")
      : t("instances.create.availability.unknown");
};
const capabilityLabel = (capability: string) => t(`common.imageCapabilities.${capability}`, capability);
watch(imagePickerOpen, async (open) => {
  if (!open) {
    imageSearch.value = "";
    return;
  }
  await nextTick();
  imageSearchInput.value?.focus();
});
watch(templatePickerOpen, async (open) => {
  if (!open) {
    templateSearch.value = "";
    return;
  }
  await nextTick();
  templateSearchInput.value?.focus();
});
const eligibleModels = computed(() => props.models.filter((model) => model.locations?.some((location) => location.type === "control-plane" || (location.type === "node" && location.nodeId === props.runtimeDraft.nodeId))));
const codexModels = computed(() => eligibleModels.value.filter((model) => model.app === "codex"));
const claudeModels = computed(() => eligibleModels.value.filter((model) => model.app === "claude"));
const opencodeModels = computed(() => eligibleModels.value.filter((model) => model.app === "opencode"));
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
const instanceOpenCodeModelValue = computed({
  get: () => props.instanceDraft.opencodeModelHash === null ? noModelValue : props.instanceDraft.opencodeModelHash || defaultModelValue,
  set: (value: string) => { props.instanceDraft.opencodeModelHash = value === defaultModelValue ? undefined : value === noModelValue ? null : value; },
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

.image-picker-field {
  display: grid;
  grid-column: 1 / -1;
  min-width: 0;
  gap: 7px;
}

.environment-source-field {
  display: grid;
  grid-column: 1 / -1;
  gap: 7px;
}

.environment-source-field > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.environment-source-control {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 3px;
}

.environment-source-control button {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
}

.environment-source-control button:hover,
.environment-source-control button:focus-visible {
  background: var(--surface-hover);
  color: var(--text);
  outline: none;
}

.environment-source-control button.active {
  background: var(--surface-raised);
  color: var(--text-strong);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}

.template-picker-trigger > svg:first-child {
  justify-self: center;
  color: var(--text-muted);
}

.template-picker-option {
  grid-template-columns: 28px minmax(0, 1fr) 15px;
  min-height: 58px;
}

.template-picker-option > svg:first-child {
  justify-self: center;
  color: var(--text-muted);
}

.image-picker-field > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.image-picker-trigger {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  width: 100%;
  min-width: 0;
  min-height: 56px;
  gap: 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-raised);
  color: var(--text);
  cursor: pointer;
  padding: 6px 12px 6px 7px;
  text-align: left;
}

.image-picker-trigger:hover,
.image-picker-trigger:focus-visible,
.image-picker-trigger[data-state="open"] {
  border-color: var(--line-strong);
  background: var(--surface-hover);
  outline: none;
}

.image-picker-trigger-artwork {
  width: 42px;
  height: 42px;
  min-height: 42px;
  border-radius: 8px;
}

.image-picker-trigger-copy,
.image-picker-option > span {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.image-picker-trigger-copy strong,
.image-picker-trigger-copy small,
.image-picker-option strong,
.image-picker-option small,
.image-picker-placeholder {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-picker-trigger-copy strong {
  color: var(--text-strong);
  font-size: 12px;
}

.image-picker-trigger-copy small,
.image-picker-placeholder {
  color: var(--text-muted);
  font-size: 12px;
}

:global(.image-picker-popover) {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: var(--reka-popover-trigger-width);
  max-width: calc(100vw - 24px);
  max-height: min(440px, var(--reka-popover-content-available-height));
  overflow: hidden;
  border-color: var(--line);
  background: var(--surface-raised);
  padding: 4px;
}

.image-picker-search {
  display: flex;
  height: 34px;
  align-items: center;
  gap: 7px;
  margin: 2px 2px 4px;
  border: 1px solid var(--line-subtle);
  border-radius: 7px;
  background: var(--surface-inset);
  color: var(--text-muted);
  padding: 0 9px;
}

.image-picker-search:focus-within {
  border-color: var(--focus-ring);
}

.image-picker-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 12px;
}

.image-picker-search input::placeholder {
  color: var(--text-subtle);
}

.image-picker-list {
  min-height: 0;
  max-height: none;
}

.image-picker-list-content {
  min-width: 0;
  padding-right: 8px;
}

.image-picker-group {
  display: grid;
}

.image-picker-group + .image-picker-group {
  border-top: 1px solid var(--line-subtle);
}

.image-picker-group-label {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 650;
  padding: 7px 8px 3px;
}

.image-picker-options {
  display: grid;
  gap: 2px;
}

.image-picker-option {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 15px;
  align-items: center;
  min-width: 0;
  min-height: 66px;
  gap: 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  padding: 7px 9px;
  text-align: left;
}

.image-picker-option:hover,
.image-picker-option:focus-visible {
  background: var(--surface-active);
  outline: none;
}

.image-picker-option.selected {
  background: var(--surface-active);
  color: var(--status-success);
}

.image-picker-option-artwork {
  width: 36px;
  height: 36px;
  min-height: 36px;
  border-radius: 7px;
}

.image-picker-option-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.image-picker-option-head,
.image-picker-option-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.image-picker-option-head strong {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 650;
}

.image-picker-option-head small {
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  font-size: 10px;
  padding: 2px 6px;
}

.image-picker-option-head small[data-status="available"] {
  background: var(--status-success-bg);
  color: var(--status-success);
}

.image-picker-option-description {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-picker-option-meta code {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--text-subtle);
  font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-picker-option-capabilities {
  display: flex;
  flex: 0 0 auto;
  gap: 3px;
}

.image-picker-option-capabilities small {
  border: 1px solid var(--line-subtle);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 16px;
  padding: 0 4px;
}

.image-picker-empty {
  color: var(--text-muted);
  font-size: 12px;
  padding: 24px 12px;
  text-align: center;
}

.section-head button:not(.inline-flex):hover,
.section-head button:not(.inline-flex):focus-visible {
  color: var(--brand-accent);
  outline: none;
}

.step-fields,
.inline-create,
.instance-name-field {
  display: grid;
  gap: 10px;
}

.runtime-fields {
  grid-template-columns: repeat(2, minmax(0, 1fr));
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
  font-size: 12px;
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

.git-credential-selection {
  border-top: 1px solid var(--line);
  display: grid;
  gap: 12px;
  padding-top: 14px;
}

.git-credential-unavailable {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
}

.git-credential-summary {
  display: grid;
  gap: 3px;
}

.git-credential-summary > span,
.git-credential-summary > small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
}

.git-credential-summary > strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.git-retention-field {
  align-items: flex-start;
  font-weight: 400;
}

.git-retention-field > span {
  display: grid;
  gap: 3px;
}

.git-retention-field small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
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
