<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { formatBytes } from "../../i18n/presentation";
import type { SupportedLocale } from "../../i18n/locale";
import { AppWindow, ArrowUp, Box, Check, CornerDownRight, File, Folder, Hand, LoaderCircle, Minimize2, Pencil, Plus, Puzzle, ScanSearch, ShieldAlert, ShieldCheck, Square, Target, WandSparkles, X } from "@lucide/vue";
import { PopoverAnchor } from "reka-ui";
import type { AiSessionMentionCandidate } from "../../api/types";
import type { AiSessionCommandInput, AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Popover, PopoverContent } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { mentionTokenAt, reconcileMentionBindings, replaceMentionToken, type AiSessionMentionBinding } from "./mentions";
import { commandTokenAt, matchingCommands, parseAiSessionCommand, replaceCommandToken, type AiSessionCommandCandidate } from "./commands";
import { useAiSessionMentions, type AiSessionMentionContext } from "./useAiSessionMentions";
import { useAiSessionPermissionMode } from "../../apps/control-plane/useAiSessionPermissionMode";
import { showControlPlaneToast } from "../../apps/control-plane/useControlPlaneToasts";

export type AiSessionComposerAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  source: { type: "inline" } | { type: "runtime-path"; path: string };
  dataUrl?: string;
  previewUrl?: string;
  file?: File;
};

type DesktopFileBridge = {
  getPathForFile?: (file: File) => string;
};

const props = defineProps<{
  modelValue: string;
  attachments?: AiSessionComposerAttachment[];
  busy?: boolean;
  disabled?: boolean;
  canInterrupt?: boolean;
  placeholder?: string;
  mentionBindings?: AiSessionMentionBinding[];
  mentionContext?: AiSessionMentionContext;
  mentionTrigger?: string;
  commandTrigger?: string;
  sessionBusy?: boolean;
  provider?: string;
  permissionKey?: string;
  permissionMode?: AiSessionPermissionMode;
  defaultPermissionMode?: AiSessionPermissionMode;
  editingLabel?: string;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
  (event: "update:attachments", value: AiSessionComposerAttachment[]): void;
  (event: "update:mentionBindings", value: AiSessionMentionBinding[]): void;
  (event: "update:permissionMode", value: AiSessionPermissionMode): void;
  (event: "run", permissionMode?: AiSessionPermissionMode): void;
  (event: "steer"): void;
  (event: "command", value: AiSessionCommandInput): void;
  (event: "cancelEdit"): void;
}>();
const { locale, t } = useI18n();

const draft = computed({
  get: () => props.modelValue,
  set: (value: string | number) => emit("update:modelValue", String(value)),
});

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_FILE_BYTES = 500 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME = new Set(["image/bmp", "image/gif", "image/jpeg", "image/png", "image/webp"]);
const composerEl = ref<HTMLFormElement>();
const inputEl = ref<unknown>();
const attachments = computed(() => props.attachments || []);
const mentionBindings = computed(() => props.mentionBindings || []);
const mentionTrigger = computed(() => props.mentionTrigger || "@");
const commandTrigger = computed(() => props.commandTrigger || "/");
const mentions = useAiSessionMentions(() => props.mentionContext, t);
const activeMentionIndex = ref(0);
const commandOpen = ref(false);
const commandQuery = ref("");
const activeCommandIndex = ref(0);
const commandCandidates = computed(() => matchingCommands(commandQuery.value));
const editing = computed(() => Boolean(props.editingLabel));
const overlayOpen = computed(() => !editing.value && !props.busy && (mentions.open.value || commandOpen.value));
const mentionPopoverRadius = ref("20px");
const mentionKinds = ["plugin", "skill", "file", "directory", "app"] as const;
const groupedMentionCandidates = computed(() => mentionKinds.map((kind) => ({
  kind,
  label: t(`sessions.composer.${kind === "plugin" ? "plugins" : kind === "skill" ? "skills" : kind === "file" ? "files" : kind === "directory" ? "directories" : "apps"}`),
  candidates: mentions.candidates.value.filter((candidate) => candidate.kind === kind),
  diagnostics: mentions.diagnostics.value.filter((diagnostic) => diagnostic.category === (kind === "skill" ? "skills" : kind === "plugin" ? "plugins" : kind === "app" ? "apps" : "files")),
})).filter((group) => group.candidates.length || group.diagnostics.length));
const hasDraft = computed(() => props.modelValue.trim().length > 0 || attachments.value.length > 0);
const actionKind = computed(() => editing.value ? "save" : hasDraft.value || !props.canInterrupt ? "send" : "stop");
const canRun = computed(() => !props.disabled && (editing.value ? props.modelValue.trim().length > 0 : hasDraft.value || (!props.busy && props.canInterrupt)));
const canSteer = computed(() => !editing.value && props.sessionBusy && hasDraft.value);
const actionTitle = computed(() => {
  if (props.busy) {
    return actionKind.value === "stop"
      ? t("sessions.composer.stopping")
      : actionKind.value === "save"
        ? t("sessions.composer.saving")
        : t("sessions.composer.sending");
  }
  return actionKind.value === "stop"
    ? t("sessions.composer.stopTurn")
    : actionKind.value === "save"
      ? t("sessions.composer.saveQueuedMessage")
      : t("sessions.composer.send");
});
const commandLauncherDisabled = computed(() => Boolean(editing.value || props.busy || props.modelValue.length || props.mentionContext?.provider !== "codex"));
const permissionProvider = computed(() => props.provider || props.mentionContext?.provider);
const storedPermissionMode = useAiSessionPermissionMode(
  () => props.permissionKey || props.mentionContext?.sessionId || "",
  () => props.defaultPermissionMode || "ask",
);
const permissionMode = computed<AiSessionPermissionMode>({
  get: () => props.permissionMode ?? storedPermissionMode.value,
  set: (value) => {
    if (props.permissionMode !== undefined) emit("update:permissionMode", value);
    else storedPermissionMode.value = value;
  },
});
const permissionOptions = computed(() => [
  { value: "ask", label: t("sessions.permission.ask"), description: t("sessions.composer.askDescription"), icon: Hand },
  { value: "auto-review", label: t("sessions.permission.autoReview"), description: t("sessions.composer.autoReviewDescription"), icon: ShieldCheck },
  { value: "full-access", label: t("sessions.permission.fullAccess"), description: t("sessions.composer.fullAccessDescription"), icon: ShieldAlert, danger: true },
] satisfies Array<{ value: AiSessionPermissionMode; label: string; description: string; icon: typeof Hand; danger?: boolean }>);
const selectedPermission = computed(() => permissionOptions.value.find((option) => option.value === permissionMode.value) || permissionOptions.value[0]);

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

function focus() {
  void nextTick(() => textareaElement()?.focus());
}

defineExpose({ focus });

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

watch(attachments, (next, previous) => {
  for (const attachment of previous || []) {
    if (attachment.previewUrl && !next.some((item) => item.id === attachment.id)) URL.revokeObjectURL(attachment.previewUrl);
  }
  void nextTick(resizeInput);
});

function attachmentKind(file: File): "image" | "file" {
  return file.type.startsWith("image/") || /\.(?:bmp|gif|jpe?g|png|webp)$/i.test(file.name) ? "image" : "file";
}

function validateFiles(files: File[], runtimePathFiles: Set<File>, outsideWorkspaceFiles: Set<File> = new Set()) {
  const accepted: File[] = [];
  const currentBytes = attachments.value.reduce((sum, attachment) => sum + (attachment.source.type === "inline" ? attachment.size : 0), 0);
  let nextBytes = currentBytes;
  for (const file of files) {
    const kind = attachmentKind(file);
    const mime = file.type || (kind === "image" ? "image/png" : "application/octet-stream");
    const usesRuntimePath = runtimePathFiles.has(file);
    if (kind === "image" && !SUPPORTED_IMAGE_MIME.has(mime)) {
      showControlPlaneToast(t("sessions.composer.supportedImages"));
      continue;
    }
    if (file.size <= 0) {
      showControlPlaneToast(t("sessions.composer.emptyFile"));
      continue;
    }
    if (!usesRuntimePath && kind === "image" && file.size > MAX_ATTACHMENT_BYTES) {
      showControlPlaneToast(t("sessions.composer.imageTooLarge"));
      continue;
    }
    if (!usesRuntimePath && kind === "file" && file.size >= MAX_INLINE_FILE_BYTES) {
      showControlPlaneToast(outsideWorkspaceFiles.has(file)
        ? t("sessions.composer.runtimePathOutside")
        : props.mentionContext?.runtimeType === "local"
          ? t("sessions.composer.browserPathUnavailable")
        : t("sessions.composer.fileTooLarge"));
      continue;
    }
    if (attachments.value.length + accepted.length >= MAX_ATTACHMENTS) {
      showControlPlaneToast(t("sessions.composer.tooManyAttachments"));
      continue;
    }
    if (!usesRuntimePath && nextBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      showControlPlaneToast(t("sessions.composer.totalTooLarge"));
      continue;
    }
    if (!usesRuntimePath) nextBytes += file.size;
    accepted.push(file);
  }
  return accepted;
}

async function addFiles(files: File[]) {
  if (props.busy) {
    return;
  }
  const bridge = (window as Window & { taskHandoffDesktop?: DesktopFileBridge }).taskHandoffDesktop;
  const runtimePaths = new Map<File, string>();
  const outsideWorkspaceFiles = new Set<File>();
  if (props.mentionContext?.runtimePathAccess === "desktop-local" && bridge?.getPathForFile) {
    for (const file of files) {
      try {
        const filePath = await Promise.resolve(bridge.getPathForFile(file));
        if (filePath && runtimePathWithinWorkspace(filePath, props.mentionContext.cwd)) runtimePaths.set(file, filePath);
        else if (filePath) outsideWorkspaceFiles.add(file);
      } catch {
        // Files synthesized by the browser do not have a filesystem path and use inline rules.
      }
    }
  }
  const accepted = validateFiles(files, new Set(runtimePaths.keys()), outsideWorkspaceFiles);
  if (!accepted.length) {
    return;
  }
  void Promise.all(accepted.map((file) => readAttachment(file, runtimePaths.get(file)))).then((items) => {
    emit("update:attachments", [...attachments.value, ...items]);
  });
}

function runtimePathWithinWorkspace(filePath: string, workspacePath: string) {
  const candidate = normalizeAbsoluteRuntimePath(filePath);
  const root = normalizeAbsoluteRuntimePath(workspacePath);
  return Boolean(candidate && root && (root === "/" || candidate === root || candidate.startsWith(`${root}/`)));
}

function normalizeAbsoluteRuntimePath(value: string) {
  if (!value.startsWith("/")) return "";
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function readAttachment(file: File, runtimePath?: string): Promise<AiSessionComposerAttachment> {
  const kind = attachmentKind(file);
  const common = {
    id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    kind,
    name: file.name || (kind === "image" ? "image.png" : "attachment"),
    mime: file.type || (kind === "image" ? "image/png" : "application/octet-stream"),
    size: file.size,
  };
  if (runtimePath) {
    return Promise.resolve({
      ...common,
      source: { type: "runtime-path", path: runtimePath },
      ...(kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve({
        ...common,
        source: { type: "inline" },
        dataUrl: String(reader.result || ""),
        file,
      });
    });
    reader.addEventListener("error", () => reject(reader.error || new Error(t("sessions.composer.readFailed"))));
    reader.readAsDataURL(file);
  });
}

function removeAttachment(id: string) {
  if (props.busy) {
    return;
  }
  emit("update:attachments", attachments.value.filter((attachment) => attachment.id !== id));
}

function formatAttachmentSize(size: number) {
  return formatBytes(size, locale.value as SupportedLocale);
}

function handlePaste(event: ClipboardEvent) {
  if (editing.value) return;
  if (props.busy) {
    return;
  }
  const files = Array.from(event.clipboardData?.files || []);
  if (!files.length) {
    return;
  }
  event.preventDefault();
  void addFiles(files);
}

function handleDrop(event: DragEvent) {
  if (props.busy || editing.value) {
    return;
  }
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) {
    return;
  }
  event.preventDefault();
  void addFiles(files);
}

function submit() {
  if (!props.busy && canRun.value) {
    const command = editing.value ? undefined : parseAiSessionCommand(props.modelValue.trim(), commandTrigger.value, props.mentionContext?.provider);
    if (command) {
      emit("command", command);
      return;
    }
    emit("run", permissionProvider.value === "codex" ? permissionMode.value : undefined);
  }
}

function handleInputKeydown(event: KeyboardEvent) {
  if (props.busy) return;
  if (event.isComposing) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const moved = moveActiveMention(event.key === "ArrowDown" ? 1 : -1);
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
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
  if (props.busy) return false;
  if (commandOpen.value) {
    const length = commandCandidates.value.length;
    if (!length) return false;
    activeCommandIndex.value = (activeCommandIndex.value + direction + length) % length;
    void nextTick(() => document.querySelector(".ai-session-mention-popover__item--active")?.scrollIntoView({ block: "nearest" }));
    return true;
  }
  if (!mentions.open.value) return false;
  const length = mentions.candidates.value.length;
  if (!length) return false;
  activeMentionIndex.value = (activeMentionIndex.value + direction + length) % length;
  void nextTick(() => document.querySelector(".ai-session-mention-popover__item--active")?.scrollIntoView({ block: "nearest" }));
  return true;
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

function openCommandMenu() {
  if (commandLauncherDisabled.value) return;
  const trigger = commandTrigger.value;
  emit("update:modelValue", trigger);
  emit("update:mentionBindings", []);
  mentions.close();
  commandOpen.value = true;
  commandQuery.value = "";
  activeCommandIndex.value = 0;
  mentionPopoverRadius.value = composerEl.value ? getComputedStyle(composerEl.value).borderRadius : "20px";
  void nextTick(() => {
    const textarea = textareaElement();
    textarea?.focus();
    textarea?.setSelectionRange(trigger.length, trigger.length);
    resizeInput();
  });
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
      <figure v-for="attachment in attachments" :key="attachment.id" :class="{ 'ai-session-composer__file': attachment.kind === 'file' }">
        <img v-if="attachment.kind === 'image'" :alt="attachment.name" :src="attachment.previewUrl || attachment.dataUrl" />
        <template v-else>
          <span class="ai-session-composer__file-icon"><File :size="22" /></span>
          <figcaption>
            <strong :title="attachment.name">{{ attachment.name }}</strong>
            <span>{{ formatAttachmentSize(attachment.size) }}<template v-if="attachment.source.type === 'runtime-path'"> · {{ t("sessions.composer.localPath") }}</template></span>
          </figcaption>
        </template>
        <button type="button" :title="t('sessions.composer.removeAttachment')" :aria-label="t('sessions.composer.removeAttachment')" :disabled="busy" @click="removeAttachment(attachment.id)">
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
            :placeholder="placeholder || t('sessions.composer.followUp')"
            rows="3"
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
            <div v-if="!commandCandidates.length" class="ai-session-mention-popover__state">{{ t("sessions.composer.noMatches") }}</div>
            <section v-else class="ai-session-mention-popover__group" role="group" :aria-label="t('sessions.composer.commands')">
              <div class="ai-session-mention-popover__group-label">{{ t("sessions.composer.commands") }}</div>
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
                  <strong>{{ commandTrigger }}{{ command.name }}<template v-if="command.argumentHintKey"> &lt;{{ t(command.argumentHintKey) }}&gt;</template></strong>
                  <span>{{ t(command.descriptionKey) }}<template v-if="sessionBusy && command.requiresIdle"> · {{ t("sessions.composer.availableIdle") }}</template></span>
                </span>
              </button>
            </section>
          </template>
          <div v-else-if="mentions.loading.value && !mentions.candidates.value.length" class="ai-session-mention-popover__state">{{ t("sessions.composer.loading") }}</div>
          <div v-else-if="mentions.error.value && !mentions.candidates.value.length" class="ai-session-mention-popover__state ai-session-mention-popover__state--error">{{ mentions.error.value }}</div>
          <div v-else-if="!groupedMentionCandidates.length" class="ai-session-mention-popover__state">{{ t("sessions.composer.noMatches") }}</div>
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
      <div v-if="editingLabel" class="ai-session-composer__editing">
        <Pencil :size="15" />
        <span>{{ editingLabel }}</span>
        <button type="button" :title="t('sessions.composer.cancelQueuedEdit')" :aria-label="t('sessions.composer.cancelQueuedEdit')" :disabled="busy" @click="emit('cancelEdit')">
          <X :size="15" />
        </button>
      </div>
      <div v-else class="ai-session-composer__leading">
        <button
          type="button"
          class="ai-session-composer__tool"
          :title="t('sessions.composer.commands')"
          :aria-label="t('sessions.composer.openCommands')"
          :disabled="commandLauncherDisabled"
          @click="openCommandMenu"
        >
          <Plus :size="18" />
        </button>
        <DropdownMenu v-if="permissionProvider === 'codex'">
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              class="ai-session-composer__permission-trigger"
              :data-danger="selectedPermission.danger || undefined"
              :disabled="busy || sessionBusy"
              :aria-label="t('sessions.composer.permissionMode', { mode: selectedPermission.label })"
              :title="t('sessions.composer.choosePermission')"
            >
              <component :is="selectedPermission.icon" :size="16" />
              <span>{{ selectedPermission.label }}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent class="ai-session-permission-menu" side="top" align="start" :side-offset="8">
            <DropdownMenuItem
              v-for="option in permissionOptions"
              :key="option.value"
              class="ai-session-permission-menu__item"
              :data-danger="option.danger || undefined"
              @select="permissionMode = option.value"
            >
              <component :is="option.icon" :size="18" />
              <span class="ai-session-permission-menu__copy">
                <strong>{{ option.label }}</strong>
                <small>{{ option.description }}</small>
              </span>
              <Check v-if="permissionMode === option.value" class="ai-session-permission-menu__check" :size="16" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div class="ai-session-composer__actions">
        <button
          v-if="canSteer"
          type="button"
          class="ai-session-composer__tool"
          :title="t('sessions.composer.steerTurn')"
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
          :aria-label="actionTitle"
        >
          <LoaderCircle v-if="busy" class="animate-spin motion-reduce:animate-none" :size="18" />
          <ArrowUp v-else-if="actionKind === 'send'" :size="18" />
          <Check v-else-if="actionKind === 'save'" :size="17" />
          <Square v-else :size="16" />
        </button>
      </div>
    </div>
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

.ai-session-composer__attachments .ai-session-composer__file {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(240px, 62vw);
  padding: 10px 34px 10px 10px;
}

.ai-session-composer__file-icon {
  display: grid;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 9px;
  background: color-mix(in srgb, var(--ai-composer-text, currentColor) 9%, transparent);
}

.ai-session-composer__file figcaption {
  display: grid;
  min-width: 0;
  gap: 3px;
  text-align: left;
}

.ai-session-composer__file strong,
.ai-session-composer__file figcaption span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-composer__file strong {
  font-size: 13px;
  font-weight: 600;
}

.ai-session-composer__file figcaption span {
  color: var(--muted-foreground);
  font-size: 11px;
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

.ai-session-composer__leading {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}

.ai-session-composer__editing {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  padding-left: 8px;
  color: var(--ai-composer-muted, currentColor);
  font-size: 12px;
  font-weight: 600;
}

.ai-session-composer__editing span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-composer__editing button {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  place-items: center;
}

.ai-session-composer__editing button:hover {
  background: var(--ai-composer-hover, color-mix(in srgb, currentColor 8%, transparent));
}

.ai-session-composer__permission-trigger {
  display: inline-flex;
  max-width: min(220px, 45vw);
  height: 32px;
  align-items: center;
  gap: 7px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ai-composer-muted, currentColor);
  cursor: pointer;
  padding: 0 11px;
  font-size: 12px;
  font-weight: 500;
  transition: background-color 140ms ease;
}

.ai-session-composer__permission-trigger span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-composer__permission-trigger[data-danger="true"] {
  color: var(--status-danger);
}

.ai-session-composer__permission-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

:global(.ai-session-permission-menu) {
  width: min(460px, calc(100vw - 24px));
  padding: 6px;
}

:global(.ai-session-permission-menu__item) {
  min-height: 58px;
  align-items: flex-start;
  gap: 10px;
  border-radius: 10px;
  padding: 9px 10px;
}

:global(.ai-session-permission-menu__item[data-danger="true"]) {
  color: var(--status-danger);
}

:global(.ai-session-permission-menu__item[data-danger="true"]:is(:hover, :focus, [data-highlighted])) {
  color: var(--status-danger) !important;
}

:global(.ai-session-permission-menu__copy) {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 2px;
}

:global(.ai-session-permission-menu__copy strong) {
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}

:global(.ai-session-permission-menu__copy small) {
  color: hsl(var(--muted-foreground));
  font-size: 12px;
  line-height: 16px;
}

:global(.ai-session-permission-menu__item[data-danger="true"] .ai-session-permission-menu__copy small) {
  color: color-mix(in srgb, var(--status-danger) 72%, hsl(var(--muted-foreground)));
}

:global(.ai-session-permission-menu__check) {
  flex: 0 0 auto;
  margin-top: 1px;
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
  transition: background-color 140ms ease;
}

.ai-session-composer__tool:not(:disabled):is(:hover, :focus-visible),
.ai-session-composer__permission-trigger:not(:disabled):is(:hover, :focus-visible) {
  background: color-mix(in srgb, var(--ai-composer-muted, currentColor) 10%, transparent);
  outline: none;
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
