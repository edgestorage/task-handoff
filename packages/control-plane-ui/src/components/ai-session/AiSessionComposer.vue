<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ArrowUp, CornerDownRight, Plus, Square, X } from "@lucide/vue";
import { Textarea } from "../ui/textarea";

export type AiSessionComposerAttachment = {
  id: string;
  kind: "image";
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
  file: File;
};

const props = defineProps<{
  modelValue: string;
  attachments?: AiSessionComposerAttachment[];
  busy?: boolean;
  canInterrupt?: boolean;
  error?: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
  (event: "update:attachments", value: AiSessionComposerAttachment[]): void;
  (event: "add-context"): void;
  (event: "run"): void;
  (event: "steer"): void;
}>();

const draft = computed({
  get: () => props.modelValue,
  set: (value: string | number) => emit("update:modelValue", String(value)),
});

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME = new Set(["image/bmp", "image/gif", "image/jpeg", "image/png", "image/webp"]);
const attachmentError = ref("");
const composerEl = ref<HTMLFormElement>();
const inputEl = ref<unknown>();
const attachments = computed(() => props.attachments || []);
const hasDraft = computed(() => props.modelValue.trim().length > 0 || attachments.value.length > 0);
const actionKind = computed(() => hasDraft.value || !props.canInterrupt ? "send" : "stop");
const canRun = computed(() => hasDraft.value || (!props.busy && props.canInterrupt));
const canSteer = computed(() => props.busy && hasDraft.value);
const actionTitle = computed(() => actionKind.value === "stop" ? "Stop current AI turn" : "Send message");

function resizeInput() {
  const value = inputEl.value as { $el?: Element } | HTMLTextAreaElement | undefined;
  const element = value instanceof HTMLTextAreaElement
    ? value
    : value?.$el instanceof HTMLTextAreaElement
      ? value.$el
      : undefined;
  if (!element) {
    return;
  }
  const composer = composerEl.value;
  const maxComposerHeight = composer ? composerMaxHeight(composer) : 0;
  const minInputHeight = Number.parseFloat(getComputedStyle(element).minHeight) || 42;
  const reservedHeight = composer
    ? Array.from(composer.children).reduce((sum, child) => child === element ? sum : sum + child.getBoundingClientRect().height, 0)
    : 0;
  const availableHeight = maxComposerHeight > 0 ? Math.max(minInputHeight, maxComposerHeight - reservedHeight) : Number.POSITIVE_INFINITY;
  element.style.height = "auto";
  const nextHeight = Math.min(element.scrollHeight, availableHeight);
  element.style.height = `${nextHeight}px`;
  element.style.overflowY = element.scrollHeight > availableHeight ? "auto" : "hidden";
}

function composerMaxHeight(composer: HTMLFormElement) {
  const maxHeight = Number.parseFloat(getComputedStyle(composer).maxHeight);
  if (Number.isFinite(maxHeight) && maxHeight > 0) {
    return maxHeight;
  }
  if (composer.scrollHeight > composer.clientHeight) {
    return composer.getBoundingClientRect().height;
  }
  return 0;
}

watch(() => props.modelValue, () => {
  void nextTick(resizeInput);
}, { immediate: true });

watch(attachments, () => {
  void nextTick(resizeInput);
});

function imageFiles(files: File[]) {
  return files.filter((file) => file.type.startsWith("image/") || !file.type);
}

function validateImageFiles(files: File[]) {
  const accepted: File[] = [];
  const currentBytes = attachments.value.reduce((sum, attachment) => sum + attachment.size, 0);
  let nextBytes = currentBytes;
  for (const file of files) {
    const mime = file.type || "image/png";
    if (!SUPPORTED_IMAGE_MIME.has(mime)) {
      attachmentError.value = "仅支持 PNG、JPG、WEBP、GIF、BMP 图片。";
      continue;
    }
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      attachmentError.value = "单张图片不能超过 20MB。";
      continue;
    }
    if (attachments.value.length + accepted.length >= MAX_ATTACHMENTS) {
      attachmentError.value = "最多只能添加 6 张图片。";
      continue;
    }
    if (nextBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      attachmentError.value = "单条消息图片总大小不能超过 40MB。";
      continue;
    }
    nextBytes += file.size;
    accepted.push(file);
  }
  return accepted;
}

function addFiles(files: File[]) {
  const images = validateImageFiles(imageFiles(files));
  if (!images.length) {
    return;
  }
  void Promise.all(images.map(readAttachment)).then((items) => {
    attachmentError.value = "";
    emit("update:attachments", [...attachments.value, ...items]);
  });
}

function readAttachment(file: File): Promise<AiSessionComposerAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve({
        id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        kind: "image",
        name: file.name || "image.png",
        mime: file.type || "image/png",
        size: file.size,
        dataUrl: String(reader.result || ""),
        file,
      });
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("Failed to read image.")));
    reader.readAsDataURL(file);
  });
}

function removeAttachment(id: string) {
  attachmentError.value = "";
  emit("update:attachments", attachments.value.filter((attachment) => attachment.id !== id));
}

function handlePaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files || []);
  if (!files.length) {
    return;
  }
  const images = imageFiles(files);
  if (!images.length) {
    return;
  }
  event.preventDefault();
  addFiles(images);
}

function handleDrop(event: DragEvent) {
  const files = Array.from(event.dataTransfer?.files || []);
  const images = imageFiles(files);
  if (!images.length) {
    return;
  }
  event.preventDefault();
  addFiles(images);
}

function submit() {
  if (canRun.value) {
    emit("run");
  }
}

function handleInputKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }
  event.preventDefault();
  submit();
}
</script>

<template>
  <form ref="composerEl" class="ai-session-composer" @drop="handleDrop" @dragover.prevent @submit.prevent="submit">
    <div v-if="attachments.length" class="ai-session-composer__attachments">
      <figure v-for="attachment in attachments" :key="attachment.id">
        <img :alt="attachment.name" :src="attachment.dataUrl" />
        <button type="button" title="Remove image" aria-label="Remove image" @click="removeAttachment(attachment.id)">
          <X :size="14" />
        </button>
      </figure>
    </div>
    <Textarea
      ref="inputEl"
      v-model="draft"
      class="ai-session-composer__input"
      :placeholder="placeholder || 'Ask for follow-up changes'"
      rows="3"
      @keydown="handleInputKeydown"
      @input="resizeInput"
      @paste="handlePaste"
    />
    <div class="ai-session-composer__toolbar">
      <button
        type="button"
        class="ai-session-composer__tool"
        title="Add context"
        @click="emit('add-context')"
      >
        <Plus :size="18" />
      </button>
      <div class="ai-session-composer__actions">
        <button
          v-if="canSteer"
          type="button"
          class="ai-session-composer__tool"
          title="Steer current AI turn"
          @click="emit('steer')"
        >
          <CornerDownRight :size="18" />
        </button>
        <button
          type="submit"
          class="ai-session-composer__primary"
          :data-action="actionKind"
          :disabled="!canRun"
          :title="actionTitle"
        >
          <ArrowUp v-if="actionKind === 'send'" :size="18" />
          <Square v-else :size="16" />
        </button>
      </div>
    </div>
    <p v-if="attachmentError || error" class="ai-session-composer__error">{{ attachmentError || error }}</p>
  </form>
</template>

<style scoped>
.ai-session-composer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-height: min(360px, calc(100vh - 96px));
  overflow: hidden;
  border: 1px solid var(--ai-composer-border, var(--border));
  border-radius: var(--ai-composer-radius, 20px);
  background: var(--ai-composer-bg, var(--background));
  box-shadow: var(--ai-composer-shadow, none);
  --ai-composer-scrollbar-thumb: color-mix(in srgb, var(--ai-composer-text, currentColor) 22%, transparent);
  --ai-composer-scrollbar-thumb-hover: color-mix(in srgb, var(--ai-composer-text, currentColor) 34%, transparent);
}

.ai-session-composer__attachments {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  padding: 10px 12px 0;
  scrollbar-color: var(--ai-composer-scrollbar-thumb) transparent;
  scrollbar-width: thin;
}

.ai-session-composer__attachments::-webkit-scrollbar {
  height: 10px;
}

.ai-session-composer__attachments::-webkit-scrollbar-track {
  background: transparent;
}

.ai-session-composer__attachments::-webkit-scrollbar-thumb {
  min-width: 32px;
  border: 1px solid transparent;
  border-radius: 999px;
  background-clip: content-box;
  background-color: var(--ai-composer-scrollbar-thumb);
  transition: background-color 0.16s ease;
}

.ai-session-composer__attachments::-webkit-scrollbar-thumb:hover {
  background-color: var(--ai-composer-scrollbar-thumb-hover);
}

.ai-session-composer__attachments figure {
  position: relative;
  flex: 0 0 auto;
  width: 72px;
  height: 72px;
  overflow: hidden;
  border: 1px solid var(--ai-composer-border, var(--border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--ai-composer-bg, var(--background)) 80%, var(--ai-composer-text, currentColor));
  margin: 0;
}

.ai-session-composer__attachments img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.ai-session-composer__attachments button {
  position: absolute;
  top: 4px;
  right: 4px;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border: 0;
  border-radius: 999px;
  background: rgb(0 0 0 / 72%);
  color: white;
  cursor: pointer;
  padding: 0;
}

.ai-session-composer__input {
  min-height: 72px;
  max-height: none;
  flex: 0 0 auto;
  overflow: hidden;
  border: 0;
  background: transparent;
  box-shadow: none;
  color: var(--ai-composer-text, currentColor);
  font-size: 14px;
  line-height: 1.45;
  padding: 12px 18px 8px;
  resize: none;
  scrollbar-color: var(--ai-composer-scrollbar-thumb) transparent;
  scrollbar-width: thin;
}

.ai-session-composer__input::-webkit-scrollbar {
  width: 10px;
}

.ai-session-composer__input::-webkit-scrollbar-track {
  background: transparent;
}

.ai-session-composer__input::-webkit-scrollbar-thumb {
  min-height: 32px;
  border: 1px solid transparent;
  border-radius: 999px;
  background-clip: content-box;
  background-color: var(--ai-composer-scrollbar-thumb);
  transition: background-color 0.16s ease;
}

.ai-session-composer__input::-webkit-scrollbar-thumb:hover {
  background-color: var(--ai-composer-scrollbar-thumb-hover);
}

.ai-session-composer__input:focus-visible {
  outline: none;
  box-shadow: none;
}

.ai-session-composer__toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 8px 10px 10px;
}

.ai-session-composer__actions {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.ai-session-composer__tool,
.ai-session-composer__primary {
  display: inline-grid;
  place-items: center;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}

.ai-session-composer__tool {
  width: 32px;
  height: 32px;
  background: transparent;
  color: var(--ai-composer-muted, currentColor);
}

.ai-session-composer__primary {
  width: 34px;
  height: 34px;
  background: var(--ai-composer-primary-bg, var(--primary));
  color: var(--ai-composer-primary-text, var(--primary-foreground));
}

.ai-session-composer__primary[data-action="stop"] {
  background: var(--ai-composer-stop-bg, var(--destructive));
  color: var(--ai-composer-stop-text, var(--destructive-foreground));
}

.ai-session-composer__primary:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ai-session-composer__error {
  flex: 0 0 auto;
  margin: 0;
  padding: 0 14px 10px;
  color: var(--ai-composer-danger, var(--status-danger));
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

</style>
