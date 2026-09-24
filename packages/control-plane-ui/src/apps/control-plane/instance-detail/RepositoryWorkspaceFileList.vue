<template>
  <div v-if="loading" class="repository-workspace-picker-state">
    <LoaderCircle class="repository-workspace-picker-spin" :size="16" />
    {{ t(searching ? "repository.workspace.searching" : "repository.workspace.loading") }}
  </div>
  <RepositoryErrorNotice v-else-if="workspaceLoadError" :error="workspaceLoadError" :fallback="t('repository.errors.workspaceLoad')" />
  <RepositoryErrorNotice v-else-if="searchError" :error="searchError" :fallback="t('repository.workspace.searchError')" />
  <template v-else>
    <div v-if="directoryLoadError && !searchQuery" class="repository-workspace-directory-error">
      <small>{{ directoryLoadError.path }}</small>
      <RepositoryErrorNotice :error="directoryLoadError.error" :fallback="t('repository.errors.directoryLoad')" />
    </div>
    <RepositoryFileTree :label="t('repository.workspace.explorer')" :nodes="nodes" @select="$emit('select', $event)" @toggle="$emit('toggle', $event)" />
    <div v-if="!nodes.length" class="repository-workspace-picker-empty">{{ t(searchQuery ? "repository.workspace.noSearchResults" : "repository.workspace.empty") }}</div>
    <div v-if="searchTruncated" class="repository-workspace-picker-note">{{ t("repository.workspace.searchTruncated") }}</div>
  </template>
</template>

<script setup lang="ts">
import { LoaderCircle } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import RepositoryFileTree, { type RepositoryFileTreeNode } from "./RepositoryFileTree.vue";

defineProps<{
  directoryLoadError?: { path: string; error: unknown };
  loading: boolean;
  nodes: RepositoryFileTreeNode[];
  searchError?: unknown;
  searching: boolean;
  searchQuery: string;
  searchTruncated?: boolean;
  workspaceLoadError?: unknown;
}>();

defineEmits<{
  select: [node: RepositoryFileTreeNode];
  toggle: [node: RepositoryFileTreeNode];
}>();

const { t } = useI18n();
</script>

<style scoped>
.repository-workspace-directory-error { display: grid; gap: 5px; margin-bottom: 7px; }
.repository-workspace-directory-error > small { overflow: hidden; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.repository-workspace-picker-state { display: flex; min-height: 100px; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 12px; }
.repository-workspace-picker-empty, .repository-workspace-picker-note { color: var(--text-muted); padding: 18px 12px; font-size: 12px; text-align: center; }
.repository-workspace-picker-note { border-top: 1px solid var(--line-subtle); padding: 8px 12px; }
.repository-workspace-picker-spin { animation: repository-workspace-picker-spin 0.9s linear infinite; }
@keyframes repository-workspace-picker-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .repository-workspace-picker-spin { animation: none; } }
</style>
