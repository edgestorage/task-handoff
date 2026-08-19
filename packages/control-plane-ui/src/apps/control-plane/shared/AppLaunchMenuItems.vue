<template>
  <template v-for="app in apps" :key="app.id">
    <DropdownMenuSub v-if="app.supportsCwdSelection">
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
            <strong>{{ folder.name }}</strong>
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
import { isSameOrChildNodePath } from "../nodePath";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../../components/ui/dropdown-menu";
import type { LaunchableApp } from "../useInstanceSessions";
import AppLaunchIcon from "./AppLaunchIcon.vue";

const props = defineProps<{
  apps: LaunchableApp[];
  folders?: NodeLocalFolder[];
  instance: InstanceBoardItem;
  launching: boolean;
  submenuClass?: string;
}>();
const { t } = useI18n();

defineEmits<{
  launch: [appId: string, cwdFolderId?: string];
  "new-project": [];
}>();

const folderSearch = ref("");
const cwdFolders = computed(() => {
  const uniqueFolders = [...new Map((props.folders || []).map((folder) => [folder.id, folder])).values()];
  if (isLocalRuntime()) {
    return uniqueFolders;
  }
  const source = props.instance.source;
  if (source.type !== "local-folder") {
    return [];
  }
  return uniqueFolders.filter((folder) => isSameOrChildNodePath(folder.path, source.path));
});
const filteredCwdFolders = computed(() => {
  const query = folderSearch.value.trim().toLowerCase();
  return cwdFolders.value.filter((folder) => !query || `${folder.name} ${folder.path}`.toLowerCase().includes(query));
});
function isLocalRuntime() {
  return props.instance.runtime?.type === "local" || props.instance.runtime.kind === "local";
}

</script>

<style scoped>
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
</style>
