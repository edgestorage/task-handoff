<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogContent class="config-sync-dialog">
      <DialogHeader>
        <DialogTitle class="config-sync-title">{{ title }}</DialogTitle>
        <DialogDescription class="config-sync-description">{{ t("instances.configSync.description", { name: instance?.name || "" }) }}</DialogDescription>
      </DialogHeader>

      <ScrollArea class="config-sync-body">
        <div class="config-sync-body-content">
          <section class="config-sync-section">
            <div class="config-sync-section-title">{{ t("instances.configSync.programs") }}</div>
            <div v-if="loadingState" class="config-sync-empty">{{ t("instances.configSync.loading") }}</div>
            <div v-else class="config-sync-programs">
              <label v-for="program in programs" :key="program.id" class="config-sync-program">
                <Checkbox :model-value="selectedProgramIds.includes(program.id)" :disabled="submitting" @update:model-value="toggleProgram(program.id, $event === true)" />
                <span>
                  <strong>{{ program.label }}</strong>
                  <small>{{ destinationPath(program.directoryName) }}</small>
                </span>
              </label>
            </div>
          </section>

          <section class="config-sync-section">
            <div class="config-sync-section-title">{{ t("instances.configSync.folder") }}</div>
            <div class="config-sync-selected-path">{{ displayFolder }}</div>
            <NodeFolderTree
              :error="browser.error.value"
              :loading="browser.loading.value"
              :rows="browser.rows.value"
              :selected-path="browser.selectedPath.value"
              @refresh="loadFolders"
              @select="browser.selectFolder"
            />
          </section>

          <p v-if="error" class="control-plane-error">{{ error }}</p>
        </div>
      </ScrollArea>

      <DialogFooter>
        <Button type="button" variant="outline" :disabled="submitting" @click="setOpen(false)">{{ t("common.actions.cancel") }}</Button>
        <Button type="button" :disabled="!canSubmit" @click="submit">
          <Download v-if="direction === 'import'" :size="15" />
          <Upload v-else :size="15" />
          <span>{{ submitting ? t("instances.configSync.running") : title }}</span>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Download, Upload } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { ConfigSyncDirection, ConfigSyncProgram, ConfigSyncProgramResult } from "@task-handoff/protocol/config-sync";
import { getControlledInstanceConfigSyncState, listControlledInstanceConfigSyncFolders, syncControlledInstanceConfigs } from "../../../api/queries";
import type { InstanceBoardItem } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { translateApiError } from "../../../i18n/apiError";
import NodeFolderTree from "../new-instance/NodeFolderTree.vue";
import { useNodeFolderBrowser } from "../useNodeFolderBrowser";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{
  direction: ConfigSyncDirection;
  instance?: InstanceBoardItem;
  open: boolean;
}>();

const emit = defineEmits<{
  completed: [];
  "update:open": [open: boolean];
}>();

const { t } = useI18n();
const programs = ref<ConfigSyncProgram[]>([]);
const selectedProgramIds = ref<string[]>([]);
const loadingState = ref(false);
const submitting = ref(false);
const error = ref("");
let generation = 0;

const browser = useNodeFolderBrowser({
  errorText: (cause) => translateApiError(cause, t),
  load: (instanceId, input) => listControlledInstanceConfigSyncFolders(instanceId, input),
  translate: t,
});

const title = computed(() => t(props.direction === "import" ? "instances.actions.importConfig" : "instances.actions.exportConfig"));
const canSubmit = computed(() => Boolean(
  props.instance
  && selectedProgramIds.value.length
  && browser.selectedPath.value
  && !loadingState.value
  && !submitting.value,
));

const displayFolder = computed(() => {
  const selected = browser.selectedPath.value || ".";
  if (props.instance?.source.type !== "local-folder") return selected;
  if (selected === ".") return props.instance.source.path;
  return `${props.instance.source.path.replace(/[\\/]+$/, "")}/${selected}`;
});

watch(
  [() => props.open, () => props.instance?.id, () => props.direction],
  ([open]) => {
    if (open) void initialize();
    else reset();
  },
  { immediate: true },
);

async function initialize() {
  const instance = props.instance;
  if (!instance) return;
  const currentGeneration = ++generation;
  loadingState.value = true;
  selectedProgramIds.value = [];
  programs.value = [];
  error.value = "";
  browser.reset();
  try {
    const [state] = await Promise.all([
      getControlledInstanceConfigSyncState(instance.id),
      browser.loadRoots(instance.id),
    ]);
    if (generation !== currentGeneration) return;
    programs.value = state.programs;
    const preferredFolder = state.preferences[props.direction] || ".";
    try {
      await listControlledInstanceConfigSyncFolders(instance.id, { path: preferredFolder, depth: 0 });
      if (generation !== currentGeneration) return;
      browser.selectedPath.value = preferredFolder;
    } catch {
      if (generation !== currentGeneration) return;
      browser.selectedPath.value = ".";
    }
  } catch (cause) {
    if (generation === currentGeneration) error.value = translateApiError(cause, t);
  } finally {
    if (generation === currentGeneration) loadingState.value = false;
  }
}

function reset() {
  generation += 1;
  programs.value = [];
  selectedProgramIds.value = [];
  loadingState.value = false;
  submitting.value = false;
  error.value = "";
  browser.reset();
}

function setOpen(open: boolean) {
  if (!open && submitting.value) return;
  emit("update:open", open);
}

function toggleProgram(programId: string, selected: boolean) {
  selectedProgramIds.value = selected
    ? [...selectedProgramIds.value, programId]
    : selectedProgramIds.value.filter((id) => id !== programId);
}

function destinationPath(directoryName: string) {
  return `${displayFolder.value.replace(/[\\/]+$/, "")}/${directoryName}`;
}

function resultSummary(programs: ConfigSyncProgramResult[]) {
  const items = programs.flatMap((program) => program.items);
  const copied = items.filter((item) => item.status === "copied").length;
  const skipped = items.filter((item) => item.status === "skipped_missing_source").length;
  const failed = items.filter((item) => item.status === "failed").length;
  return {
    failed,
    message: `${t("instances.configSync.completed", { count: programs.length })} ${t("instances.configSync.resultSummary", { copied, skipped, failed })}`,
  };
}

function loadFolders() {
  if (props.instance) void browser.loadRoots(props.instance.id);
}

async function submit() {
  if (!canSubmit.value || !props.instance) return;
  submitting.value = true;
  error.value = "";
  try {
    const result = await syncControlledInstanceConfigs(props.instance.id, {
      direction: props.direction,
      programIds: selectedProgramIds.value,
      workspaceFolder: browser.selectedPath.value,
    });
    const summary = resultSummary(result.programs);
    showControlPlaneToast(summary.message, summary.failed ? "error" : "success");
    emit("completed");
    emit("update:open", false);
  } catch (cause) {
    error.value = translateApiError(cause, t);
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
:global(.config-sync-dialog) {
  width: min(760px, calc(100vw - 32px)) !important;
  max-width: calc(100vw - 32px) !important;
  max-height: calc(100vh - 32px);
  overflow: hidden;
}

:global(.config-sync-dialog .config-sync-title) {
  font-size: 16px;
}

:global(.config-sync-dialog .config-sync-description) {
  font-size: 12px;
  line-height: 1.5;
}

.config-sync-body {
  min-height: 0;
  max-height: min(620px, calc(100vh - 220px));
}

.config-sync-body-content {
  display: grid;
  gap: 16px;
  padding-right: 10px;
}

.config-sync-section {
  display: grid;
  gap: 8px;
}

.config-sync-section-title {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.config-sync-programs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 8px;
}

.config-sync-program {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
  padding: 10px;
}

.config-sync-program > span {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.config-sync-program strong {
  font-size: 14px;
  line-height: 1.35;
}

.config-sync-program small,
.config-sync-selected-path,
.config-sync-empty {
  color: var(--text-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.config-sync-section :deep(.node-folder-tree-list) {
  max-height: min(280px, calc(100vh - 440px));
}
</style>
