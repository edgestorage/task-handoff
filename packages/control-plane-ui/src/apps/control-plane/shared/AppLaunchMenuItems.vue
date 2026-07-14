<template>
  <template v-for="app in apps" :key="app.id">
    <DropdownMenuSub v-if="app.supportsCwdSelection && cwdFolders.length">
      <DropdownMenuSubTrigger class="app-launch-menu-item" :disabled="launching" @click.prevent.stop="$emit('launch', app.id)">
        <Play :size="14" />
        <span>
          <strong>{{ app.label }}</strong>
          <small>{{ app.id }}</small>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent class="app-launch-menu">
        <DropdownMenuItem v-for="folder in cwdFolders" :key="`${app.id}-${folder.id}`" class="app-launch-menu-item" :disabled="launching" @select="$emit('launch', app.id, folder.id)">
          <Folder :size="14" />
          <span>
            <strong>{{ folder.name }}</strong>
            <small>{{ folder.path }}</small>
          </span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuItem v-else class="app-launch-menu-item" :disabled="launching" @select="$emit('launch', app.id)">
      <Play :size="14" />
      <span>
        <strong>{{ app.label }}</strong>
        <small>{{ app.id }}</small>
      </span>
    </DropdownMenuItem>
  </template>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Folder, Play } from "@lucide/vue";
import type { InstanceBoardItem, NodeLocalFolder } from "../../../api/types";
import { isSameOrChildNodePath } from "../nodePath";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../../components/ui/dropdown-menu";
import type { LaunchableApp } from "../useInstanceSessions";

const props = defineProps<{
  apps: LaunchableApp[];
  folders?: NodeLocalFolder[];
  instance: InstanceBoardItem;
  launching: boolean;
}>();

defineEmits<{
  launch: [appId: string, cwdFolderId?: string];
}>();

const cwdFolders = computed(() => {
  const folders = props.folders || [];
  if (isLocalRuntime()) {
    return folders;
  }
  const source = props.instance.source;
  if (source.type !== "local-folder") {
    return [];
  }
  return folders.filter((folder) => isSameOrChildNodePath(folder.path, source.path));
});

function isLocalRuntime() {
  return props.instance.runtime?.type === "local" || props.instance.runtime.kind === "local";
}

</script>
