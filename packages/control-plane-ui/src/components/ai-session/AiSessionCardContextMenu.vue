<template>
  <ContextMenuContent class="ai-session-context-menu">
    <ContextMenuSub>
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
    <ContextMenuItem class="ai-session-context-menu-item danger" :disabled="isStoppingAppSession" @select="$emit('closeSession')">
      <Square :size="14" />
      <span>{{ isStoppingAppSession ? t("sessions.actions.closingSession") : t("sessions.actions.closeSession") }}</span>
    </ContextMenuItem>
  </ContextMenuContent>
</template>

<script setup lang="ts">
import { Check, ExternalLink, Split, Square, SquareTerminal, Zap } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { ControlPlaneTrigger } from "../../api/types";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "../ui/context-menu";

const { t } = useI18n();

defineProps<{
  boundTriggerCount: number;
  hasAppSession: boolean;
  canOpenApp: boolean;
  canOpenTerminal?: boolean;
  canFork?: boolean;
  isForking?: boolean;
  isOpeningTerminal?: boolean;
  isStoppingAppSession?: boolean;
  isTriggerBound: (configHash: string) => boolean;
  isTriggerBusy: (configHash: string) => boolean;
  shortHash: (value: string) => string;
  triggerTemplates: ControlPlaneTrigger[];
}>();

defineEmits<{
  closeSession: [];
  openApp: [];
  openTerminal: [];
  forkSession: [mode: "current" | "managed-worktree"];
  toggleTrigger: [configHash: string];
}>();
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
</style>
