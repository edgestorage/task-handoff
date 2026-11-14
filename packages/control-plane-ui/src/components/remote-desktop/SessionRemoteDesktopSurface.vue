<template>
  <div ref="element" class="session-desktop-surface">
    <canvas v-if="!primary" ref="mirror" aria-hidden="true" />
  </div>
</template>
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { desktopSessionSurfaceKey, sessionRemoteDesktopSurfacesKey, type DesktopFrame } from "../../apps/control-plane/instance-detail/sessionRemoteDesktopSurfaces.ts";
import type { SessionRemoteDesktopTarget } from "../../apps/control-plane/instance-detail/sessionRemoteDesktopLinks.ts";
const props = withDefaults(defineProps<{
  instanceId: string;
  sessionId: string;
  capabilities?: Record<string, unknown>;
  target?: SessionRemoteDesktopTarget;
  active?: boolean;
  preview?: boolean;
}>(), { active: true });
const emit = defineEmits<{ selectionChange: [target: SessionRemoteDesktopTarget]; streamSize: [size: { width: number; height: number }] }>();
const surfaces = inject(sessionRemoteDesktopSurfacesKey);
if (!surfaces) throw new Error("Session desktop surfaces require a workbench host");
const registry = surfaces;
const element = ref<HTMLElement>();
const mirror = ref<HTMLCanvasElement>();
const id = Symbol("desktop-surface");
const primary = computed(() => registry.groups.value.find(g => g.key === desktopSessionSurfaceKey(props.instanceId, props.sessionId))?.primary?.element === element.value);
function paint(frame: DesktopFrame) {
  const canvas = mirror.value;
  if (!canvas || !frame.width || !frame.height) return;
  // Read-only previews reuse already decoded pictures; no second media session.
  const scale = Math.min(1, 960 / frame.width, 540 / frame.height);
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.getContext("2d", { alpha: false })?.drawImage(frame.source, 0, 0, width, height);
}
watch(() => [element.value, props.instanceId, props.sessionId, props.capabilities, props.target, props.active, props.preview], () => {
  if (!element.value) return;
  registry.update(id, {
    instanceId: props.instanceId, sessionId: props.sessionId, element: element.value,
    capabilities: props.capabilities, target: props.target, active: props.active !== false, preview: props.preview === true,
    selectionChange: target => emit("selectionChange", target), streamSize: size => emit("streamSize", size), frame: paint,
  });
}, { immediate: true, flush: "post" });
onBeforeUnmount(() => registry.release(id));
</script>
<style scoped>
.session-desktop-surface { width: 100%; height: 100%; min-width: 0; min-height: 0; background: #000; }
.session-desktop-surface > canvas { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
</style>
