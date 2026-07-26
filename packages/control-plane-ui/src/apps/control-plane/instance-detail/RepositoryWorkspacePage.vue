<template>
  <main class="repository-workspace-page">
    <RepositoryWorkspace
      v-if="context && route"
      :context="context"
      :instance-id="route.instanceId"
      :open="true"
      :session-id="route.sessionId"
      :session-kind="route.sessionKind"
      standalone
      @update:open="closeWindow"
    />
    <section v-else class="repository-workspace-page-state" role="status">
      <FolderGit2 :size="34" />
      <strong>{{ loading ? t("repository.page.loading") : t("repository.page.unavailable") }}</strong>
      <span>{{ loading ? t("repository.page.resolving") : errorMessage }}</span>
      <Button v-if="!loading" variant="outline" @click="closeWindow">{{ t("repository.common.close") }}</Button>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { RepositoryContext } from "@task-handoff/protocol/repository";
import { FolderGit2 } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { getRepositoryContext } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { translateApiError } from "../../../i18n/apiError";
import RepositoryWorkspace from "./RepositoryWorkspace.vue";
import { parseRepositoryWorkspaceRoute } from "./repositoryWorkspaceWindow";

const route = parseRepositoryWorkspaceRoute(window.location);
const { t } = useI18n();
const context = ref<RepositoryContext>();
const loading = ref(Boolean(route));
const rawErrorMessage = ref("");
const unavailableState = ref("");
const errorMessage = computed(() => rawErrorMessage.value || (unavailableState.value
  ? t("repository.page.availability", { availability: unavailableState.value })
  : t(route ? "repository.page.contextLoad" : "repository.page.contextMissing")));

onMounted(async () => {
  if (!route) return;
  document.title = `${t("repository.title")} · TaskHandoff`;
  try {
    const result = await getRepositoryContext(route);
    if (result.availability !== "available") {
      unavailableState.value = result.availability;
      return;
    }
    context.value = result;
    document.title = `${result.displayName || t("repository.title")} · TaskHandoff`;
  } catch (error) {
    rawErrorMessage.value = translateApiError(error, t, t("repository.page.contextLoad"));
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
