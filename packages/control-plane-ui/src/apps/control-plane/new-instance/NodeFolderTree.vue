<template>
  <div class="node-folder-tree" :class="{ 'is-directory-browser': directory }">
    <aside v-if="directory" class="node-folder-places" :aria-label="t('instances.create.folders.quickLocations')">
      <strong>{{ t("instances.create.folders.quickLocations") }}</strong>
      <button
        v-for="place in places"
        :key="`${place.kind}:${place.path}`"
        type="button"
        :class="{ active: activePlacePath === place.path }"
        :title="place.path"
        @click="$emit('navigate', place.path)"
      >
        <Home v-if="place.kind === 'home'" :size="15" />
        <HardDrive v-else :size="15" />
        <span>{{ place.kind === "home" ? t("instances.create.folders.home") : place.name }}</span>
      </button>
    </aside>
    <section class="node-folder-browser-main">
    <div class="node-folder-tree-head">
      <div v-if="directory" class="node-folder-navigation">
        <Button class="node-folder-up" variant="outline" size="icon" :disabled="!canGoUp || loading" :aria-label="t('instances.create.folders.up')" :title="t('instances.create.folders.up')" @click="$emit('up')">
          <ArrowUp :size="15" />
        </Button>
        <div ref="pathAddress" class="node-folder-address" :class="{ editing: editingPath }" :title="currentPath" @click="beginPathEdit">
          <FolderOpen :size="15" aria-hidden="true" />
          <Input
            v-if="editingPath"
            v-model="pathDraft"
            class="node-folder-address-input"
            :aria-label="t('instances.create.folders.currentPath')"
            @blur="cancelPathEdit"
            @click.stop
            @keydown.enter.prevent="commitPathEdit"
            @keydown.esc.prevent="cancelPathEdit"
          />
          <nav v-else ref="pathNavigation" :aria-label="t('instances.create.folders.currentPath')">
            <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
              <ChevronRight v-if="index" :size="13" aria-hidden="true" />
              <button
                type="button"
                :aria-current="index === breadcrumbs.length - 1 ? 'page' : undefined"
                :title="crumb.path"
                @click.stop="$emit('navigate', crumb.path)"
              >{{ crumb.label }}</button>
            </template>
          </nav>
        </div>
      </div>
      <span v-else>{{ t("instances.create.folders.title") }}</span>
      <Button variant="outline" size="sm" :disabled="loading" @click="$emit('refresh')">
        <RefreshCw v-if="directory" :size="14" />
        <FolderOpen v-else :size="14" />
        <span>{{ loading ? t("instances.create.folders.loading") : t("instances.create.folders.refresh") }}</span>
      </Button>
    </div>
    <div v-if="loading" class="node-folder-tree-empty">{{ t("instances.create.folders.loadingFolders") }}</div>
    <div v-else-if="error" class="node-folder-tree-empty error">{{ error }}</div>
    <ScrollArea v-else-if="rows.length" class="node-folder-tree-list">
      <div ref="folderListContent" class="node-folder-tree-list-content">
        <button
          v-for="folder in rows"
          :key="folder.path"
          type="button"
          class="node-folder-tree-row"
          :class="{ active: selectedPath === folder.path }"
          :style="{ '--folder-depth': folder.depth }"
          @click="$emit('select', folder)"
        >
          <Folder v-if="directory" :size="15" />
          <ChevronDown v-else-if="folder.expanded" :size="14" />
          <ChevronRight v-else-if="folder.loading || !folder.loaded" :size="14" />
          <Folder v-else :size="14" />
          <span>{{ folder.name }}</span>
          <small v-if="!directory">{{ folder.path }}</small>
          <ChevronRight v-else class="node-folder-row-enter" :size="14" />
        </button>
      </div>
    </ScrollArea>
    <div v-else class="node-folder-tree-empty">{{ directory ? t("instances.create.folders.emptyDirectory") : t("instances.create.folders.empty") }}</div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ArrowUp, ChevronDown, ChevronRight, Folder, FolderOpen, HardDrive, Home, RefreshCw } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { ScrollArea } from "../../../components/ui/scroll-area";
import type { NodeFolderPlace } from "../../../api/types";
import { isSameOrChildNodePath, type NodePathBreadcrumb } from "../nodePath";
import type { NodeFolderTreeNode } from "./nodeFolderTree";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  breadcrumbs?: NodePathBreadcrumb[];
  canGoUp?: boolean;
  currentPath?: string;
  directory?: boolean;
  error: string;
  loading: boolean;
  places?: NodeFolderPlace[];
  rows: NodeFolderTreeNode[];
  selectedPath: string;
}>(), { breadcrumbs: () => [], canGoUp: false, currentPath: "", directory: false, places: () => [] });

const activePlacePath = computed(() => props.places
  .filter((place) => isSameOrChildNodePath(props.currentPath, place.path))
  .sort((left, right) => right.path.length - left.path.length)[0]?.path);
const emit = defineEmits<{
  navigate: [path: string];
  refresh: [];
  select: [folder: NodeFolderTreeNode];
  up: [];
}>();
const pathAddress = ref<HTMLElement>();
const pathNavigation = ref<HTMLElement>();
const folderListContent = ref<HTMLElement>();
const editingPath = ref(false);
const pathDraft = ref("");

watch(() => props.currentPath, async () => {
  if (!editingPath.value) pathDraft.value = props.currentPath;
  await nextTick();
  pathNavigation.value?.scrollTo({ left: pathNavigation.value.scrollWidth });
}, { flush: "post" });

watch([() => props.currentPath, () => props.loading], async ([, loading]) => {
  if (loading) return;
  await nextTick();
  folderListContent.value?.parentElement?.scrollTo({ top: 0, left: 0 });
}, { flush: "post" });

async function beginPathEdit() {
  if (editingPath.value || props.loading) return;
  pathDraft.value = props.currentPath;
  editingPath.value = true;
  await nextTick();
  const input = pathAddress.value?.querySelector<HTMLInputElement>("input");
  input?.focus();
  input?.select();
}

function cancelPathEdit() {
  editingPath.value = false;
  pathDraft.value = props.currentPath;
}

function commitPathEdit() {
  const path = pathDraft.value.trim();
  editingPath.value = false;
  if (!path || path === props.currentPath) {
    pathDraft.value = props.currentPath;
    return;
  }
  emit("navigate", path);
}
</script>

<style scoped>
.node-folder-tree {
  display: grid;
  gap: 8px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
  padding: 9px;
}

.node-folder-tree.is-directory-browser {
  grid-template-columns: 180px minmax(0, 1fr);
  min-height: 360px;
  padding: 0;
  overflow: hidden;
}

.node-folder-places {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface-inset) 72%, var(--surface));
  padding: 14px 10px;
}

.node-folder-places > strong {
  margin: 0 8px 7px;
  color: var(--text-muted);
  font-size: 12px;
}

.node-folder-places > button {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 34px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 9px;
  text-align: left;
}

.node-folder-places > button:hover,
.node-folder-places > button:focus-visible,
.node-folder-places > button.active {
  background: var(--surface-hover);
  color: var(--text);
  outline: none;
}

.node-folder-places > button svg { flex: 0 0 auto; color: var(--brand-accent); }
.node-folder-places > button span { overflow: hidden; font-size: 12px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }

.node-folder-browser-main { display: contents; }
.is-directory-browser .node-folder-browser-main { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; padding: 10px; }

.node-folder-tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.node-folder-tree-head span {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.node-folder-navigation { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; }
.node-folder-navigation > button { flex: 0 0 auto; }

.node-folder-navigation > .node-folder-up {
  width: 34px;
  height: 34px;
  border-color: var(--line);
  border-radius: 7px;
  background: color-mix(in srgb, var(--surface) 58%, var(--surface-inset));
  color: var(--text-muted);
  box-shadow: none;
}

.node-folder-navigation > .node-folder-up:hover,
.node-folder-navigation > .node-folder-up:focus-visible {
  border-color: color-mix(in srgb, var(--brand-accent) 42%, var(--line));
  background: color-mix(in srgb, var(--brand-accent) 7%, var(--surface-inset));
  color: var(--text);
}

.node-folder-address {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 34px;
  flex: 1;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: color-mix(in srgb, var(--surface) 58%, var(--surface-inset));
  padding: 0 7px;
  transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
}

.node-folder-address:hover,
.node-folder-address:focus-within {
  border-color: color-mix(in srgb, var(--brand-accent) 58%, var(--line));
  background: var(--surface);
}

.node-folder-address:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand-accent) 18%, transparent);
}

.node-folder-address.editing {
  border-color: color-mix(in srgb, var(--brand-accent) 58%, var(--line));
  background: var(--surface);
}

.node-folder-address > svg {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.node-folder-address nav {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.node-folder-address nav::-webkit-scrollbar { display: none; }
.node-folder-address nav > svg { flex: 0 0 auto; color: var(--text-muted); opacity: 0.72; }

.node-folder-address .node-folder-address-input {
  min-width: 0;
  height: 30px;
  border: 0;
  background: transparent;
  padding: 0 6px;
  box-shadow: none;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
}

.node-folder-address .node-folder-address-input:focus-visible { box-shadow: none; }

.node-folder-address nav > button {
  overflow: hidden;
  max-width: 170px;
  flex: 0 1 auto;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px 6px;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-folder-address nav > button[aria-current="page"] {
  flex-shrink: 0;
  color: var(--text);
  font-weight: 750;
}

.node-folder-address nav > button:hover,
.node-folder-address nav > button:focus-visible {
  background: var(--surface-hover);
  color: var(--text);
  outline: none;
}

.node-folder-tree-list {
  max-height: 210px;
}

.is-directory-browser .node-folder-tree-list { max-height: none; min-height: 0; }
.is-directory-browser .node-folder-tree-list-content { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); padding: 4px; }
.is-directory-browser .node-folder-tree-row { grid-template-columns: 18px minmax(0, 1fr) 14px; min-height: 40px; padding: 0 10px; }
.node-folder-row-enter { color: var(--text-muted) !important; }

.node-folder-tree-list-content {
  display: grid;
  gap: 4px;
}

.node-folder-tree-row {
  display: grid;
  grid-template-columns: 16px minmax(90px, 0.7fr) minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  min-width: 0;
  min-height: 30px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--terminal-text);
  cursor: pointer;
  padding: 0 8px 0 calc(8px + (var(--folder-depth) * 16px));
  text-align: left;
}

.node-folder-tree-row:hover,
.node-folder-tree-row:focus-visible,
.node-folder-tree-row.active {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  outline: none;
}

.node-folder-tree-row svg {
  color: var(--status-success);
}

.node-folder-tree-row span,
.node-folder-tree-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-folder-tree-row span {
  font-size: 12px;
  font-weight: 750;
}

.node-folder-tree-row small,
.node-folder-tree-empty {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
}

.node-folder-tree-empty {
  min-height: 32px;
  align-content: center;
}

.node-folder-tree-empty.error {
  color: var(--status-danger);
}

@media (max-width: 640px) {
  .node-folder-tree.is-directory-browser { grid-template-columns: 1fr; }
  .node-folder-places { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 8px; }
  .node-folder-places > strong { display: none; }
  .node-folder-places > button { flex: 0 0 auto; }
}
</style>
