<template>
  <div ref="terminalHost" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, toRef, watch } from "vue";
import { useTerminalPreview } from "../useTerminalPreview";

const props = defineProps<{
  active: boolean;
  socketUrl: string;
}>();

const terminalHost = ref<HTMLElement | null>(null);
const socketUrl = toRef(props, "socketUrl");
const active = toRef(props, "active");
const { disposeTerminalPreview, mountTerminalPreview } = useTerminalPreview(socketUrl, terminalHost, active);

watch(
  [() => props.active, socketUrl, terminalHost],
  ([active]) => {
    if (active) {
      void mountTerminalPreview();
    }
  },
  { flush: "post", immediate: true },
);

onBeforeUnmount(disposeTerminalPreview);
</script>
