<template>
  <section class="wizard-section">
    <div class="section-head">
      <span>{{ t("instances.create.workspace") }}</span>
      <button v-if="sourceDraft.mode === 'project'" type="button" @click="$emit('update:newProjectOpen', !newProjectOpen)">{{ newProjectOpen ? t("instances.create.useExisting") : t("instances.create.addRepository") }}</button>
    </div>

    <div class="choice-grid" :aria-label="t('instances.create.workspaceSource')">
      <button type="button" class="choice-tile" :class="{ active: sourceDraft.mode === 'project' }" @click="$emit('select-source-mode', 'project')">
        <GitBranch :size="17" />
        <span>{{ t("instances.create.repository") }}</span>
      </button>
      <button type="button" class="choice-tile" :class="{ active: sourceDraft.mode === 'local-folder' }" @click="$emit('select-source-mode', 'local-folder')">
        <Folder :size="17" />
        <span>{{ t("instances.create.localFolder") }}</span>
      </button>
    </div>

    <div v-if="sourceDraft.mode === 'project' && !newProjectOpen" class="step-fields">
      <label>
        <span>{{ t("instances.create.repository") }}</span>
        <ControlPlaneSelect v-model="sourceDraft.projectId" :placeholder="t('instances.create.selectProject')">
          <ControlPlaneSelectItem v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
    </div>

    <div v-else-if="sourceDraft.mode === 'project'" class="step-fields">
      <label>
        <span>{{ t("instances.create.name") }}</span>
        <ControlPlaneInput v-model="newProject.name" :placeholder="t('instances.create.repositoryName')" />
      </label>
      <label>
        <span>{{ t("instances.create.gitUrl") }}</span>
        <!-- i18n-audit-allow-next-line code-token: example Git remote URL -->
        <ControlPlaneInput v-model="newProject.url" placeholder="https://github.com/org/repo" />
      </label>
      <Button variant="outline" size="sm" :disabled="!canCreateProject || creatingProject" @click="$emit('create-project')">
        <Plus :size="15" />
        <span>{{ creatingProject ? t("instances.create.creating") : t("instances.create.createRepository") }}</span>
      </Button>
    </div>

    <div v-else class="step-fields">
      <label>
        <span>{{ t("instances.create.node") }}</span>
        <ControlPlaneSelect v-model="sourceDraft.localNodeId" :placeholder="t('instances.create.selectNode')">
          <ControlPlaneSelectItem v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
      <label>
        <span>{{ t("instances.create.nodeFolder") }}</span>
        <ControlPlaneSelect :model-value="localFolderSelectValue" :placeholder="t('instances.create.selectLocalFolder')" @update:model-value="$emit('select-local-folder', $event)">
          <ControlPlaneSelectItem v-for="folder in localFolders" :key="folder.id" :value="folder.id">{{ nodeLocalFolderDisplayName(folder) }} · {{ folder.path }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem :value="chooseFolderValue">{{ t("instances.create.chooseFolder") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </label>
      <span v-if="localPathOpen || sourceDraft.localPath" class="field-with-action">
        <ControlPlaneInput :model-value="sourceDraft.localPath" :placeholder="localPathPlaceholder" @update:model-value="$emit('set-local-folder-path', $event)" />
        <Button v-if="canBrowseProjectFolder" variant="outline" size="sm" :disabled="creatingLocalFolder || !sourceDraft.localNodeId" @click="$emit('choose-project-folder-path')">
          <FolderOpen :size="14" />
          <span>{{ creatingLocalFolder ? t("instances.create.choosing") : t("instances.create.browse") }}</span>
        </Button>
      </span>
      <NodeFolderTree
        v-if="showNodeFolderTree"
        :error="nodeFolderTreeError"
        :loading="loadingNodeFolderTree"
        :rows="nodeFolderTreeRows"
        :selected-path="sourceDraft.localPath"
        @refresh="$emit('load-node-folder-roots')"
        @select="$emit('select-node-folder-path', $event)"
      />
    </div>

    <p v-if="projectCreateError" class="control-plane-error">{{ projectCreateError }}</p>
  </section>
</template>

<script setup lang="ts">
import { Folder, FolderOpen, GitBranch, Plus } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { Node, NodeLocalFolder, Project } from "../../../api/types";
import { nodeLocalFolderDisplayName } from "../nodePath";
import { Button } from "../../../components/ui/button";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import NodeFolderTree from "./NodeFolderTree.vue";
import type { NodeFolderTreeNode } from "./nodeFolderTree";
import type { NewProjectDraft, SourceDraft, SourceMode } from "./newInstanceTypes";

const { t } = useI18n();

const props = defineProps<{
  canBrowseProjectFolder: boolean;
  canCreateProject: boolean;
  chooseFolderValue: string;
  creatingLocalFolder: boolean;
  creatingProject: boolean;
  loadingNodeFolderTree: boolean;
  localFolderSelectValue: string;
  localFolders: NodeLocalFolder[];
  localPathOpen: boolean;
  localPathPlaceholder: string;
  newProject: NewProjectDraft;
  newProjectOpen: boolean;
  nodeFolderTreeError: string;
  nodeFolderTreeRows: NodeFolderTreeNode[];
  nodes: Node[];
  projectCreateError: string;
  projects: Project[];
  showNodeFolderTree: boolean;
  sourceDraft: SourceDraft;
}>();

defineEmits<{
  "choose-project-folder-path": [];
  "create-project": [];
  "load-node-folder-roots": [];
  "select-local-folder": [value: string];
  "select-node-folder-path": [folder: NodeFolderTreeNode];
  "select-source-mode": [mode: SourceMode];
  "set-local-folder-path": [value: string];
  "update:newProjectOpen": [open: boolean];
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
.project-model-picker > span {
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
  color: var(--brand-accent);
  outline: none;
}

.choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.choice-tile {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 48px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  font-weight: 800;
  padding: 0 12px;
}

.choice-tile:hover,
.choice-tile:focus-visible,
.choice-tile.active {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--text-strong);
  outline: none;
}

.step-fields {
  display: grid;
  gap: 10px;
}

.step-fields label {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.field-with-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.field-with-action .inline-flex {
  min-height: 34px;
}

.field-hint {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
  margin: -4px 0 0;
}

.project-model-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-top: 2px;
}

.project-model-picker label {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 11px 0 34px;
}

.project-model-picker input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  margin: 0;
}

.project-model-picker label::before {
  position: absolute;
  left: 11px;
  top: 50%;
  display: grid;
  width: 15px;
  height: 15px;
  place-items: center;
  border: 1px solid var(--text-subtle);
  border-radius: 4px;
  background: var(--surface-inset);
  color: transparent;
  content: "";
  font-size: 13px;
  font-weight: 900;
  line-height: 1;
  transform: translateY(-50%);
}

.project-model-picker label:hover,
.project-model-picker label:focus-within {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  color: var(--text-strong);
}

.project-model-picker label:has(input:focus-visible) {
  outline: 2px solid var(--brand-accent);
  outline-offset: 2px;
}

.project-model-picker label:has(input:checked) {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--text-strong);
}

.project-model-picker label:has(input:checked)::before {
  border-color: var(--brand-accent);
  background: var(--brand-accent);
  color: var(--surface-inset);
  content: "✓";
}

.project-model-picker small {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
}

.control-plane-error {
  color: var(--status-danger);
  font-size: 12px;
}

@media (max-width: 820px) {
  .choice-grid {
    grid-template-columns: 1fr;
  }
}
</style>
