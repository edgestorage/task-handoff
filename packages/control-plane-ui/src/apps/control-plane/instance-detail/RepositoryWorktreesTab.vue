<template>
  <div class="repository-worktrees-tab-surface">
    <RepositoryWorktreesPanel
      :ai-agent="aiAgent"
      :instance-id="instanceId"
      :open="true"
      :cwd-folder-id="cwdFolderId"
      :session-id="sessionId"
      :session-kind="sessionKind"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { RepositorySessionKind } from "@task-handoff/protocol/repository";
import type { SessionTab } from "../useInstanceSessions";
import RepositoryWorktreesPanel from "./RepositoryWorktreesPanel.vue";

const props = defineProps<{ instanceId: string; session: SessionTab }>();
const cwdFolderId = computed(() => typeof props.session.source?.cwdFolderId === "string" ? props.session.source.cwdFolderId : undefined);
const sessionId = computed(() => typeof props.session.source?.sessionId === "string" ? props.session.source.sessionId : undefined);
const sessionKind = computed<RepositorySessionKind | undefined>(() => props.session.source?.sessionKind === "ai-session" || props.session.source?.sessionKind === "app-session"
  ? props.session.source.sessionKind
  : undefined);
const aiAgent = computed<"codex" | "claude" | "opencode" | undefined>(() => {
  const agent = props.session.source?.aiAgent;
  return agent === "codex" || agent === "claude" || agent === "opencode" ? agent : undefined;
});
</script>

<style scoped>
.repository-worktrees-tab-surface {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--workspace-bg);
}
</style>
