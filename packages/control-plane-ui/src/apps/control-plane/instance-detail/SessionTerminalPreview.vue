<template>
  <div ref="terminalHost" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, toRef, watch } from "vue";
import { useTerminalPreview } from "../useTerminalPreview";

const props = defineProps<{
  active: boolean;
  cacheKey: string;
  cacheScope: string;
  socketUrl: string;
}>();

const terminalHost = ref<HTMLElement | null>(null);
const cacheKey = toRef(props, "cacheKey");
const cacheScope = toRef(props, "cacheScope");
const socketUrl = toRef(props, "socketUrl");
const active = toRef(props, "active");
const { detachTerminalPreview, mountTerminalPreview } = useTerminalPreview(cacheScope, cacheKey, socketUrl, terminalHost, active);

watch(
  [active, cacheScope, cacheKey, socketUrl, terminalHost],
  ([active]) => {
    if (active) {
      void mountTerminalPreview();
    } else {
      detachTerminalPreview();
    }
  },
  { flush: "post", immediate: true },
);

onBeforeUnmount(detachTerminalPreview);
</script>
