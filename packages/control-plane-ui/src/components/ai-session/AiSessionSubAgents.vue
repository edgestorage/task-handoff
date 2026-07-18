<template>
  <section v-if="subAgents.length" class="ai-session-sub-agents" aria-label="Sub-agent activity">
    <button
      type="button"
      class="ai-session-sub-agents-toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span>{{ summary }}</span>
      <ChevronDown :size="14" :class="{ open: expanded }" aria-hidden="true" />
    </button>
    <div v-if="expanded" class="ai-session-sub-agents-list">
      <article
        v-for="agent in subAgents"
        :key="agent.threadId"
        class="ai-session-sub-agent"
        :data-state="agent.status"
      >
        <div class="ai-session-sub-agent-heading">
          <strong :title="agent.threadId">{{ agent.path || agent.threadId }}</strong>
          <span>{{ statusLabel(agent.status) }}</span>
        </div>
        <p v-if="agent.message">{{ agent.message }}</p>
        <small v-if="agent.activity || agent.updatedAt" :title="agent.updatedAt || undefined">
          <span v-if="agent.activity">{{ activityLabel(agent.activity) }}</span>
          <time v-if="agent.updatedAt" :datetime="agent.updatedAt">{{ formatUpdatedAt(agent.updatedAt) }}</time>
        </small>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import type { AiSessionSubAgent } from "../../api/types";

const props = defineProps<{
  subAgents: AiSessionSubAgent[];
}>();

function isActiveOrProblem(agent: AiSessionSubAgent) {
  return ["pending-init", "running", "interrupted", "errored"].includes(agent.status);
}

function defaultExpanded(agents: AiSessionSubAgent[]) {
  return agents.some(isActiveOrProblem);
}

const expanded = ref(defaultExpanded(props.subAgents));
const agentsRevision = computed(() => props.subAgents
  .map((agent) => `${agent.threadId}:${agent.status}`)
  .join("|"));

watch(agentsRevision, () => {
  expanded.value = defaultExpanded(props.subAgents);
});

const statusOrder: AiSessionSubAgent["status"][] = [
  "running",
  "pending-init",
  "errored",
  "interrupted",
  "completed",
  "shutdown",
  "not-found",
];

const summary = computed(() => {
  const counts = new Map<AiSessionSubAgent["status"], number>();
  for (const agent of props.subAgents) {
    counts.set(agent.status, (counts.get(agent.status) || 0) + 1);
  }
  const parts = statusOrder
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${statusLabel(status).toLowerCase()}`);
  return `Sub-agents · ${parts.join(" · ")}`;
});

function statusLabel(status: AiSessionSubAgent["status"]) {
  switch (status) {
    case "pending-init": return "Pending";
    case "running": return "Running";
    case "interrupted": return "Interrupted";
    case "completed": return "Completed";
    case "errored": return "Errored";
    case "shutdown": return "Shutdown";
    case "not-found": return "Not found";
  }
}

function activityLabel(activity: NonNullable<AiSessionSubAgent["activity"]>) {
  switch (activity) {
    case "started": return "Started";
    case "interacted": return "Interacted";
    case "interrupted": return "Interrupted";
  }
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
</script>

<style scoped>
.ai-session-sub-agents {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.ai-session-sub-agents-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  padding: 0;
  text-align: left;
}

.ai-session-sub-agents-toggle span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-sub-agents-toggle svg {
  flex: 0 0 auto;
  transition: transform 160ms ease;
}

.ai-session-sub-agents-toggle svg.open {
  transform: rotate(180deg);
}

.ai-session-sub-agents-list {
  display: grid;
  gap: 6px;
}

.ai-session-sub-agent {
  display: grid;
  gap: 5px;
  min-width: 0;
  border-left: 2px solid var(--line);
  padding: 3px 0 3px 9px;
}

.ai-session-sub-agent[data-state="running"] {
  border-left-color: var(--status-info, var(--accent));
}

.ai-session-sub-agent[data-state="completed"] {
  border-left-color: var(--status-success);
}

.ai-session-sub-agent[data-state="interrupted"] {
  border-left-color: var(--status-warning);
}

.ai-session-sub-agent[data-state="errored"] {
  border-left-color: var(--status-danger);
}

.ai-session-sub-agent-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.ai-session-sub-agent-heading strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-sub-agent-heading span {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: 11px;
}

.ai-session-sub-agent p {
  margin: 0;
  color: var(--text);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.ai-session-sub-agent small {
  display: flex;
  gap: 8px;
  color: var(--text-muted);
  font-size: 11px;
}

@media (prefers-reduced-motion: reduce) {
  .ai-session-sub-agents-toggle svg {
    transition: none;
  }
}
</style>
