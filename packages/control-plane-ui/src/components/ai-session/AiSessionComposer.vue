<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { AppWindow, ArrowUp, Box, CornerDownRight, File, Folder, Minimize2, Pencil, Plus, Puzzle, ScanSearch, Square, Target, WandSparkles, X } from "@lucide/vue";
import { PopoverAnchor } from "reka-ui";
import type { AiSessionMentionCandidate } from "../../api/types";
import type { AiSessionCommandInput } from "@task-handoff/protocol/ai-sessions";
import { Popover, PopoverContent } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { mentionTokenAt, reconcileMentionBindings, replaceMentionToken, type AiSessionMentionBinding } from "./mentions";
import { commandTokenAt, matchingCommands, parseAiSessionCommand, replaceCommandToken, type AiSessionCommandCandidate } from "./commands";
import { useAiSessionMentions, type AiSessionMentionContext } from "./useAiSessionMentions";

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
  mentionBindings?: AiSessionMentionBinding[];
  mentionContext?: AiSessionMentionContext;
  mentionTrigger?: string;
  commandTrigger?: string;
  sessionBusy?: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
  (event: "update:attachments", value: AiSessionComposerAttachment[]): void;
  (event: "update:mentionBindings", value: AiSessionMentionBinding[]): void;
  (event: "add-context"): void;
  (event: "run"): void;
  (event: "steer"): void;
  (event: "command", value: AiSessionCommandInput): void;
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
const mentionBindings = computed(() => props.mentionBindings || []);
const mentionTrigger = computed(() => props.mentionTrigger || "@");
const commandTrigger = computed(() => props.commandTrigger || "/");
const mentions = useAiSessionMentions(() => props.mentionContext);
const activeMentionIndex = ref(0);
const commandOpen = ref(false);
const commandQuery = ref("");
const activeCommandIndex = ref(0);
const commandCandidates = computed(() => matchingCommands(commandQuery.value));
const overlayOpen = computed(() => !props.busy && (mentions.open.value || commandOpen.value));
const mentionPopoverRadius = ref("20px");
const mentionKinds = ["plugin", "skill", "file", "directory", "app"] as const;
const mentionLabels = { plugin: "Plugins", skill: "Skills", file: "Files", directory: "Directories", app: "Apps" } as const;
const groupedMentionCandidates = computed(() => mentionKinds.map((kind) => ({
  kind,
  label: mentionLabels[kind],
  candidates: mentions.candidates.value.filter((candidate) => candidate.kind === kind),
  diagnostics: mentions.diagnostics.value.filter((diagnostic) => diagnostic.category === (kind === "skill" ? "skills" : kind === "plugin" ? "plugins" : kind === "app" ? "apps" : "files")),
})).filter((group) => group.candidates.length || group.diagnostics.length));
const hasDraft = computed(() => props.modelValue.trim().length > 0 || attachments.value.length > 0);
const actionKind = computed(() => hasDraft.value || !props.canInterrupt ? "send" : "stop");
const canRun = computed(() => hasDraft.value || (!props.busy && props.canInterrupt));
const canSteer = computed(() => props.busy && hasDraft.value);
const actionTitle = computed(() => actionKind.value === "stop" ? "Stop current AI turn" : "Send message");

function resizeInput() {
  const element = textareaElement();
  if (!element) {
    return;
  }
  const composer = composerEl.value;
  const maxComposerHeight = composer ? composerMaxHeight(composer) : 0;
  const minInputHeight = Number.parseFloat(getComputedStyle(element).minHeight) || 42;
  const reservedHeight = composer
    ? Array.from(composer.children).reduce((sum, child) => child === element || child.contains(element) ? sum : sum + child.getBoundingClientRect().height, 0)
    : 0;
  const availableHeight = maxComposerHeight > 0 ? Math.max(minInputHeight, maxComposerHeight - reservedHeight) : Number.POSITIVE_INFINITY;
  element.style.height = "auto";
  const nextHeight = Math.min(element.scrollHeight, availableHeight);
  element.style.height = `${nextHeight}px`;
  element.style.overflowY = element.scrollHeight > availableHeight ? "auto" : "hidden";
}

function textareaElement() {
  const value = inputEl.value as { $el?: Element } | HTMLTextAreaElement | undefined;
  return value instanceof HTMLTextAreaElement
    ? value
    : value?.$el instanceof HTMLTextAreaElement
      ? value.$el
      : undefined;
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
  if (props.busy) {
    return;
  }
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
  if (props.busy) {
    return;
  }
  attachmentError.value = "";
  emit("update:attachments", attachments.value.filter((attachment) => attachment.id !== id));
}

function handlePaste(event: ClipboardEvent) {
  if (props.busy) {
    return;
  }
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
  if (props.busy) {
    return;
  }
  const files = Array.from(event.dataTransfer?.files || []);
  const images = imageFiles(files);
  if (!images.length) {
    return;
  }
  event.preventDefault();
  addFiles(images);
}

function submit() {
  if (!props.busy && canRun.value) {
    const command = parseAiSessionCommand(props.modelValue.trim(), commandTrigger.value, props.mentionContext?.provider);
    if (command) {
      emit("command", command);
      return;
    }
    emit("run");
  }
}

function handleInputKeydown(event: KeyboardEvent) {
  if (props.busy) return;
  if (event.isComposing) return;
  if (commandOpen.value) {
    const command = commandCandidates.value[activeCommandIndex.value];
    if ((event.key === "Enter" || event.key === "Tab") && command && !(props.sessionBusy && command.requiresIdle)) {
      event.preventDefault();
      selectCommand(command);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      commandOpen.value = false;
      return;
    }
  }
  if (mentions.open.value) {
    if ((event.key === "Enter" || event.key === "Tab") && mentions.candidates.value[activeMentionIndex.value]) {
      event.preventDefault();
      selectMention(mentions.candidates.value[activeMentionIndex.value]!);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      mentions.close();
      return;
    }
  }
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }
  event.preventDefault();
  submit();
}

function moveActiveMention(direction: 1 | -1) {
  if (props.busy) return;
  if (commandOpen.value) {
    const length = commandCandidates.value.length;
    if (!length) return;
    activeCommandIndex.value = (activeCommandIndex.value + direction + length) % length;
    void nextTick(() => document.querySelector(".ai-session-mention-popover__item--active")?.scrollIntoView({ block: "nearest" }));
    return;
  }
  if (!mentions.open.value) return;
  const length = mentions.candidates.value.length;
  if (!length) return;
  activeMentionIndex.value = (activeMentionIndex.value + direction + length) % length;
  void nextTick(() => document.querySelector(".ai-session-mention-popover__item--active")?.scrollIntoView({ block: "nearest" }));
}

function handleComposerInput(event: Event) {
  const element = event.target as HTMLTextAreaElement;
  emit("update:mentionBindings", reconcileMentionBindings(element.value, mentionBindings.value));
  updateOverlayMenu(element.value, element.selectionStart);
  resizeInput();
}

function handleInputKeyup(event: KeyboardEvent) {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    updateOverlayMenu();
  }
}

function updateOverlayMenu(value = props.modelValue, cursor = textareaElement()?.selectionStart ?? value.length) {
  if (props.busy) {
    mentions.close();
    commandOpen.value = false;
    return;
  }
  const commandToken = commandTokenAt(value, cursor, commandTrigger.value);
  if (commandToken && props.mentionContext?.provider === "codex") {
    mentions.close();
    commandOpen.value = true;
    commandQuery.value = commandToken.query;
    activeCommandIndex.value = 0;
    mentionPopoverRadius.value = composerEl.value ? getComputedStyle(composerEl.value).borderRadius : "20px";
    return;
  }
  commandOpen.value = false;
  const token = mentionTokenAt(value, cursor, mentionTrigger.value);
  if (!token) {
    mentions.close();
    return;
  }
  activeMentionIndex.value = 0;
  mentionPopoverRadius.value = composerEl.value ? getComputedStyle(composerEl.value).borderRadius : "20px";
  void mentions.show(token.query);
}

function selectCommand(command: AiSessionCommandCandidate, event?: Event) {
  event?.preventDefault();
  if (props.busy) return;
  if (props.sessionBusy && command.requiresIdle) return;
  const element = textareaElement();
  const result = replaceCommandToken(element?.value ?? props.modelValue, element?.selectionStart ?? props.modelValue.length, commandTrigger.value, command);
  if (!result) return;
  emit("update:modelValue", result.value);
  commandOpen.value = false;
  void nextTick(() => {
    const textarea = textareaElement();
    textarea?.focus();
    textarea?.setSelectionRange(result.cursor, result.cursor);
    resizeInput();
  });
}

function commandIcon(command: AiSessionCommandCandidate) {
  if (command.name === "review") return ScanSearch;
  if (command.name === "rename") return Pencil;
  if (command.name === "goal") return Target;
  return Minimize2;
}

function selectMention(candidate: AiSessionMentionCandidate, event?: Event) {
  event?.preventDefault();
  if (props.busy) return;
  const element = textareaElement();
  const result = replaceMentionToken({
    value: element?.value ?? props.modelValue,
    cursor: element?.selectionStart ?? props.modelValue.length,
    trigger: mentionTrigger.value,
    candidate,
    bindings: mentionBindings.value,
  });
  if (!result) return;
  emit("update:modelValue", result.value);
  emit("update:mentionBindings", result.bindings);
  mentions.close();
  void nextTick(() => {
    const textarea = textareaElement();
    textarea?.focus();
    textarea?.setSelectionRange(result.cursor, result.cursor);
    resizeInput();
  });
}

function mentionIcon(candidate: AiSessionMentionCandidate) {
  if (candidate.kind === "plugin") return Puzzle;
  if (candidate.kind === "skill") return WandSparkles;
  if (candidate.kind === "file") return File;
  if (candidate.kind === "directory") return Folder;
  if (candidate.kind === "app") return AppWindow;
  return Box;
}

function activateMentionCandidate(candidate: AiSessionMentionCandidate) {
  const index = mentions.candidates.value.findIndex((item) => item.kind === candidate.kind && item.path === candidate.path);
  if (index >= 0) activeMentionIndex.value = index;
}

function isActiveMention(candidate: AiSessionMentionCandidate) {
  const active = mentions.candidates.value[activeMentionIndex.value];
  return active?.kind === candidate.kind && active.path === candidate.path;
}

watch(() => mentions.candidates.value.length, (length) => {
  if (!length) activeMentionIndex.value = 0;
  else activeMentionIndex.value = Math.min(activeMentionIndex.value, length - 1);
});

watch(mentionTrigger, () => mentions.close());
watch(commandTrigger, () => { commandOpen.value = false; });
watch(() => props.busy, (busy) => {
  if (busy) {
    mentions.close();
    commandOpen.value = false;
  }
});
</script>

<template>
  <form ref="composerEl" class="ai-session-composer" :aria-busy="busy" @drop="handleDrop" @dragover.prevent @submit.prevent="submit">
    <div v-if="attachments.length" class="ai-session-composer__attachments">
      <figure v-for="attachment in attachments" :key="attachment.id">
        <img :alt="attachment.name" :src="attachment.dataUrl" />
        <button type="button" title="Remove image" aria-label="Remove image" :disabled="busy" @click="removeAttachment(attachment.id)">
          <X :size="14" />
        </button>
      </figure>
    </div>
    <Popover :open="overlayOpen" @update:open="(open) => { if (!open) { mentions.close(); commandOpen = false; } }">
      <PopoverAnchor as-child>
        <div class="ai-session-composer__input-anchor">
          <Textarea
            ref="inputEl"
            v-model="draft"
            class="ai-session-composer__input"
            :disabled="busy"
            :placeholder="placeholder || 'Ask for follow-up changes'"
            rows="3"
            @keydown.down.stop.prevent="moveActiveMention(1)"
            @keydown.up.stop.prevent="moveActiveMention(-1)"
            @keydown="handleInputKeydown"
            @input="handleComposerInput"
            @click="updateOverlayMenu()"
            @keyup="handleInputKeyup"
            @paste="handlePaste"
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        class="ai-session-mention-popover"
        data-ai-session-composer-overlay
        :data-active-index="activeMentionIndex"
        side="top"
        align="start"
        :side-offset="8"
        :style="{ width: 'var(--reka-popover-trigger-width)', borderRadius: mentionPopoverRadius, padding: '4px' }"
        @open-auto-focus.prevent
        @close-auto-focus.prevent
      >
        <div class="ai-session-mention-popover__list" role="listbox">
          <template v-if="commandOpen">
            <div v-if="!commandCandidates.length" class="ai-session-mention-popover__state">No matches</div>
            <section v-else class="ai-session-mention-popover__group" role="group" aria-label="Commands">
              <div class="ai-session-mention-popover__group-label">Commands</div>
              <button
                v-for="(command, index) in commandCandidates"
                :key="command.name"
                type="button"
                role="option"
                class="ai-session-mention-popover__item"
                :class="{ 'ai-session-mention-popover__item--active': activeCommandIndex === index }"
                :disabled="sessionBusy && command.requiresIdle"
                :aria-selected="activeCommandIndex === index"
                @mouseenter="activeCommandIndex = index"
                @mousedown.prevent
                @click="selectCommand(command, $event)"
              >
                <span class="ai-session-mention-popover__icon"><component :is="commandIcon(command)" :size="12" /></span>
                <span class="ai-session-mention-popover__copy">
                  <strong>{{ commandTrigger }}{{ command.name }}<template v-if="command.argumentHint"> &lt;{{ command.argumentHint }}&gt;</template></strong>
                  <span>{{ sessionBusy && command.requiresIdle ? `${command.description} · available when idle` : command.description }}</span>
                </span>
              </button>
            </section>
          </template>
          <div v-else-if="mentions.loading.value && !mentions.candidates.value.length" class="ai-session-mention-popover__state">Loading...</div>
          <div v-else-if="mentions.error.value && !mentions.candidates.value.length" class="ai-session-mention-popover__state ai-session-mention-popover__state--error">{{ mentions.error.value }}</div>
          <div v-else-if="!groupedMentionCandidates.length" class="ai-session-mention-popover__state">No matches</div>
          <section v-for="group in groupedMentionCandidates" :key="group.kind" class="ai-session-mention-popover__group" role="group" :aria-label="group.label">
            <div class="ai-session-mention-popover__group-label">{{ group.label }}</div>
              <button
                v-for="candidate in group.candidates"
                :key="`${candidate.kind}:${candidate.path}`"
                type="button"
                role="option"
                class="ai-session-mention-popover__item"
                :class="{ 'ai-session-mention-popover__item--active': isActiveMention(candidate) }"
                :aria-selected="isActiveMention(candidate)"
                @mouseenter="activateMentionCandidate(candidate)"
                @mousedown.prevent
                @click="selectMention(candidate, $event)"
              >
                <span class="ai-session-mention-popover__icon">
                  <img v-if="candidate.icon" :src="candidate.icon" alt="" />
                  <component :is="mentionIcon(candidate)" v-else :size="12" />
                </span>
                <span class="ai-session-mention-popover__copy">
                  <strong>{{ candidate.name }}</strong>
                  <span>{{ candidate.description || candidate.path }}</span>
                </span>
              </button>
            <p v-for="diagnostic in group.diagnostics" :key="diagnostic.code" class="ai-session-mention-popover__diagnostic">{{ diagnostic.message }}</p>
          </section>
        </div>
      </PopoverContent>
    </Popover>
    <div class="ai-session-composer__toolbar">
      <button
        type="button"
        class="ai-session-composer__tool"
        title="Add context"
        :disabled="busy"
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
          :disabled="busy"
          @click="emit('steer')"
        >
          <CornerDownRight :size="18" />
        </button>
        <button
          type="submit"
          class="ai-session-composer__primary"
          :data-action="actionKind"
          :disabled="busy || !canRun"
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

.ai-session-composer__attachments button:disabled,
.ai-session-composer__tool:disabled {
  cursor: not-allowed;
  opacity: 0.55;
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

.ai-session-composer__input-anchor {
  min-width: 0;
  flex: 0 0 auto;
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

.ai-session-composer[aria-busy="true"] {
  cursor: wait;
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

:global(.ai-session-mention-popover) {
  max-width: calc(100vw - 24px);
  overflow: hidden;
}

:global(.ai-session-mention-popover__list) {
  max-height: min(360px, 48vh);
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0;
}

:global(.ai-session-mention-popover__group-label) {
  padding: 8px 10px 4px;
  color: hsl(var(--muted-foreground));
  font-size: 12px;
  font-weight: 500;
}

:global(.ai-session-mention-popover__item) {
  display: flex;
  width: 100%;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 5px 8px;
  text-align: left;
}

:global(.ai-session-mention-popover__item--active) {
  background: hsl(var(--accent));
  color: hsl(var(--accent-foreground));
}

:global(.ai-session-mention-popover__icon) {
  display: grid;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  place-items: center;
  overflow: hidden;
  border-radius: 6px;
  color: hsl(var(--muted-foreground));
}

:global(.ai-session-mention-popover__icon img) {
  width: 12px;
  height: 12px;
  object-fit: contain;
}

:global(.ai-session-mention-popover__copy) {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: baseline;
  gap: 8px;
}

:global(.ai-session-mention-popover__copy strong) {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}

:global(.ai-session-mention-popover__copy > span) {
  min-width: 0;
  overflow: hidden;
  color: hsl(var(--muted-foreground));
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.ai-session-mention-popover__state),
:global(.ai-session-mention-popover__diagnostic) {
  margin: 0;
  padding: 12px;
  color: hsl(var(--muted-foreground));
  font-size: 12px;
  line-height: 1.4;
}

:global(.ai-session-mention-popover__state--error),
:global(.ai-session-mention-popover__diagnostic) {
  color: var(--status-danger);
}

</style>
