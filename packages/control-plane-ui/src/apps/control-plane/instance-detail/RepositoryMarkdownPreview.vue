<template>
  <ScrollArea type="always" class="repository-markdown-scroll">
    <article class="repository-markdown-document" @click.capture="handleLinkClick" @auxclick.capture="handleLinkClick">
      <MarkdownContent :content="content" :code-tools="codeTools" :resolve-image-src="resolveImageSrc" />
    </article>
  </ScrollArea>
</template>

<script setup lang="ts">
import type { RepositoryContext } from "@task-handoff/protocol/repository";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { repositoryFileContentUrl, type RepositorySessionTarget } from "../../../api/repository";
import { classifyMarkdownLink } from "../../../components/ai-session/markdown-link-target";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { openDesktopExternalUrl } from "../../../lib/desktopBridge";
import type { RepositoryFileLocation } from "./repositoryFilePath";

const props = defineProps<{ content: string; context: RepositoryContext; path: string; target: RepositorySessionTarget; fileContentSupported: boolean }>();
const emit = defineEmits<{ openFile: [location: RepositoryFileLocation] }>();
const { t } = useI18n();
const codeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));
const documentContext = computed(() => ({
  ...props.context,
  cwdRelativePath: props.path.includes("/") ? props.path.slice(0, props.path.lastIndexOf("/")) : "",
}));

function resolveImageSrc(href: string) {
  if (href.startsWith("#")) return undefined;
  const target = classifyMarkdownLink(href, documentContext.value);
  if (target.kind === "web") return target.url;
  if (target.kind === "file" && props.fileContentSupported) return repositoryFileContentUrl(props.target, target.path);
  return undefined;
}

async function handleLinkClick(event: MouseEvent) {
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : undefined;
  const href = anchor?.getAttribute("href")?.trim();
  if (!href) return;
  // A repository link belongs to the instance, never the Control Plane web origin.
  event.preventDefault();
  event.stopPropagation();
  const fragment = href.startsWith("#");
  const target = classifyMarkdownLink(
    fragment ? `${props.path}${href}` : href,
    fragment ? { ...props.context, cwdRelativePath: "" } : documentContext.value,
  );
  if (fragment && target.kind === "file" && target.line === undefined) return;
  if (target.kind === "web") {
    const result = await openDesktopExternalUrl(target.url);
    if (!result.ok) window.open(target.url, "_blank", "noopener,noreferrer");
  } else if (target.kind === "file") {
    emit("openFile", { path: target.path, line: target.line, column: target.column });
  }
}
</script>

<style scoped>
.repository-markdown-scroll { width: 100%; height: 100%; min-width: 0; min-height: 0; background: var(--workspace-bg); }
.repository-markdown-document { width: 100%; max-width: 900px; min-width: 0; margin: 0 auto; padding: 24px; color: var(--text); font-size: 13px; font-weight: 400; -webkit-user-select: text; user-select: text; --markdown-text-color: var(--text); }
@container (max-width: 480px) { .repository-markdown-document { padding: 16px; } }
</style>
