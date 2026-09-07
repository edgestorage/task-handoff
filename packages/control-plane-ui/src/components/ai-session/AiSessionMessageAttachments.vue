<template>
  <div
    v-if="attachments.length"
    class="ai-session-message-attachments"
    :class="{ 'ai-session-message-attachments-compact': compact }"
  >
    <TooltipProvider v-if="compact" :delay-duration="200">
      <div class="ai-session-message-attachment-pills">
        <template v-for="attachment in imageAttachments" :key="attachment.id">
          <Tooltip v-if="imageState(attachment).status === 'ready'">
            <TooltipTrigger as-child>
              <button
                class="ai-session-message-attachment-pill image"
                type="button"
                :aria-label="t('sessions.composer.previewImage', { name: attachment.name })"
                @click="preview = attachment"
              >
                <img :src="imageState(attachment).src" :alt="attachment.name" />
                <span>{{ t('sessions.timeline.image') }}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent class="ai-session-compact-image-tooltip" side="bottom" :side-offset="8">
              <img :src="imageState(attachment).src" :alt="attachment.name" />
            </TooltipContent>
          </Tooltip>
          <div
            v-else-if="imageState(attachment).status === 'loading'"
            class="ai-session-message-attachment-pill image-loading"
            role="progressbar"
            :aria-label="attachment.name"
            :aria-valuemin="0"
            :aria-valuemax="100"
            :aria-valuenow="imageState(attachment).progress"
          >
            <LoaderCircle class="image-loading-icon" :size="14" aria-hidden="true" />
            <span>{{ t('sessions.timeline.image') }}</span>
          </div>
          <button
            v-else
            class="ai-session-message-attachment-pill image-error"
            type="button"
            :aria-label="t('sessions.detail.retry')"
            @click="loadImage(attachment)"
          >
            <RotateCcw :size="14" aria-hidden="true" />
            <span>{{ t('sessions.timeline.image') }}</span>
          </button>
        </template>
        <template v-for="attachment in fileAttachments" :key="attachment.id">
          <a
            v-if="attachment.contentState === 'available'"
            class="ai-session-message-attachment-pill file"
            :href="contentUrl(attachment)"
            target="_blank"
            rel="noopener"
            :title="attachment.name"
          >
            <File :size="14" aria-hidden="true" />
            <span>{{ attachment.name }}</span>
          </a>
          <div
            v-else
            class="ai-session-message-attachment-pill unavailable"
            :title="t('sessions.panel.attachmentUnavailable', { name: attachment.name })"
          >
            <FileX :size="14" aria-hidden="true" />
            <span>{{ attachment.name }}</span>
          </div>
        </template>
      </div>
    </TooltipProvider>
    <template v-else>
      <div v-if="imageAttachments.length" class="ai-session-message-images">
        <template v-for="attachment in imageAttachments" :key="attachment.id">
          <ContextMenu v-if="imageState(attachment).status === 'ready'">
            <ContextMenuTrigger as-child>
              <button class="ai-session-message-image" type="button" :aria-label="attachment.name" @click="preview = attachment">
                <img :src="imageState(attachment).src" :alt="attachment.name" />
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem @select="copyImage(attachment)">
                <Copy :size="15" />
                <span>{{ t('sessions.composer.copyImage') }}</span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          <div
            v-else-if="imageState(attachment).status === 'loading'"
            class="ai-session-message-image image-loading"
            role="progressbar"
            :aria-label="attachment.name"
            :aria-valuemin="0"
            :aria-valuemax="100"
            :aria-valuenow="imageState(attachment).progress"
          >
            <LoaderCircle class="image-loading-icon" :size="23" aria-hidden="true" />
            <strong v-if="imageState(attachment).progress !== undefined">{{ imageState(attachment).progress }}%</strong>
            <span v-else>{{ t('sessions.timeline.loading') }}</span>
          </div>
          <button v-else class="ai-session-message-image image-error" type="button" :aria-label="t('sessions.detail.retry')" @click="loadImage(attachment)">
            <RotateCcw :size="19" aria-hidden="true" />
            <span>{{ t('sessions.detail.retry') }}</span>
          </button>
        </template>
      </div>
      <div v-if="fileAttachments.length" class="ai-session-message-files">
        <template v-for="attachment in fileAttachments" :key="attachment.id">
          <a
            v-if="attachment.contentState === 'available'"
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
    </template>
  </div>
  <AiSessionImagePreview
    :open="Boolean(preview)"
    :src="preview ? imageState(preview).src || contentUrl(preview) : undefined"
    :alt="preview?.name"
    :copyable="Boolean(preview)"
    @update:open="(open) => { if (!open) preview = undefined; }"
    @copy="preview && copyImage(preview)"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, Download, File, FileX, LoaderCircle, RotateCcw } from "@lucide/vue";
import type { AiSessionConversationAttachment } from "@task-handoff/protocol/ai-sessions";
import { formatBytes } from "../../i18n/presentation";
import type { SupportedLocale } from "../../i18n/locale";
import { showControlPlaneToast } from "../../apps/control-plane/useControlPlaneToasts";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { acquireAttachmentImage, attachmentImageState, releaseAttachmentImage, retryAttachmentImage } from "./attachmentImageCache";
import AiSessionImagePreview from "./AiSessionImagePreview.vue";

const props = defineProps<{
  instanceId: string;
  sessionId: string;
  messageId: string;
  attachments: AiSessionConversationAttachment[];
  compact?: boolean;
}>();
const { locale, t } = useI18n();
const preview = ref<AiSessionConversationAttachment>();
const imageAttachments = computed(() => props.attachments.filter((attachment) => attachment.kind === "image" && attachment.contentState === "available"));
const fileAttachments = computed(() => props.attachments.filter((attachment) => attachment.kind !== "image" || attachment.contentState !== "available"));
const acquiredImageUrls = new Set<string>();

function imageState(attachment: AiSessionConversationAttachment) {
  return attachmentImageState(contentUrl(attachment));
}

function contentUrl(attachment: AiSessionConversationAttachment) {
  return `/api/controlled-instances/${encodeURIComponent(props.instanceId)}/ai-sessions/${encodeURIComponent(props.sessionId)}/messages/${encodeURIComponent(props.messageId)}/attachments/${encodeURIComponent(attachment.id)}/content`;
}

function formatAttachmentSize(size: number) {
  return formatBytes(size, locale.value as SupportedLocale);
}

function loadImage(attachment: AiSessionConversationAttachment) {
  void retryAttachmentImage(contentUrl(attachment));
}

function syncImages() {
  const nextUrls = new Set(imageAttachments.value.map(contentUrl));
  for (const url of acquiredImageUrls) {
    if (nextUrls.has(url)) continue;
    releaseAttachmentImage(url);
    acquiredImageUrls.delete(url);
  }
  for (const attachment of props.attachments) {
    if (attachment.kind !== "image" || attachment.contentState !== "available") continue;
    const url = contentUrl(attachment);
    if (acquiredImageUrls.has(url)) continue;
    acquiredImageUrls.add(url);
    acquireAttachmentImage(url);
  }
}

watch(() => props.attachments, syncImages, { deep: true, immediate: true });
onBeforeUnmount(() => {
  for (const url of acquiredImageUrls) releaseAttachmentImage(url);
});

async function copyImage(attachment: AiSessionConversationAttachment) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return;
  try {
    const cached = attachmentImageState(contentUrl(attachment)).blob;
    const source = cached || await fetch(contentUrl(attachment)).then((response) => {
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
.ai-session-message-attachments { display: grid; justify-items: end; gap: 8px; max-width: 100%; margin-bottom: 8px; }
.ai-session-message-attachments-compact { justify-items: start; margin-bottom: 0; }
.ai-session-message-attachment-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: 100%; }
.ai-session-message-attachment-pill { box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; max-width: 240px; height: 26px; overflow: hidden; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-subtle); color: var(--text-muted); font-size: 13px; font-weight: 400; line-height: 1; padding: 3px 8px 3px 3px; text-decoration: none; }
.ai-session-message-attachment-pill:is(button, a) { cursor: pointer; }
.ai-session-message-attachment-pill:is(button, a):hover,
.ai-session-message-attachment-pill:is(button, a):focus-visible { border-color: var(--line-strong); background: var(--surface-hover); color: var(--text); outline: none; }
.ai-session-message-attachment-pill img { display: block; width: 18px; height: 18px; flex: 0 0 18px; border-radius: 4px; object-fit: cover; }
.ai-session-message-attachment-pill.file,
.ai-session-message-attachment-pill.unavailable { padding-left: 8px; }
.ai-session-message-attachment-pill span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-session-message-attachment-pill.unavailable { opacity: .72; }
:global(.ai-session-compact-image-tooltip) { width: min(280px, calc(100vw - 24px)); max-height: min(280px, calc(100dvh - 24px)); overflow: hidden; border-radius: 7px; padding: 4px; }
:global(.ai-session-compact-image-tooltip img) { display: block; width: 100%; max-height: 270px; border-radius: 4px; object-fit: contain; }
.ai-session-message-images { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; width: min(100%, 400px); }
.ai-session-message-image { box-sizing: border-box; display: grid; width: 64px; height: 64px; overflow: hidden; place-items: center; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-subtle); color: var(--text-muted); padding: 0; }
.ai-session-message-image:not(.image-loading):not(.image-error) { cursor: zoom-in; }
.ai-session-message-image img { display: block; width: 100%; height: 100%; object-fit: cover; }
.ai-session-message-image.image-loading { align-content: center; gap: 7px; }
.ai-session-message-image.image-loading strong { color: var(--text); font-size: 12px; font-weight: 500; }
.ai-session-message-image.image-loading span,
.ai-session-message-image.image-error span { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.ai-session-message-image.image-error { align-content: center; gap: 7px; cursor: pointer; }
.ai-session-message-image.image-error:hover { border-color: var(--line-strong); background: var(--surface-hover); color: var(--text); }
.ai-session-message-files { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.ai-session-message-attachment { display: flex; align-items: center; gap: 8px; min-width: 0; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--background) 84%, transparent); color: inherit; text-decoration: none; }
.image-loading-icon { animation: ai-session-image-spin 800ms linear infinite; }
.ai-session-message-attachment.file, .ai-session-message-attachment.unavailable { max-width: 280px; padding: 9px 10px; }
.ai-session-message-attachment.file > span, .ai-session-message-attachment.unavailable > span { display: grid; min-width: 0; flex: 1; }
.ai-session-message-attachment strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.ai-session-message-attachment small { font-size: 12px; color: var(--muted-foreground); }
.ai-session-message-attachment.unavailable { opacity: .72; }
@keyframes ai-session-image-spin { to { transform: rotate(360deg); } }
@media (max-width: 620px) {
  .ai-session-message-images { width: min(100%, 232px); }
}
</style>
