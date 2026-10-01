<template>
  <div class="app-session-viewer" :data-state="viewerState" :data-compact="compact ? 'true' : undefined">
    <iframe
      v-if="viewerState === 'live'"
      ref="frame"
      class="app-session-viewer-frame"
      :src="src"
      :title="title"
      allow="clipboard-read; clipboard-write; fullscreen"
    />
    <div v-else class="app-session-viewer-paused" role="status">
      <CirclePause :size="compact ? 20 : 32" />
      <strong>{{ t("sessions.viewer.pausedTitle") }}</strong>
      <span v-if="!compact" class="app-session-viewer-paused-detail">{{ t("sessions.viewer.pausedDetail") }}</span>
      <Button size="sm" class="app-session-viewer-reconnect" @click.stop="reconnect">
        <RotateCw :size="14" />
        <span>{{ t("sessions.viewer.reconnect") }}</span>
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CirclePause, RotateCw } from "@lucide/vue";
import { Button } from "../../../components/ui/button";

const props = defineProps<{
  src: string;
  title: string;
  compact?: boolean;
}>();

const { t } = useI18n();
const frame = ref<HTMLIFrameElement>();
const viewerState = ref<"live" | "paused">("live");

// The embedded KasmVNC client only arms its idle timer while it runs inside an iframe: after its
// configured idle timeout it posts { action: "idle_session_timeout" } to the parent page and then
// navigates itself to its bundled disconnected.html, whose "Return to Dashboard" link points at
// "/". That link resolves against the control-plane origin, so the pane would end up showing the
// workbench instead of the session. App sessions own their own lifetime, so the parent keeps the
// state here: drop the frame as soon as the signal arrives and let the user reconnect explicitly.
function handleWindowMessage(event: MessageEvent) {
  if (viewerState.value !== "live" || event.source !== frame.value?.contentWindow) return;
  const payload = event.data as { action?: unknown } | null | undefined;
  if (!payload || typeof payload !== "object" || payload.action !== "idle_session_timeout") return;
  viewerState.value = "paused";
}

function reconnect() {
  viewerState.value = "live";
}

onMounted(() => window.addEventListener("message", handleWindowMessage));
onBeforeUnmount(() => window.removeEventListener("message", handleWindowMessage));
watch(() => props.src, () => {
  viewerState.value = "live";
});
</script>

<style scoped>
.app-session-viewer {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--terminal-bg);
}

.app-session-viewer-frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  background: var(--terminal-bg);
}

.app-session-viewer-paused {
  display: grid;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  place-items: center;
  align-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--terminal-text);
  text-align: center;
}

.app-session-viewer-paused > svg {
  color: var(--text-muted);
}

.app-session-viewer-paused strong {
  font-size: 18px;
}

.app-session-viewer-paused-detail {
  max-width: 620px;
  overflow-wrap: anywhere;
  color: var(--text-muted);
  font-size: 12px;
}

.app-session-viewer-reconnect {
  gap: 7px;
  margin-top: 8px;
}

.app-session-viewer-reconnect > span {
  color: inherit;
}

.app-session-viewer[data-compact="true"] .app-session-viewer-paused {
  gap: 6px;
  padding: 12px;
}

.app-session-viewer[data-compact="true"] .app-session-viewer-paused strong {
  font-size: 12px;
}
</style>
