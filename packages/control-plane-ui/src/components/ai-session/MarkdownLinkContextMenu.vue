<template>
  <ContextMenu>
    <div class="markdown-link-menu-host" @contextmenu.capture="captureContextMenu" @contextmenu="handleLinkContextMenu">
      <ContextMenuTrigger as-child :disabled="!target">
        <div class="markdown-link-menu-content"><slot /></div>
      </ContextMenuTrigger>
    </div>
    <ContextMenuContent v-if="target" class="markdown-link-context-menu">
      <ContextMenuItem v-if="target.kind === 'file' && desktopFilePath(target)" class="markdown-link-context-menu-item" @select="openDesktopFile(desktopFilePath(target)!)">
        <FolderOpen :size="14" />{{ props.labels.openDesktopFile }}
      </ContextMenuItem>
      <ContextMenuItem v-if="target.kind === 'file' && props.onOpenFile" class="markdown-link-context-menu-item" @select="props.onOpenFile(target)">
        <FolderOpen :size="14" />{{ props.labels.openFile }}
      </ContextMenuItem>
      <ContextMenuItem v-if="target.kind === 'file'" class="markdown-link-context-menu-item" @select="copy(target.path)">
        <Copy :size="14" />{{ props.labels.copyPath }}
      </ContextMenuItem>
      <template v-if="target.kind === 'web'">
        <ContextMenuItem v-if="props.onOpenBuiltinBrowser" class="markdown-link-context-menu-item" @select="props.onOpenBuiltinBrowser(target.url)">
          <PanelTop :size="14" />{{ props.labels.openBuiltinBrowser }}
        </ContextMenuItem>
        <ContextMenuItem class="markdown-link-context-menu-item" @select="openDefaultBrowser(target.url)">
          <ExternalLink :size="14" />{{ props.labels.openDefaultBrowser }}
        </ContextMenuItem>
        <ContextMenuItem class="markdown-link-context-menu-item" @select="copy(target.url)">
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
import { canRevealDesktopLocalPath, openDesktopExternalUrl, revealDesktopLocalPath } from "../../lib/desktopBridge";
import { classifyMarkdownLink, resolveRuntimeFilePath, type MarkdownLinkTarget } from "./markdown-link-target";
import type { RepositoryContext } from "@task-handoff/protocol/repository";

const target = ref<MarkdownLinkTarget>();

const props = defineProps<{
  labels: { openFile: string; openDesktopFile: string; copyPath: string; openBuiltinBrowser: string; openDefaultBrowser: string; copyLink: string };
  repositoryContext?: RepositoryContext;
  runtimeCwd?: string;
  runtimePathAccess?: "desktop-local";
  onOpenFile?: (target: Extract<MarkdownLinkTarget, { kind: "file" }>) => void | Promise<void>;
  onOpenBuiltinBrowser?: (url: string) => void | Promise<void>;
}>();

function captureContextMenu(event: MouseEvent) {
  target.value = undefined;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : undefined;
  const href = anchor?.getAttribute("href")?.trim();
  if (!href) {
    return;
  }
  const classified = classifyMarkdownLink(href, props.repositoryContext);
  if (classified.kind === "unsupported") {
    return;
  }
  target.value = classified;
}

function handleLinkContextMenu(event: MouseEvent) {
  if (!target.value) return;
  // The trigger has already handled this event. Stop it here so the surrounding
  // response menu does not also open, while ordinary text keeps bubbling.
  event.stopPropagation();
}

async function copy(value: string) {
  await navigator.clipboard?.writeText(value);
}

function desktopFilePath(target: Extract<MarkdownLinkTarget, { kind: "file" }>) {
  if (props.runtimePathAccess !== "desktop-local" || !canRevealDesktopLocalPath()) return undefined;
  return resolveRuntimeFilePath(target.path, props.runtimeCwd);
}

async function openDesktopFile(path: string) { await revealDesktopLocalPath(path); }

async function openDefaultBrowser(url: string) {
  const result = await openDesktopExternalUrl(url);
  if (!result.ok && typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
}
</script>

<style scoped>
.markdown-link-menu-host { display: contents; }
.markdown-link-menu-content { display: contents; }
</style>

<style>
.markdown-link-context-menu.markdown-link-context-menu {
  border: 1px solid var(--ai-board-column-border);
  -webkit-backdrop-filter: blur(16px) saturate(1.16);
  backdrop-filter: blur(16px) saturate(1.16);
}

.markdown-link-context-menu .markdown-link-context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
}

.markdown-link-context-menu .markdown-link-context-menu-item > svg {
  flex: 0 0 auto;
}
</style>
