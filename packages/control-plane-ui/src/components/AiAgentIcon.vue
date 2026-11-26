<template>
  <span
    v-if="iconSource"
    class="ai-agent-icon"
    :style="iconStyle"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import claudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode.svg?url";
import codexIcon from "@lobehub/icons-static-svg/icons/codex.svg?url";
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek.svg?url";
import opencodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg?url";
import commandCodeIcon from "../assets/command-code.svg?url";
import geminiIcon from "../assets/gemini.svg?url";
import { isAiAgentId, type AiAgentId } from "./aiAgentIcon";

const props = withDefaults(defineProps<{
  agent?: string;
  size?: number;
}>(), {
  size: 16,
});

const iconSources: Record<AiAgentId, string> = {
  claude: claudeCodeIcon,
  codex: codexIcon,
  commandcode: commandCodeIcon,
  dsh: deepseekIcon,
  gemini: geminiIcon,
  opencode: opencodeIcon,
};

const iconSource = computed(() => isAiAgentId(props.agent) ? iconSources[props.agent] : undefined);

const iconStyle = computed(() => ({
  "--ai-agent-icon-size": `${props.size}px`,
  "--ai-agent-icon-source": `url("${iconSource.value}")`,
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
