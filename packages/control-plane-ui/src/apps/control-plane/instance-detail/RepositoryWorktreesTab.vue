<template>
  <div class="repository-worktrees-tab-surface">
    <RepositoryWorktreesPanel
      :ai-agent="aiAgent"
      appearance="page"
      :instance-id="instanceId"
      :open="true"
      :session-id="sessionId"
      :session-kind="sessionKind"
    />
  </div>
</template>

<script setup lang="ts">
import type { RepositorySessionKind } from "@task-handoff/protocol/repository";
import { computed } from "vue";
import type { SessionTab } from "../useInstanceSessions";
import RepositoryWorktreesPanel from "./RepositoryWorktreesPanel.vue";

const props = defineProps<{ instanceId: string; session: SessionTab }>();
const sessionId = computed(() => typeof props.session.source?.sessionId === "string" ? props.session.source.sessionId : "");
const sessionKind = computed<RepositorySessionKind>(() => props.session.source?.sessionKind === "ai-session" ? "ai-session" : "app-session");
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
