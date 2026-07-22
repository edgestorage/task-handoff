<template>
  <div class="repository-file-tree" :style="{ '--repository-tree-depth': depth }">
    <template v-for="entry in entries" :key="entry.path">
      <button
        type="button"
        class="repository-file-tree-row"
        :data-kind="entry.kind"
        :disabled="!entry.traversable && entry.kind !== 'file'"
        :title="entry.path"
        @click="activate(entry)"
      >
        <ChevronRight v-if="entry.traversable" class="repository-file-tree-chevron" :class="{ open: expandedPaths.has(entry.path) }" :size="13" />
        <span v-else class="repository-file-tree-spacer" />
        <Folder v-if="entry.kind === 'directory'" :size="14" />
        <FileCode2 v-else-if="entry.kind === 'file'" :size="14" />
        <FolderLock v-else-if="entry.kind === 'submodule' || entry.kind === 'nested-repository'" :size="14" />
        <Link v-else-if="entry.kind === 'symlink'" :size="14" />
        <FileWarning v-else :size="14" />
        <span>{{ entry.name }}</span>
      </button>
      <RepositoryFileTree
        v-if="entry.traversable && expandedPaths.has(entry.path)"
        :depth="depth + 1"
        :directories="directories"
        :expanded-paths="expandedPaths"
        :path="entry.path"
        @open-file="$emit('openFile', $event)"
        @toggle-directory="$emit('toggleDirectory', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import type { RepositoryDirectoryEntry, RepositoryDirectoryListing } from "@task-handoff/protocol/repository";
import { ChevronRight, FileCode2, FileWarning, Folder, FolderLock, Link } from "@lucide/vue";
import { computed } from "vue";

defineOptions({ name: "RepositoryFileTree" });

const props = defineProps<{
  depth?: number;
  directories: Map<string, RepositoryDirectoryListing>;
  expandedPaths: Set<string>;
  path: string;
}>();

const depth = computed(() => props.depth || 0);
const entries = computed(() => props.directories.get(props.path)?.entries || []);

function activate(entry: RepositoryDirectoryEntry) {
  if (entry.traversable) {
    return emitToggle(entry);
  }
  if (entry.kind === "file") emitOpen(entry);
}

const emit = defineEmits<{
  openFile: [entry: RepositoryDirectoryEntry];
  toggleDirectory: [entry: RepositoryDirectoryEntry];
}>();
function emitToggle(entry: RepositoryDirectoryEntry) { emit("toggleDirectory", entry); }
function emitOpen(entry: RepositoryDirectoryEntry) { emit("openFile", entry); }
</script>

<style scoped>
.repository-file-tree { display: grid; }
.repository-file-tree-row { display: flex; width: 100%; min-height: 29px; align-items: center; gap: 6px; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 3px 6px 3px calc(5px + var(--repository-tree-depth) * 14px); text-align: left; }
.repository-file-tree-row:hover:not(:disabled), .repository-file-tree-row:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-file-tree-row:disabled { cursor: not-allowed; opacity: 0.55; }
.repository-file-tree-row > span:last-child { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.repository-file-tree-chevron { transition: transform 120ms ease; }
.repository-file-tree-chevron.open { transform: rotate(90deg); }
.repository-file-tree-spacer { width: 13px; }
@media (prefers-reduced-motion: reduce) { .repository-file-tree-chevron { transition: none; } }
</style>
