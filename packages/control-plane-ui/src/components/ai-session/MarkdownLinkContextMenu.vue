<template>
  <ContextMenu v-model:open="open">
    <div class="markdown-link-menu-host" @contextmenu.capture="captureContextMenu">
      <ContextMenuTrigger as-child>
        <div class="markdown-link-menu-content"><slot /></div>
      </ContextMenuTrigger>
    </div>
    <ContextMenuContent v-if="target" class="markdown-link-context-menu">
      <ContextMenuItem v-if="target.kind === 'file' && isAbsolutePath(target.path)" @select="openDesktopFile(target.path)">
        <FolderOpen :size="14" />{{ props.labels.openDesktopFile }}
      </ContextMenuItem>
      <ContextMenuItem v-if="target.kind === 'file' && props.onOpenFile" @select="props.onOpenFile(target)">
        <FolderOpen :size="14" />{{ props.labels.openFile }}
      </ContextMenuItem>
      <ContextMenuItem v-if="target.kind === 'file'" @select="copy(target.path)">
        <Copy :size="14" />{{ props.labels.copyPath }}
      </ContextMenuItem>
      <template v-if="target.kind === 'web'">
        <ContextMenuItem v-if="props.onOpenBuiltinBrowser" @select="props.onOpenBuiltinBrowser(target.url)">
          <PanelTop :size="14" />{{ props.labels.openBuiltinBrowser }}
        </ContextMenuItem>
        <ContextMenuItem @select="openDefaultBrowser(target.url)">
          <ExternalLink :size="14" />{{ props.labels.openDefaultBrowser }}
        </ContextMenuItem>
        <ContextMenuItem @select="copy(target.url)">
          <Copy :size="14" />{{ props.labels.copyLink }}
        </ContextMenuItem>
      </template>
    </ContextMenuContent>
  </ContextMenu>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Copy, ExternalLink, FolderOpen, PanelTop } from "@lucide/vue";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";
import { openDesktopExternalUrl } from "../../lib/desktopBridge";
import { revealDesktopLocalPath } from "../../lib/desktopBridge";
import { classifyMarkdownLink, type MarkdownLinkTarget } from "./markdown-link-target";
import type { RepositoryContext } from "@task-handoff/protocol/repository";

const open = ref(false);
const target = ref<MarkdownLinkTarget>();

const props = defineProps<{
  labels: { openFile: string; openDesktopFile: string; copyPath: string; openBuiltinBrowser: string; openDefaultBrowser: string; copyLink: string };
  repositoryContext?: RepositoryContext;
  onOpenFile?: (target: Extract<MarkdownLinkTarget, { kind: "file" }>) => void | Promise<void>;
  onOpenBuiltinBrowser?: (url: string) => void | Promise<void>;
}>();

function captureContextMenu(event: MouseEvent) {
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : undefined;
  const href = anchor?.getAttribute("href")?.trim();
  if (!href) {
    event.stopPropagation();
    open.value = false;
    return;
  }
  target.value = classifyMarkdownLink(href, props.repositoryContext);
  if (target.value.kind === "unsupported") { event.stopPropagation(); open.value = false; return; }
  event.preventDefault();
}

async function copy(value: string) {
  await navigator.clipboard?.writeText(value);
}

function isAbsolutePath(value: string) { return value.startsWith("/") || /^[a-z]:[\\/]/i.test(value); }
async function openDesktopFile(path: string) { await revealDesktopLocalPath(path); }

async function openDefaultBrowser(url: string) {
  const result = await openDesktopExternalUrl(url);
  if (!result.ok && typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
}
</script>

<style scoped>
.markdown-link-menu-host { display: contents; }
.markdown-link-menu-content { display: contents; }
.markdown-link-context-menu :deep(svg) { margin-right: 8px; }
</style>
