<template>
  <TooltipProvider :delay-duration="120">
    <span class="ai-session-sticky-context">
      <span class="ai-session-sticky-context-surface">
        <span class="ai-session-sticky-context-agent">
          <AiAgentIcon :agent="agent" :size="14" />
        </span>
        <span class="ai-session-sticky-context-details">
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="ai-session-sticky-context-item">
                <Folder :size="14" aria-hidden="true" />
                <span>{{ folderName }}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ folderPath }}</TooltipContent>
          </Tooltip>
          <span class="ai-session-sticky-context-separator" aria-hidden="true">·</span>
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="ai-session-sticky-context-item">
                <Boxes :size="14" aria-hidden="true" />
                <span>{{ instanceName }}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ nodeName }}</TooltipContent>
          </Tooltip>
          <span class="ai-session-sticky-context-separator" aria-hidden="true">·</span>
          <span>{{ statusLabel }}</span>
        </span>
      </span>
    </span>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { Boxes, Folder } from "@lucide/vue";
import AiAgentIcon from "../AiAgentIcon.vue";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

defineProps<{
  agent: "codex" | "claude" | "opencode";
  folderName: string;
  folderPath: string;
  instanceName: string;
  nodeName: string;
  statusLabel: string;
}>();
</script>

<style scoped>
.ai-session-sticky-context {
  position: absolute;
  z-index: 2;
  top: var(--session-ai-sticky-padding-top);
  left: var(--ai-session-sticky-context-left, 0px);
  display: block;
  width: max-content;
  max-width: min(620px, calc(100% - var(--session-ai-fixed-actions-width, 160px) - 20px));
  height: var(--session-ai-sticky-prompt-height);
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  pointer-events: auto;
  cursor: default;
}

.ai-session-sticky-context::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 100%;
  width: 32px;
  background: linear-gradient(90deg, var(--workspace-bg) 0%, transparent 100%);
  content: "";
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease;
}

.ai-session-sticky-context-surface {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  width: max-content;
  max-width: 18px;
  height: 100%;
  overflow: hidden;
  gap: 6px;
  background: var(--workspace-bg);
  transition: max-width 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.ai-session-sticky-context:hover .ai-session-sticky-context-surface {
  max-width: min(620px, calc(100vw - 80px));
}

.ai-session-sticky-context:hover::after {
  opacity: 1;
}

.ai-session-sticky-context-agent {
  display: inline-flex;
  flex: 0 0 18px;
  align-items: center;
  justify-content: flex-start;
}

.ai-session-sticky-context-details {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-right: 8px;
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity 120ms ease, transform 180ms ease;
  white-space: nowrap;
}

.ai-session-sticky-context:hover .ai-session-sticky-context-details {
  opacity: 1;
  transform: translateX(0);
  transition-delay: 35ms;
}

.ai-session-sticky-context-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.ai-session-sticky-context-item > span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-session-sticky-context-separator {
  color: var(--text-faint);
}

@media (prefers-reduced-motion: reduce) {
  .ai-session-sticky-context::after,
  .ai-session-sticky-context-surface,
  .ai-session-sticky-context-details {
    transition-duration: 0ms;
    transition-delay: 0ms;
  }
}
</style>
