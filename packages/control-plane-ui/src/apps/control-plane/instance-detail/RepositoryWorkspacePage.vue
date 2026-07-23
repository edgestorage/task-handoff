<template>
  <main class="repository-workspace-page">
    <RepositoryWorkspace
      v-if="context && route"
      :context="context"
      :initial-view="route.view"
      :instance-id="route.instanceId"
      :open="true"
      :session-id="route.sessionId"
      :session-kind="route.sessionKind"
      standalone
      @update:open="closeWindow"
    />
    <section v-else class="repository-workspace-page-state" role="status">
      <FolderGit2 :size="34" />
      <strong>{{ loading ? "Loading repository" : "Repository workspace unavailable" }}</strong>
      <span>{{ loading ? "Resolving the session repository context." : errorMessage }}</span>
      <Button v-if="!loading" variant="outline" @click="closeWindow">Close window</Button>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { RepositoryContext } from "@task-handoff/protocol/repository";
import { FolderGit2 } from "@lucide/vue";
import { onMounted, ref } from "vue";
import { getRepositoryContext } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import RepositoryWorkspace from "./RepositoryWorkspace.vue";
import { parseRepositoryWorkspaceRoute } from "./repositoryWorkspaceWindow";

const route = parseRepositoryWorkspaceRoute(window.location);
const context = ref<RepositoryContext>();
const loading = ref(Boolean(route));
const errorMessage = ref(route ? "The repository context could not be loaded." : "The workspace link is missing a valid instance or session target.");

onMounted(async () => {
  if (!route) return;
  document.title = "Repository · TaskHandoff";
  try {
    const result = await getRepositoryContext(route);
    if (result.availability !== "available") {
      errorMessage.value = `Repository unavailable: ${result.availability}.`;
      return;
    }
    context.value = result;
    document.title = `${result.displayName || "Repository"} · TaskHandoff`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
});

function closeWindow() {
  window.close();
  window.setTimeout(() => window.location.assign("/"), 50);
}
</script>

<style scoped>
.repository-workspace-page { min-height: 100%; background: var(--workspace-bg); }
.repository-workspace-page-state { display: flex; min-height: 100vh; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: var(--text-muted); padding: 24px; text-align: center; }
.repository-workspace-page-state strong { color: var(--text-strong); font-size: 16px; }
.repository-workspace-page-state span { max-width: 560px; font-size: 12px; line-height: 1.5; }
.repository-workspace-page-state :deep(button) { margin-top: 4px; }
</style>
