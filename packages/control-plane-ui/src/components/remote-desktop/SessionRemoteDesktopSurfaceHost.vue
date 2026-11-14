<template>
  <div ref="parking" class="session-desktop-parking" inert />
  <template v-if="parking">
    <Teleport v-for="group in surfaces.groups.value" :key="group.key" :to="group.primary?.element || parking">
      <InstanceRemoteDesktopViewer
        :instance-id="group.instanceId"
        :capabilities="group.capabilities"
        :initial-target="group.target"
        :auto-connect="group.active"
        :active="group.active"
        :preview="group.preview"
        :can-manage="canManage"
        embedded
        @selection-change="remember(group.key, group.instanceId, group.sessionId, $event)"
        @frame="surfaces.frame(group.key, $event)"
        @stopped="stop(group.instanceId, group.sessionId)"
      />
    </Teleport>
  </template>
</template>
<script setup lang="ts">
import { ref } from "vue";
import InstanceRemoteDesktopViewer from "../../apps/control-plane/instance-detail/InstanceRemoteDesktopViewer.vue";
import type { SessionRemoteDesktopSurfaces } from "../../apps/control-plane/instance-detail/sessionRemoteDesktopSurfaces.ts";
import { rememberSessionRemoteDesktopLink, removeSessionRemoteDesktopLink, type SessionRemoteDesktopTarget } from "../../apps/control-plane/instance-detail/sessionRemoteDesktopLinks.ts";
import { requestCloseSessionRemoteDesktop } from "../../apps/control-plane/instance-detail/sessionRemoteDesktopEvents.ts";
const props = defineProps<{ surfaces: SessionRemoteDesktopSurfaces; canManage: boolean }>();
const parking = ref<HTMLElement>();
function remember(key: string, instanceId: string, sessionId: string, target: SessionRemoteDesktopTarget) {
  rememberSessionRemoteDesktopLink({ instanceId, sessionId, target });
  props.surfaces.selection(key, target);
}
function stop(instanceId: string, sessionId: string) {
  removeSessionRemoteDesktopLink(instanceId, sessionId);
  props.surfaces.forget(instanceId, sessionId);
  requestCloseSessionRemoteDesktop({ instanceId, sessionId });
}
</script>
<style scoped>
.session-desktop-parking { display: none; }
</style>
