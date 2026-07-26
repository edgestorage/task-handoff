<template>
  <div class="repository-workspace-tab-surface">
    <div v-if="contextQuery.isPending.value" class="repository-workspace-tab-state">
      <LoaderCircle :size="18" />
      <span>{{ t("repository.workspace.loading") }}</span>
    </div>
    <RepositoryErrorNotice v-else-if="contextQuery.error.value" :error="contextQuery.error.value" :fallback="t('repository.errors.workspaceLoad')" />
    <RepositoryWorkspace
      v-else-if="contextQuery.data.value"
      :embedded="!dialogOpen"
      :context="contextQuery.data.value"
      :instance-id="instanceId"
      :initial-file-path="initialFilePath"
      :initial-file-request-id="initialFileRequestId"
      :open="true"
      :session-id="sessionId"
      :session-kind="sessionKind"
      @open-dialog="dialogOpen = true"
      @open-changes="$emit('openWorkspace', $event)"
      @open-tab="dialogOpen = false"
      @update:open="dialogOpen = $event"
    />
  </div>
</template>

<script setup lang="ts">
import type { RepositorySessionKind } from "@task-handoff/protocol/repository";
import { LoaderCircle } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRepositoryContextQuery } from "../../../api/repository";
import type { SessionTab } from "../useInstanceSessions";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import RepositoryWorkspace from "./RepositoryWorkspace.vue";

const props = defineProps<{ instanceId: string; session: SessionTab }>();
const { t } = useI18n();
defineEmits<{ openWorkspace: [target: { initialView: "files" | "changes"; page?: "workspace" | "changes-review"; sessionId: string; sessionKind: RepositorySessionKind }] }>();
const dialogOpen = ref(false);
const sessionId = computed(() => typeof props.session.source?.sessionId === "string" ? props.session.source.sessionId : "");
const sessionKind = computed<RepositorySessionKind>(() => props.session.source?.sessionKind === "ai-session" ? "ai-session" : "app-session");
const initialFilePath = computed(() => typeof props.session.source?.filePath === "string" ? props.session.source.filePath : undefined);
const initialFileRequestId = computed(() => typeof props.session.source?.fileRequestId === "number" ? props.session.source.fileRequestId : 0);
const contextQuery = useRepositoryContextQuery(
  computed(() => ({ instanceId: props.instanceId, sessionId: sessionId.value, sessionKind: sessionKind.value })),
  computed(() => Boolean(props.instanceId && sessionId.value)),
);
</script>

<style scoped>
.repository-workspace-tab-surface { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--workspace-bg); }
.repository-workspace-tab-state { display: flex; height: 100%; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 12px; }
.repository-workspace-tab-state svg { animation: repository-workspace-tab-spin 0.9s linear infinite; }
@keyframes repository-workspace-tab-spin { to { transform: rotate(360deg); } }
</style>
