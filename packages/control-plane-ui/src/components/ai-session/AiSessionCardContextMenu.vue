<template>
  <ContextMenuContent class="ai-session-context-menu">
    <ContextMenuSub v-if="showTriggerActions">
      <ContextMenuSubTrigger class="ai-session-context-menu-item">
        <Zap :size="14" />
        <span>{{ boundTriggerCount ? t("sessions.actions.triggersBound", { count: boundTriggerCount }) : t("sessions.actions.addTrigger") }}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent class="ai-session-context-menu ai-session-context-trigger-menu">
        <ContextMenuItem v-if="!triggerTemplates.length" class="ai-session-context-menu-item muted" disabled>
          {{ t("sessions.actions.noTriggers") }}
        </ContextMenuItem>
        <ContextMenuItem
          v-for="trigger in triggerTemplates"
          v-else
          :key="trigger.configHash"
          class="ai-session-context-trigger-item"
          :disabled="isTriggerBusy(trigger.configHash)"
          @select="$emit('toggleTrigger', trigger.configHash)"
        >
          <Check v-if="isTriggerBound(trigger.configHash)" :size="13" />
          <Zap v-else :size="13" />
          <span>
            <strong>{{ trigger.config.name }}</strong>
            <small>{{ trigger.config.source.type }} · {{ shortHash(trigger.configHash) }}</small>
          </span>
          <small>{{ isTriggerBound(trigger.configHash) ? t("sessions.actions.remove") : t("sessions.actions.add") }}</small>
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
    <ContextMenuSub v-if="storyTarget" @update:open="onStoryMenuOpen">
      <ContextMenuSubTrigger class="ai-session-context-menu-item" :disabled="storyMenuBusy">
        <BookOpen :size="14" />
        <span>{{ t("sessions.actions.addToStory") }}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent class="ai-session-context-menu ai-session-context-story-menu">
        <ContextMenuItem v-if="storyLoading" class="ai-session-context-menu-item muted" disabled>
          {{ t("sessions.actions.loadingStories") }}
        </ContextMenuItem>
        <ContextMenuItem v-else-if="storyError" class="ai-session-context-menu-item muted" disabled>
          {{ storyError }}
        </ContextMenuItem>
        <template v-else>
          <ContextMenuItem v-if="!availableStories.length" class="ai-session-context-menu-item muted" disabled>
            {{ t("sessions.actions.noStories") }}
          </ContextMenuItem>
          <template v-for="story in availableStories" :key="story.id">
            <ContextMenuItem
              class="ai-session-context-story-item"
              :disabled="storyMenuBusy"
              @select="assignToStory(story.id)"
            >
              <Check v-if="story.id === currentStoryId" :size="13" />
              <BookOpen v-else :size="13" />
              <span>
                <strong>{{ story.title }}</strong>
                <small>{{ story.ownerNodeId }}</small>
              </span>
            </ContextMenuItem>
          </template>
        </template>
      </ContextMenuSubContent>
    </ContextMenuSub>
    <ContextMenuItem v-if="canOpenApp" class="ai-session-context-menu-item" @select="$emit('openApp')">
      <ExternalLink :size="14" />
      <span>{{ t("sessions.actions.openApp") }}</span>
    </ContextMenuItem>
    <ContextMenuItem v-if="canOpenTerminal" class="ai-session-context-menu-item" :disabled="isOpeningTerminal" @select="$emit('openTerminal')">
      <SquareTerminal :size="14" />
      <span>{{ t("sessions.actions.openTerminal") }}</span>
    </ContextMenuItem>
    <ContextMenuSub v-if="canFork">
      <ContextMenuSubTrigger class="ai-session-context-menu-item" :disabled="isForking">
        <Split :size="14" />
        <span>{{ isForking ? t("sessions.actions.forking") : t("sessions.actions.fork") }}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent class="ai-session-context-menu">
        <ContextMenuItem class="ai-session-context-menu-item" @select="$emit('forkSession', 'current')">{{ t("sessions.actions.forkCurrent") }}</ContextMenuItem>
        <ContextMenuItem class="ai-session-context-menu-item" @select="$emit('forkSession', 'managed-worktree')">{{ t("sessions.actions.forkWorktree") }}</ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
    <ContextMenuItem v-if="canCloseSession" class="ai-session-context-menu-item danger" :disabled="isStoppingAppSession" @select="$emit('closeSession')">
      <Square :size="14" />
      <span>{{ isStoppingAppSession ? t("sessions.actions.closingSession") : t("sessions.actions.closeSession") }}</span>
    </ContextMenuItem>
  </ContextMenuContent>
</template>

<script setup lang="ts">
import { BookOpen, Check, ExternalLink, Split, Square, SquareTerminal, Zap } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ControlPlaneTrigger } from "../../api/types";
import { assignAiSessionToStory, listStories } from "../../api/queries";
import type { Story } from "@task-handoff/protocol/stories";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "../ui/context-menu";

type StoryTarget = {
  nodeId: string;
  instanceId: string;
  sessionId: string;
  storyId?: string | null;
};

const { t } = useI18n();

const props = withDefaults(defineProps<{
  boundTriggerCount: number;
  hasAppSession: boolean;
  canOpenApp: boolean;
  canOpenTerminal?: boolean;
  canFork?: boolean;
  isForking?: boolean;
  isOpeningTerminal?: boolean;
  isStoppingAppSession?: boolean;
  showTriggerActions?: boolean;
  canCloseSession?: boolean;
  storyTarget?: StoryTarget;
  isTriggerBound: (configHash: string) => boolean;
  isTriggerBusy: (configHash: string) => boolean;
  shortHash: (value: string) => string;
  triggerTemplates: ControlPlaneTrigger[];
}>(), {
  canCloseSession: true,
  showTriggerActions: true,
});

const emit = defineEmits<{
  closeSession: [];
  openApp: [];
  openTerminal: [];
  forkSession: [mode: "current" | "managed-worktree"];
  toggleTrigger: [configHash: string];
  storyAssigned: [target: StoryTarget];
  storyAssignFailed: [target: StoryTarget, error: unknown];
}>();

const storyLoading = ref(false);
const storyError = ref("");
const stories = ref<Story[]>([]);
const assigningStoryId = ref<string>();
const storyMenuBusy = computed(() => Boolean(assigningStoryId.value));
const currentStoryId = computed(() => props.storyTarget?.storyId || undefined);
const availableStories = computed(() => stories.value.filter((story) => !story.archivedAt));

async function loadStories() {
  const target = props.storyTarget;
  if (!target || storyLoading.value) return;
  storyLoading.value = true;
  storyError.value = "";
  stories.value = [];
  try {
    const payload = await listStories(target.nodeId);
    stories.value = payload.stories || [];
  } catch (cause) {
    const detail = cause instanceof Error ? ` (${cause.message})` : "";
    storyError.value = `${t("sessions.actions.storiesLoadFailed")}${detail}`;
  } finally {
    storyLoading.value = false;
  }
}

function onStoryMenuOpen(open: boolean) {
  if (open) void loadStories();
}

async function assignToStory(storyId: string) {
  const target = props.storyTarget;
  if (!target || assigningStoryId.value) return;
  if (target.storyId === storyId) return;
  assigningStoryId.value = storyId;
  try {
    await assignAiSessionToStory(target.instanceId, target.sessionId, storyId);
    const updatedTarget = { ...target, storyId };
    await loadStories();
    emit("storyAssigned", updatedTarget);
  } catch (cause) {
    storyError.value = t("sessions.actions.storyAssignFailed");
    emit("storyAssignFailed", target, cause);
  } finally {
    assigningStoryId.value = undefined;
  }
}
</script>

<style scoped>
:global(.ai-session-context-menu) {
  min-width: 190px;
  border: 1px solid var(--ai-board-column-border);
  background: color-mix(in srgb, var(--ai-board-column-bg) 94%, transparent);
  color: var(--ai-board-title);
  -webkit-backdrop-filter: blur(16px) saturate(1.16);
  backdrop-filter: blur(16px) saturate(1.16);
  padding: 6px;
}

:global(.ai-session-context-menu .ai-session-context-menu-item) {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  border-radius: 6px;
  font-size: 13px;
  padding: 6px 8px;
}

:global(.ai-session-context-menu-item.muted) {
  color: var(--ai-board-muted);
}

:global(.ai-session-context-menu-item.danger) {
  color: var(--ai-board-stale-text);
}

:global(.ai-session-context-trigger-menu) {
  min-width: 250px;
}

:global(.ai-session-context-menu .ai-session-context-trigger-item) {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  gap: 8px;
  min-height: 34px;
  border-radius: 6px;
  font-size: 13px;
  padding: 6px 8px;
}

:global(.ai-session-context-trigger-item > span) {
  display: grid;
  min-width: 0;
}

:global(.ai-session-context-trigger-item strong),
:global(.ai-session-context-trigger-item small) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.ai-session-context-trigger-item strong) {
  color: var(--ai-board-title);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
}

:global(.ai-session-context-trigger-item small) {
  color: var(--ai-board-muted);
  font-size: 11px;
  line-height: 1.2;
}

:global(.ai-session-context-story-menu) {
  min-width: 220px;
}

:global(.ai-session-context-menu .ai-session-context-story-item) {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 8px;
  min-height: 34px;
  border-radius: 6px;
  font-size: 13px;
  padding: 6px 8px;
}

:global(.ai-session-context-story-item > span) {
  display: grid;
  min-width: 0;
}

:global(.ai-session-context-story-item strong),
:global(.ai-session-context-story-item small) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.ai-session-context-story-item strong) {
  color: var(--ai-board-title);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
}

:global(.ai-session-context-story-item small) {
  color: var(--ai-board-muted);
  font-size: 11px;
  line-height: 1.2;
}
</style>
