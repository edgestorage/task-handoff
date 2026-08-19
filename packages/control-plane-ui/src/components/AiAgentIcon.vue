<template>
  <span
    class="ai-agent-icon"
    :style="iconStyle"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import claudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode.svg?url";
import codexIcon from "@lobehub/icons-static-svg/icons/codex.svg?url";

const props = withDefaults(defineProps<{
  agent: "codex" | "claude";
  size?: number;
}>(), {
  size: 16,
});

const iconSources = {
  claude: claudeCodeIcon,
  codex: codexIcon,
} satisfies Record<typeof props.agent, string>;

const iconStyle = computed(() => ({
  "--ai-agent-icon-size": `${props.size}px`,
  "--ai-agent-icon-source": `url("${iconSources[props.agent]}")`,
}));
</script>

<style scoped>
.ai-agent-icon {
  display: block;
  flex: 0 0 auto;
  width: var(--ai-agent-icon-size);
  height: var(--ai-agent-icon-size);
  background: currentColor;
  mask: var(--ai-agent-icon-source) center / contain no-repeat;
}
</style>
