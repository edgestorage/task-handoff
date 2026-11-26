<template>
  <DropdownMenuContent
    class="ai-session-model-menu"
    :side="side"
    :align="align"
    :collision-padding="collisionPadding"
    :side-offset="sideOffset"
  >
    <div class="ai-session-model-menu__body">
      <ScrollArea
        type="scroll"
        :horizontal="false"
        class="ai-session-model-menu__scroll"
      >
        <div class="ai-session-model-menu__list">
          <template v-if="showFollowSession">
            <DropdownMenuItem
              class="ai-session-model-menu__item ai-session-model-menu__provider-item"
              :class="{ 'ai-session-model-menu__item--selected': followSessionSelected }"
              @select="emit('selectFollowSession')"
            >
              <Bot class="ai-session-model-menu__icon" :size="17" />
              <span class="ai-session-model-menu__copy">
                <strong>{{ followSessionLabel }}</strong>
                <small v-if="followSessionDescription">{{ followSessionDescription }}</small>
              </span>
              <Check v-if="followSessionSelected" class="ai-session-model-menu__check" :size="16" />
            </DropdownMenuItem>
            <DropdownMenuSeparator v-if="modelGroups.length || noModelConfigured" />
          </template>
          <template v-if="noModelConfigured">
            <DropdownMenuItem
              class="ai-session-model-menu__item ai-session-model-menu__provider-item"
              @select="emit('openModelSettings')"
            >
              <Settings class="ai-session-model-menu__icon" :size="17" />
              <span class="ai-session-model-menu__copy">
                <strong>{{ t("sessions.composer.noModelConfigured") }}</strong>
                <small>{{ t("sessions.composer.openModelSettings") }}</small>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator v-if="modelGroups.length" />
          </template>
          <template v-for="group in modelGroups" :key="group.modelEntityId">
            <DropdownMenuSub v-if="group.models.length > 1">
              <DropdownMenuSubTrigger
                class="ai-session-model-menu__item ai-session-model-menu__provider-item"
                :class="{ 'ai-session-model-menu__item--selected': selectedModelNameForGroup(group) }"
              >
                <Waypoints class="ai-session-model-menu__icon" :size="17" />
                <span class="ai-session-model-menu__copy">
                  <strong>{{ group.providerName }}</strong>
                  <small v-if="modelGroupSubtitle(group)">{{ modelGroupSubtitle(group) }}</small>
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="ai-session-model-menu ai-session-model-menu--nested" :collision-padding="collisionPadding">
                <DropdownMenuItem
                  v-for="model in group.models"
                  :key="`${model.modelEntityId}:${model.modelName}`"
                  class="ai-session-model-menu__item"
                  :class="{ 'ai-session-model-menu__item--selected': isSelectedModel(model) }"
                  @select="emit('selectModel', { modelEntityId: model.modelEntityId, modelName: model.modelName, modelUpstreamName: model.modelUpstreamName })"
                >
                  <span class="ai-session-model-menu__copy"><strong>{{ model.modelName }}</strong></span>
                  <Check v-if="isSelectedModel(model)" class="ai-session-model-menu__check" :size="16" />
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              v-else
              class="ai-session-model-menu__item ai-session-model-menu__provider-item"
              :class="{ 'ai-session-model-menu__item--selected': isSelectedModel(group.models[0]) }"
              @select="emit('selectModel', { modelEntityId: group.models[0].modelEntityId, modelName: group.models[0].modelName, modelUpstreamName: group.models[0].modelUpstreamName })"
            >
              <Waypoints class="ai-session-model-menu__icon" :size="17" />
              <span class="ai-session-model-menu__copy">
                <strong>{{ group.providerName }}</strong>
                <small>{{ group.models[0].modelName }}</small>
              </span>
              <Check v-if="isSelectedModel(group.models[0])" class="ai-session-model-menu__check" :size="16" />
            </DropdownMenuItem>
          </template>
        </div>
      </ScrollArea>
      <template v-if="reasoningEffortEnabled">
        <DropdownMenuSeparator v-if="showFollowSession || noModelConfigured || modelGroups.length" />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger class="ai-session-model-menu__item ai-session-model-menu__provider-item">
            <BrainCircuit class="ai-session-model-menu__icon" :size="17" />
            <span class="ai-session-model-menu__copy">
              <strong>{{ t("sessions.composer.reasoningEffort") }}</strong>
              <small v-if="reasoningEffortLabel">{{ reasoningEffortLabel }}</small>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="ai-session-model-menu ai-session-model-menu--nested ai-session-reasoning-menu" :collision-padding="collisionPadding">
            <DropdownMenuItem
              v-if="reasoningFollowSessionLabel"
              class="ai-session-model-menu__item"
              :class="{ 'ai-session-model-menu__item--selected': reasoningEffort === 'session' }"
              @select="emit('selectReasoningFollowSession')"
            >
              <span class="ai-session-model-menu__copy"><strong>{{ reasoningFollowSessionLabel }}</strong></span>
              <Check v-if="reasoningEffort === 'session'" class="ai-session-model-menu__check" :size="16" />
            </DropdownMenuItem>
            <DropdownMenuSeparator v-if="reasoningFollowSessionLabel && availableReasoningEfforts.length" />
            <DropdownMenuItem
              v-for="effort in availableReasoningEfforts"
              :key="effort"
              class="ai-session-model-menu__item"
              :class="{ 'ai-session-model-menu__item--selected': reasoningEffort === effort }"
              @select="emit('selectReasoningEffort', effort)"
            >
              <span class="ai-session-model-menu__copy"><strong>{{ effort }}</strong></span>
              <Check v-if="reasoningEffort === effort" class="ai-session-model-menu__check" :size="16" />
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </template>
    </div>
  </DropdownMenuContent>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Bot, BrainCircuit, Check, Settings, Waypoints } from "@lucide/vue";
import type { AiSessionModelGroup } from "@task-handoff/control-plane-client";
import type { AiSessionModelSelection, AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "../ui/dropdown-menu";
import { ScrollArea } from "../ui/scroll-area";
import { supportedAiSessionReasoningEfforts } from "./aiSessionReasoningEfforts";
import { sameModelSelectionRef } from "./modelSelectionRef";

/**
 * AI 会话、Agent 编辑器和实例建议设置共用的模型菜单：按模型连接分组，
 * 组内选择具体模型，推理档位作为同一菜单里的子项。
 */
const props = withDefaults(defineProps<{
  modelGroups: AiSessionModelGroup[];
  modelSelection?: AiSessionModelSelection;
  reasoningEffort?: AiSessionReasoningEffort | "session";
  reasoningEfforts?: readonly AiSessionReasoningEffort[];
  reasoningEffortEnabled?: boolean;
  showFollowSession?: boolean;
  followSessionSelected?: boolean;
  followSessionLabel?: string;
  followSessionDescription?: string;
  reasoningFollowSessionLabel?: string;
  /** 目录为空且没有已选模型时，菜单顶部引导用户前往模型设置。 */
  noModelConfigured?: boolean;
  /** 运行会话的 agent（codex、claude 等）；决定可选的推理档位。 */
  agent?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  collisionPadding?: number;
  sideOffset?: number;
}>(), {
  side: "top",
  align: "end",
  collisionPadding: 12,
  sideOffset: 8,
});

const emit = defineEmits<{
  selectModel: [value: AiSessionModelSelection];
  selectReasoningEffort: [value: AiSessionReasoningEffort];
  selectFollowSession: [];
  selectReasoningFollowSession: [];
  openModelSettings: [];
}>();

const { t } = useI18n();
const availableReasoningEfforts = computed(() => props.reasoningEfforts ?? supportedAiSessionReasoningEfforts(props.agent));
const reasoningEffortLabel = computed(() => props.reasoningEffort === "session"
  ? props.reasoningFollowSessionLabel
  : props.reasoningEffort);

function isSelectedModel(model: AiSessionModelSelection) {
  return Boolean(props.modelSelection) && sameModelSelectionRef(model, props.modelSelection!);
}

function selectedModelNameForGroup(group: AiSessionModelGroup) {
  const selection = props.modelSelection;
  if (!selection || selection.modelEntityId !== group.modelEntityId) return undefined;
  // Show the entry's current label: a stored selection keeps its stable
  // identity, but the display label may have been renamed since.
  return group.models.find((candidate) => sameModelSelectionRef(candidate, selection))?.modelName
    ?? selection.modelName;
}

function modelGroupSubtitle(group: AiSessionModelGroup) {
  const selected = selectedModelNameForGroup(group);
  if (selected) return selected;
  const first = group.models[0]?.modelName || "";
  return group.models.length > 1
    ? t("sessions.composer.modelGroupSummary", { model: first, count: group.models.length })
    : first;
}
</script>

<style scoped>
:global(.ai-session-model-menu) {
  display: flex;
  flex-direction: column;
  width: min(292px, var(--reka-dropdown-menu-content-available-width));
  max-height: min(480px, var(--reka-dropdown-menu-content-available-height));
  overflow: hidden;
  padding: 5px;
}

:global(.ai-session-model-menu__body) {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

:global(.ai-session-model-menu__scroll) {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  max-height: min(420px, calc(var(--reka-dropdown-menu-content-available-height) - 64px));
  flex-direction: column;
  min-width: 0;
}

:global(.ai-session-model-menu__scroll > [data-reka-scroll-area-viewport]) {
  height: auto;
  min-height: 0;
  flex: 1 1 auto;
}

:global(.ai-session-model-menu__list) {
  display: grid;
  gap: 1px;
}

:global(.ai-session-model-menu__item) {
  min-height: 42px;
  gap: 10px;
  border-radius: 6px;
  padding: 7px 9px;
}

:global(.ai-session-model-menu__provider-item) {
  align-items: center;
}

:global(.ai-session-model-menu__icon) {
  flex: 0 0 auto;
  color: hsl(var(--muted-foreground));
}

:global(.ai-session-model-menu__copy) {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  gap: 1px;
}

:global(.ai-session-model-menu__copy strong) {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.ai-session-model-menu__copy small) {
  overflow: hidden;
  color: hsl(var(--muted-foreground));
  font-size: 12px;
  font-weight: 400;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.ai-session-model-menu__check) {
  flex: 0 0 auto;
  margin-left: auto;
}

:global(.ai-session-model-menu__item--selected) {
  background: var(--surface-active);
  color: var(--text-strong);
}

:global(.ai-session-model-menu__item--selected .ai-session-model-menu__icon),
:global(.ai-session-model-menu__item--selected .ai-session-model-menu__check) {
  color: hsl(var(--primary));
}

:global(.ai-session-model-menu__item:is(:focus, [data-highlighted])),
:global(.ai-session-model-menu__provider-item[data-state="open"]) {
  background: var(--surface-hover);
  color: var(--text-strong);
}

:global(.ai-session-model-menu--nested) {
  width: min(220px, var(--reka-dropdown-menu-content-available-width));
  max-height: min(360px, var(--reka-dropdown-menu-content-available-height));
}

:global(.ai-session-model-menu--nested .ai-session-model-menu__item) {
  min-height: 32px;
  gap: 8px;
  padding: 5px 8px;
}

:global(.ai-session-model-menu--nested .ai-session-model-menu__copy strong) {
  line-height: 16px;
}

:global(.ai-session-reasoning-menu) {
  width: min(190px, var(--reka-dropdown-menu-content-available-width));
}

:global(.ai-session-reasoning-menu .ai-session-model-menu__item) {
  min-height: 30px;
}
</style>
