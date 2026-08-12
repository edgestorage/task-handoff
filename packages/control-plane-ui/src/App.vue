<template>
  <AppAccessView v-if="isAppAccessRoute" />
  <AuthGate v-else>
    <RepositoryWorkspacePage v-if="isRepositoryWorkspaceRoute" />
    <ControlPlaneWorkbench
      v-else
      :mode="isInstanceDetailPath ? 'standalone' : 'workbench'"
      :initial-instance-id="instanceDetailRoute?.instanceId"
    />
  </AuthGate>
  <Toaster position="top-right" rich-colors />
</template>

<script setup lang="ts">
import { computed } from "vue";
import AuthGate from "./apps/control-plane/AuthGate.vue";
import AppAccessView from "./apps/control-plane/app-access/AppAccessView.vue";
import ControlPlaneWorkbench from "./apps/control-plane/ControlPlaneWorkbench.vue";
import RepositoryWorkspacePage from "./apps/control-plane/instance-detail/RepositoryWorkspacePage.vue";
import { INSTANCE_DETAIL_ROUTE_PREFIX, parseInstanceDetailRoute } from "./apps/control-plane/instance-detail/instanceDetailWindow";
import { Toaster } from "./components/ui/sonner";

const isAppAccessRoute = computed(() => window.location.pathname.startsWith("/apps/access/"));
const isRepositoryWorkspaceRoute = computed(() => window.location.pathname === "/repository-workspace");
const instanceDetailRoute = computed(() => parseInstanceDetailRoute(window.location));
const isInstanceDetailPath = computed(() => window.location.pathname.startsWith(INSTANCE_DETAIL_ROUTE_PREFIX));
</script>
