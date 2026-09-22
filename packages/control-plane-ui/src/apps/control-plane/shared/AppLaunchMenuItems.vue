<template>
  <template v-for="app in apps" :key="app.id">
    <DropdownMenuSub v-if="app.supportsCwdSelection && cwdSelection">
      <DropdownMenuSubTrigger class="app-launch-menu-item" :disabled="launching" @click.prevent.stop="$emit('launch', app.id)">
        <AppLaunchIcon :app-id="app.id" />
        <span>
          <strong>{{ app.label }}</strong>
          <small>{{ app.id }}</small>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent :class="submenuClass || 'app-launch-menu'">
        <div class="app-launch-project-search" @click.stop @keydown.stop>
          <Search :size="13" />
          <input v-model="folderSearch" type="search" :placeholder="t('sessions.tabs.searchProjects')" :aria-label="t('sessions.tabs.searchProjects')" />
        </div>
        <DropdownMenuItem v-for="folder in filteredCwdFolders" :key="`${app.id}-${folder.id}`" class="app-launch-menu-item" :disabled="launching" @select="$emit('launch', app.id, folder.id)">
          <Folder :size="14" />
          <span>
            <strong>{{ nodeLocalFolderDisplayName(folder) }}</strong>
            <small>{{ folder.path }}</small>
          </span>
        </DropdownMenuItem>
        <p v-if="!filteredCwdFolders.length" class="app-launch-project-empty">{{ t("sessions.tabs.noProjects") }}</p>
        <DropdownMenuSeparator />
        <DropdownMenuItem class="app-launch-menu-item" :disabled="launching" @select="$emit('new-project')">
          <FolderPlus :size="14" />
          <span><strong>{{ t("sessions.tabs.newProject") }}</strong><small>{{ t("sessions.tabs.addFolderFromNode") }}</small></span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuItem v-else class="app-launch-menu-item" :disabled="launching" @select="$emit('launch', app.id)">
      <AppLaunchIcon :app-id="app.id" />
      <span>
        <strong>{{ app.label }}</strong>
        <small>{{ app.id }}</small>
      </span>
    </DropdownMenuItem>
  </template>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Folder, FolderPlus, Search } from "@lucide/vue";
import type { InstanceBoardItem, NodeLocalFolder } from "../../../api/types";
import { nodeLocalFolderDisplayName } from "../nodePath";
import { filterInstanceCwdFolders, selectableInstanceCwdFolders } from "./instanceCwdFolders";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../../components/ui/dropdown-menu";
import type { LaunchableApp } from "../useInstanceSessions";
import AppLaunchIcon from "./AppLaunchIcon.vue";

const props = withDefaults(defineProps<{
  apps: LaunchableApp[];
  cwdSelection?: boolean;
  folders?: NodeLocalFolder[];
  instance: InstanceBoardItem;
  launching: boolean;
  submenuClass?: string;
}>(), {
  cwdSelection: true,
});
const { t } = useI18n();

defineEmits<{
  launch: [appId: string, cwdFolderId?: string];
  "new-project": [];
}>();

const folderSearch = ref("");
const cwdFolders = computed(() => selectableInstanceCwdFolders(props.instance, props.folders || []));
const filteredCwdFolders = computed(() => filterInstanceCwdFolders(cwdFolders.value, folderSearch.value));

</script>

<style scoped>
:global(.app-launch-menu) {
  display: grid;
  width: min(220px, var(--reka-dropdown-menu-content-available-width));
  max-height: var(--reka-dropdown-menu-content-available-height);
  gap: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

:global(.app-launch-menu-item) {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 42px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--control-plane-menu-text);
  cursor: pointer;
  padding: 0 9px;
  text-align: left;
}

:global(.app-launch-menu-item:hover),
:global(.app-launch-menu-item:focus-visible),
:global(.app-launch-menu-item[data-highlighted]) {
  background: var(--surface-active);
  color: var(--control-plane-menu-hover-text);
  outline: none;
}

:global(.app-launch-menu-item[data-disabled]) {
  cursor: default;
  opacity: 0.52;
}

:global(.app-launch-menu .app-launch-menu-item span) {
  display: grid;
  min-width: 0;
  gap: 2px;
}

:global(.app-launch-menu .app-launch-menu-item strong),
:global(.app-launch-menu .app-launch-menu-item small) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.25;
}

:global(.app-launch-menu .app-launch-menu-item strong) {
  font-size: 12px;
}

:global(.app-launch-menu .app-launch-menu-item small) {
  color: var(--text-muted);
  font-size: 11px;
}

:global(.app-launch-project-search) {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  border-bottom: 1px solid var(--line);
  color: var(--text-muted);
  padding: 0 8px;
}

:global(.app-launch-project-search input) {
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--control-plane-menu-text);
  font-size: 12px;
  outline: none;
}

:global(.app-launch-project-empty) {
  display: grid;
  place-items: center;
  min-height: 64px;
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

:global(.app-launch-menu .app-launch-menu-item strong),
:global(.board-launch-menu .app-launch-menu-item strong) {
  font-weight: 500;
}

:global(.app-launch-menu .app-launch-menu-item small),
:global(.board-launch-menu .app-launch-menu-item small) {
  font-weight: 400;
}
</style>
