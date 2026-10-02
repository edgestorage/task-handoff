<template>
  <AiAgentIcon v-if="agent" :agent="agent" :size="size" />
  <SquareTerminal v-else-if="iconKind === 'terminal'" :size="size" aria-hidden="true" />
  <Globe2 v-else-if="iconKind === 'browser' || iconKind === 'web'" :size="size" aria-hidden="true" />
  <Monitor v-else-if="iconKind === 'desktop'" :size="size" aria-hidden="true" />
  <Play v-else :size="size" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Globe2, Monitor, Play, SquareTerminal } from "@lucide/vue";
import AiAgentIcon from "../../../components/AiAgentIcon.vue";
import { AI_AGENT_APP_IDS, appLaunchIconKind, type AppLaunchIconIdentity } from "./appLaunchIcon";

const props = withDefaults(defineProps<{
  app: AppLaunchIconIdentity;
  size?: number;
}>(), {
  size: 14,
});

const iconKind = computed(() => appLaunchIconKind(props.app));
const agent = computed(() => AI_AGENT_APP_IDS.find((id) => id === props.app.id));
</script>
