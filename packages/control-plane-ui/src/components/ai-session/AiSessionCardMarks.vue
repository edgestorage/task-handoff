<template>
  <span class="ai-session-card-marks" :data-terminal-origin="creationSource === 'app-session' ? 'true' : undefined">
    <span v-if="brandedAgent" class="ai-session-agent-mark" aria-hidden="true">
      <AiAgentIcon :agent="brandedAgent" :size="14" />
    </span>
    <AiSessionOriginMark :creation-source="creationSource" />
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import AiAgentIcon from "../AiAgentIcon.vue";
import AiSessionOriginMark from "./AiSessionOriginMark.vue";

const props = defineProps<{
  agent: string;
  creationSource?: "ai-session" | "app-session";
}>();

const brandedAgent = computed<"codex" | "claude" | "opencode" | undefined>(() => (
  props.agent === "codex" || props.agent === "claude" || props.agent === "opencode" ? props.agent : undefined
));
</script>

<style scoped>
.ai-session-card-marks {
  display: inline-flex;
  position: absolute;
  top: 7px;
  right: 8px;
  z-index: 2;
  align-items: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 140ms ease;
}

.ai-session-agent-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--text-muted);
  opacity: 0.56;
}
</style>
