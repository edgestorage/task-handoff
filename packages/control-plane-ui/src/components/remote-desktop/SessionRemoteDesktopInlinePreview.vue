<template>
  <div
    class="session-remote-desktop-inline"
    role="button"
    tabindex="0"
    :aria-label="t('instances.remoteDesktop.openDetails')"
    @click="$emit('openDetails')"
    @keydown.enter.prevent="$emit('openDetails')"
    @keydown.space.prevent="$emit('openDetails')"
  >
    <SessionRemoteDesktopSurface
      :capabilities="capabilities"
      :initial-target="target"
      :instance-id="instanceId"
      :session-id="sessionId"
      preview
      @selection-change="$emit('selectionChange', $event)"
      @stream-size="setStreamSize"
    />
    <span class="session-remote-desktop-inline-hint">
      <ExternalLink :size="12" aria-hidden="true" />
      {{ t("instances.remoteDesktop.previewHint") }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ExternalLink } from "@lucide/vue";
import SessionRemoteDesktopSurface from "./SessionRemoteDesktopSurface.vue";
import type { SessionRemoteDesktopTarget } from "../../apps/control-plane/instance-detail/sessionRemoteDesktopLinks.ts";

const props = defineProps<{
  capabilities?: Record<string, unknown>;
  instanceId: string;
  sessionId: string;
  target: SessionRemoteDesktopTarget;
}>();

defineEmits<{
  openDetails: [];
  selectionChange: [target: SessionRemoteDesktopTarget];
}>();

const { t } = useI18n();
const streamSize = ref({ width: props.target.width, height: props.target.height });
const aspectRatio = computed(() => streamSize.value.width > 0 && streamSize.value.height > 0
  ? `${streamSize.value.width} / ${streamSize.value.height}`
  : "16 / 9");

function setStreamSize(size: { width: number; height: number }) {
  if (size.width > 0 && size.height > 0) streamSize.value = size;
}
</script>

<style scoped>
.session-remote-desktop-inline {
  position: relative;
  width: 100%;
  max-height: 52vh;
  aspect-ratio: v-bind(aspectRatio);
  overflow: hidden;
  border: 1px solid var(--line-subtle);
  border-top: 0;
  border-radius: 0 0 14px 14px;
  background: #000;
  cursor: pointer;
}

.session-remote-desktop-inline :deep(.remote-desktop-viewer) {
  width: 100%;
  height: 100%;
}

.session-remote-desktop-inline:focus-visible {
  outline: 2px solid var(--brand-accent);
  outline-offset: -2px;
}

.session-remote-desktop-inline-hint {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: calc(100% - 16px);
  padding: 4px 8px;
  overflow: hidden;
  border-radius: 999px;
  background: rgb(0 0 0 / 58%);
  color: #fff;
  font-size: 12px;
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
</style>
