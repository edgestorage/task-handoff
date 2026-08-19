<template>
  <AiAgentIcon v-if="agent" :agent="agent" :size="size" />
  <SquareTerminal v-else-if="terminalAppIds.has(appId)" :size="size" aria-hidden="true" />
  <Play v-else :size="size" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Play, SquareTerminal } from "@lucide/vue";
import AiAgentIcon from "../../../components/AiAgentIcon.vue";

const props = withDefaults(defineProps<{
  appId: string;
  size?: number;
}>(), {
  size: 14,
});

const terminalAppIds = new Set(["terminal", "terminal-tty", "gui-terminal"]);
const agent = computed<"codex" | "claude" | undefined>(() => (
  props.appId === "codex" || props.appId === "claude" ? props.appId : undefined
));
</script>
