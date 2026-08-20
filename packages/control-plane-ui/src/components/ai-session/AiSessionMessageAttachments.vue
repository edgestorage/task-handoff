<template>
  <div v-if="attachments.length" class="ai-session-message-attachments">
    <template v-for="attachment in attachments" :key="attachment.id">
      <ContextMenu v-if="attachment.kind === 'image' && attachment.contentState === 'available'">
        <ContextMenuTrigger as-child>
          <button class="ai-session-message-attachment image" type="button" @click="preview = attachment">
            <img :src="contentUrl(attachment)" :alt="attachment.name" />
            <span>{{ attachment.name }}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem @select="copyImage(attachment)">
            <Copy :size="15" />
            <span>{{ t('sessions.composer.copyImage') }}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <a
        v-else-if="attachment.contentState === 'available'"
        class="ai-session-message-attachment file"
        :href="contentUrl(attachment)"
        target="_blank"
        rel="noopener"
      >
        <File :size="18" />
        <span><strong>{{ attachment.name }}</strong><small>{{ formatAttachmentSize(attachment.size) }}</small></span>
        <Download :size="14" />
      </a>
      <div v-else class="ai-session-message-attachment unavailable" :title="t('sessions.panel.attachmentUnavailable', { name: attachment.name })">
        <FileX :size="18" />
        <span><strong>{{ attachment.name }}</strong><small>{{ t(`sessions.timeline.attachment${attachment.contentState === 'expired' ? 'Expired' : 'Missing'}`) }}</small></span>
      </div>
    </template>
  </div>
  <Dialog :open="Boolean(preview)" @update:open="(open) => { if (!open) preview = undefined; }">
    <DialogContent class="ai-session-message-attachment-dialog">
      <DialogTitle class="sr-only">{{ preview?.name }}</DialogTitle>
      <ContextMenu v-if="preview">
        <ContextMenuTrigger as-child>
          <img :src="contentUrl(preview)" :alt="preview.name" />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem @select="copyImage(preview)">
            <Copy :size="15" />
            <span>{{ t('sessions.composer.copyImage') }}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, Download, File, FileX } from "@lucide/vue";
import type { AiSessionConversationAttachment } from "@task-handoff/protocol/ai-sessions";
import { formatBytes } from "../../i18n/presentation";
import type { SupportedLocale } from "../../i18n/locale";
import { showControlPlaneToast } from "../../apps/control-plane/useControlPlaneToasts";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";

const props = defineProps<{
  instanceId: string;
  sessionId: string;
  messageId: string;
  attachments: AiSessionConversationAttachment[];
}>();
const { locale, t } = useI18n();
const preview = ref<AiSessionConversationAttachment>();

function contentUrl(attachment: AiSessionConversationAttachment) {
  return `/api/controlled-instances/${encodeURIComponent(props.instanceId)}/ai-sessions/${encodeURIComponent(props.sessionId)}/messages/${encodeURIComponent(props.messageId)}/attachments/${encodeURIComponent(attachment.id)}/content`;
}

function formatAttachmentSize(size: number) {
  return formatBytes(size, locale.value as SupportedLocale);
}

async function copyImage(attachment: AiSessionConversationAttachment) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return;
  try {
    const source = await fetch(contentUrl(attachment)).then((response) => {
      if (!response.ok) throw new Error("attachment unavailable");
      return response.blob();
    });
    const blob = source.type === "image/png" ? source : await imageBlobAsPng(source);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    showControlPlaneToast(t("sessions.composer.imageCopied"));
  } catch {
    showControlPlaneToast(t("sessions.composer.copyImageFailed"));
  }
}

async function imageBlobAsPng(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG conversion failed.")), "image/png"));
  } finally {
    bitmap.close();
  }
}
</script>

<style scoped>
.ai-session-message-attachments { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.ai-session-message-attachment { display: flex; align-items: center; gap: 8px; min-width: 0; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--background) 84%, transparent); color: inherit; text-decoration: none; }
.ai-session-message-attachment.image { width: 132px; height: 104px; padding: 6px; flex-direction: column; cursor: zoom-in; }
.ai-session-message-attachment.image img { width: 100%; min-height: 0; flex: 1; object-fit: contain; border-radius: 6px; }
.ai-session-message-attachment.image span { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.ai-session-message-attachment.file, .ai-session-message-attachment.unavailable { max-width: 280px; padding: 9px 10px; }
.ai-session-message-attachment.file > span, .ai-session-message-attachment.unavailable > span { display: grid; min-width: 0; flex: 1; }
.ai-session-message-attachment strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.ai-session-message-attachment small { font-size: 12px; color: var(--muted-foreground); }
.ai-session-message-attachment.unavailable { opacity: .72; }
:global(.ai-session-message-attachment-dialog) { width: min(92vw, 1040px); max-width: min(92vw, 1040px); height: min(88vh, 820px); padding: 18px; }
:global(.ai-session-message-attachment-dialog img) { width: 100%; height: 100%; object-fit: contain; }
</style>
