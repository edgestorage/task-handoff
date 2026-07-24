<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="repository-environment-trigger"
        :class="{ 'repository-environment-trigger-detail': triggerAppearance === 'detail' }"
        aria-label="Environment"
        title="Environment"
      >
        <FolderGit2 :size="15" />
      </button>
    </PopoverTrigger>
    <PopoverContent
      class="repository-environment-popover"
      align="end"
      :side-offset="8"
    >
      <header class="repository-environment-head">
        <span class="repository-environment-title">
          <FolderGit2 :size="16" />
          <strong>Environment</strong>
        </span>
        <button
          type="button"
          class="repository-environment-refresh"
          aria-label="Refresh environment"
          title="Refresh environment"
          :disabled="contextQuery.isFetching.value || !canQuery"
          @click="contextQuery.refetch()"
        >
          <LoaderCircle v-if="contextQuery.isFetching.value" class="repository-environment-spin" :size="14" />
          <RefreshCw v-else :size="14" />
        </button>
      </header>

      <div v-if="connectionStatus !== 'online'" class="repository-environment-state" role="status">
        <CircleAlert :size="17" />
        <span>
          <strong>Instance offline</strong>
          <small>Reconnect the instance to inspect this session environment.</small>
        </span>
      </div>
      <div v-else-if="contextQuery.isPending.value" class="repository-environment-state" role="status">
        <LoaderCircle class="repository-environment-spin" :size="17" />
        <span>
          <strong>Reading environment</strong>
          <small>Resolving the session cwd and repository state.</small>
        </span>
      </div>
      <RepositoryErrorNotice v-else-if="contextQuery.error.value" :error="contextQuery.error.value" fallback="The instance did not return repository context." />
      <template v-else-if="context">
        <button
          type="button"
          class="repository-environment-row repository-environment-files"
          :disabled="context.availability !== 'available'"
          @click="openRepositoryWorkspace('files')"
        >
          <span class="repository-environment-row-icon"><Files :size="16" /></span>
          <span class="repository-environment-row-copy">
            <strong>Files / Changes</strong>
            <small v-if="context.availability === 'available'">{{ changeSummary }}</small>
            <small v-else>Repository files are unavailable</small>
          </span>
          <span v-if="changeCount" class="repository-environment-count">{{ changeCount }}</span>
          <ChevronRight :size="15" />
        </button>

        <button
          type="button"
          class="repository-environment-row repository-environment-review"
          :disabled="context.availability !== 'available'"
          @click="openChangesReview"
        >
          <span class="repository-environment-row-icon"><GitCompareArrows :size="16" /></span>
          <span class="repository-environment-row-copy">
            <strong>Review changes</strong>
            <small v-if="context.availability === 'available'">Changed files only · continuous diff review</small>
            <small v-else>Repository changes are unavailable</small>
          </span>
          <span v-if="changeCount" class="repository-environment-count">{{ changeCount }}</span>
          <ChevronRight :size="15" />
        </button>

        <div v-if="context.availability === 'available' && context.head?.state !== 'branch'" class="repository-environment-notice head-state" role="status">
          <GitCommitHorizontal :size="15" />
          <span v-if="context.head?.state === 'detached'">Detached HEAD at {{ context.head.oid?.slice(0, 8) || "unknown commit" }}. Create or checkout a branch before publishing.</span>
          <span v-else>Unborn branch with no commit yet. Create the first commit before delivery actions become available.</span>
        </div>

        <Popover v-model:open="worktreesOpen">
          <PopoverAnchor as-child>
            <button
              type="button"
              class="repository-environment-row"
              :disabled="context.availability !== 'available'"
              aria-haspopup="dialog"
              :aria-expanded="worktreesOpen"
              @click="worktreesOpen = !worktreesOpen"
            >
              <span class="repository-environment-row-icon"><GitFork :size="16" /></span>
              <span class="repository-environment-row-copy">
                <strong>Worktree</strong>
                <small v-if="context.currentWorktree">{{ worktreeSummary }}</small>
                <small v-else>{{ unavailableMessage }}</small>
              </span>
              <ChevronRight v-if="context.availability === 'available'" :size="15" />
            </button>
          </PopoverAnchor>
          <PopoverContent
            class="repository-worktrees-popover"
            side="left"
            align="start"
            :side-offset="10"
          >
            <RepositoryWorktreesPanel
              :ai-agent="aiAgent"
              :instance-id="instanceId"
              :open="worktreesOpen"
              :session-id="sessionId"
              :session-kind="sessionKind"
              @ai-session-started="emit('aiSessionStarted', $event)"
            />
          </PopoverContent>
        </Popover>

        <Popover v-model:open="branchesOpen">
          <PopoverAnchor as-child>
            <button
              type="button"
              class="repository-environment-row"
              :disabled="context.availability !== 'available'"
              aria-haspopup="dialog"
              :aria-expanded="branchesOpen"
              @click="toggleBranches"
            >
              <span class="repository-environment-row-icon"><GitBranch :size="16" /></span>
              <span class="repository-environment-row-copy">
                <strong>Branch</strong>
                <small class="repository-environment-branch-summary" :title="branchSummary">{{ branchSummary }}</small>
              </span>
              <ChevronRight v-if="context.availability === 'available'" :size="15" />
            </button>
          </PopoverAnchor>
          <PopoverContent class="repository-branches-popover" side="left" align="start" :side-offset="10">
            <RepositoryBranchesPanel
              :current-change-count="changeCount"
              :instance-id="instanceId"
              :open="branchesOpen"
              :session-id="sessionId"
              :session-kind="sessionKind"
            />
          </PopoverContent>
        </Popover>

        <button
          v-if="context.availability === 'available' && context.primaryAction"
          type="button"
          class="repository-environment-primary"
          :data-action="context.primaryAction"
          @click="runPrimaryAction(context.primaryAction)"
        >
          <GitCommitHorizontal :size="16" />
          <span>{{ primaryActionLabel }}</span>
          <ChevronRight :size="15" />
        </button>
        <div v-else-if="context.availability !== 'available'" class="repository-environment-notice" role="status">
          <CircleAlert :size="15" />
          <span>{{ unavailableMessage }}</span>
        </div>
      </template>
    </PopoverContent>
  </Popover>
  <RepositoryDeliveryDialog
    v-if="context"
    v-model:open="deliveryOpen"
    :context="context"
    :instance-id="instanceId"
    :session-id="sessionId"
    :session-kind="sessionKind"
  />
</template>

<script setup lang="ts">
import type { RepositoryContext, RepositoryPrimaryAction, RepositorySessionKind } from "@task-handoff/protocol/repository";
import { ChevronRight, CircleAlert, Files, FolderGit2, GitBranch, GitCommitHorizontal, GitCompareArrows, GitFork, LoaderCircle, RefreshCw } from "@lucide/vue";
import { computed, ref } from "vue";
import { useRepositoryContextQuery } from "../../../api/repository";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import RepositoryWorktreesPanel from "./RepositoryWorktreesPanel.vue";
import RepositoryBranchesPanel from "./RepositoryBranchesPanel.vue";
import RepositoryDeliveryDialog from "./RepositoryDeliveryDialog.vue";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";

const props = defineProps<{
  aiAgent?: "codex" | "claude";
  connectionStatus: string;
  instanceId: string;
  sessionId: string;
  sessionKind: RepositorySessionKind;
  triggerAppearance?: "toolbar" | "detail";
}>();

const emit = defineEmits<{
  aiSessionStarted: [result: import("@task-handoff/protocol/repository").RepositoryAiSessionLaunchResult];
  openWorkspace: [target: { initialView: "files" | "changes"; page?: "workspace" | "changes-review"; sessionId: string; sessionKind: RepositorySessionKind }];
}>();

const open = ref(false);
const worktreesOpen = ref(false);
const branchesOpen = ref(false);
const deliveryOpen = ref(false);
const canQuery = computed(() => props.connectionStatus === "online" && Boolean(props.instanceId && props.sessionId));
const contextQuery = useRepositoryContextQuery(
  computed(() => ({
    instanceId: props.instanceId,
    sessionKind: props.sessionKind,
    sessionId: props.sessionId,
  })),
  computed(() => open.value && canQuery.value),
);
const context = computed<RepositoryContext | undefined>(() => contextQuery.data.value);
const changeCount = computed(() => {
  const summary = context.value?.changes;
  return summary ? summary.conflicts + summary.staged + summary.unstaged + summary.untracked : 0;
});
const changeSummary = computed(() => {
  const summary = context.value?.changes;
  if (!summary || changeCount.value === 0) return "No local changes";
  const parts = [
    summary.conflicts ? `${summary.conflicts} conflict${summary.conflicts === 1 ? "" : "s"}` : "",
    summary.staged ? `${summary.staged} staged` : "",
    summary.unstaged ? `${summary.unstaged} unstaged` : "",
    summary.untracked ? `${summary.untracked} untracked` : "",
  ].filter(Boolean);
  return parts.join(" · ");
});
const worktreeSummary = computed(() => {
  const worktree = context.value?.currentWorktree;
  if (!worktree) return unavailableMessage.value;
  const occupied = worktree.activeAiSessionIds.length + worktree.activeAppSessionIds.length;
  const flags = [worktree.isMain ? "main" : worktree.managed ? "managed" : "external"];
  if (worktree.dirty) flags.push("dirty");
  if (occupied) flags.push(`${occupied} active session${occupied === 1 ? "" : "s"}`);
  return flags.join(" · ");
});
const branchSummary = computed(() => {
  const head = context.value?.head;
  if (!head) return unavailableMessage.value;
  if (head.state === "branch") {
    const tracking = context.value?.upstream;
    const sync = tracking && (tracking.ahead || tracking.behind)
      ? ` · ${tracking.ahead} ahead, ${tracking.behind} behind`
      : "";
    return `${head.branch || "Unknown branch"}${sync}`;
  }
  if (head.state === "unborn") return "Unborn branch";
  return `Detached at ${head.oid?.slice(0, 8) || "unknown commit"}`;
});
const unavailableMessage = computed(() => ({
  "session-not-found": "This session no longer exists.",
  "session-inactive": "This session is no longer active.",
  "cwd-missing": "This session has no recorded working directory.",
  "cwd-inaccessible": "The session working directory is inaccessible.",
  "git-unavailable": "Git is unavailable in this instance.",
  "not-worktree": "The current directory is not a Git repository.",
  available: "Repository available",
}[context.value?.availability || "cwd-missing"]));
const primaryActionLabel = computed(() => ({
  "review-changes": "Review changes",
  "resolve-conflicts": "Resolve conflicts",
  "publish-branch": "Publish branch",
  push: "Push",
  pull: "Pull",
  diverged: "Branch diverged",
  "up-to-date": "Up to date",
}[context.value?.primaryAction || "up-to-date"]));

function toggleBranches() {
  branchesOpen.value = !branchesOpen.value;
  if (branchesOpen.value) worktreesOpen.value = false;
}

function openRepositoryWorkspace(view: "files" | "changes") {
  emit("openWorkspace", { initialView: view, sessionId: props.sessionId, sessionKind: props.sessionKind });
  open.value = false;
}

function openChangesReview() {
  emit("openWorkspace", { initialView: "changes", page: "changes-review", sessionId: props.sessionId, sessionKind: props.sessionKind });
  open.value = false;
}

function runPrimaryAction(action: RepositoryPrimaryAction) {
  if (action === "review-changes" || action === "resolve-conflicts") {
    openChangesReview();
    return;
  }
  deliveryOpen.value = true;
  open.value = false;
}
</script>

<style scoped>
.repository-environment-trigger {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--control-plane-icon-button-border, var(--line-subtle));
  border-radius: 7px;
  background: var(--control-plane-icon-button-bg, var(--surface-subtle));
  color: var(--control-plane-icon-button-text, var(--text-muted));
  cursor: pointer;
  padding: 0;
}

.repository-environment-trigger:hover,
.repository-environment-trigger:focus-visible,
.repository-environment-trigger[data-state="open"] {
  border-color: var(--control-plane-icon-button-hover-border, var(--focus-ring));
  background: var(--control-plane-icon-button-hover-bg, var(--surface-elevated));
  color: var(--control-plane-icon-button-hover-text, var(--text));
}

.repository-environment-trigger-detail {
  width: 26px;
  height: 26px;
  border-color: var(--line-subtle);
  border-radius: 6px;
  background: var(--surface-subtle);
  color: var(--text-muted);
}

.repository-environment-trigger-detail:hover,
.repository-environment-trigger-detail:focus-visible,
.repository-environment-trigger-detail[data-state="open"] {
  border-color: var(--focus-ring);
  background: var(--surface-subtle);
  color: var(--text);
}

:global([role="dialog"].repository-environment-popover) {
  width: min(360px, calc(100vw - 24px));
  border-color: var(--line-subtle);
  border-radius: 12px;
  background: var(--surface-raised, var(--popover));
  padding: 8px;
  color: var(--text);
  box-shadow: 0 18px 52px rgb(0 0 0 / 0.34);
}

:global([role="dialog"].repository-worktrees-popover) {
  width: min(390px, calc(100vw - 24px));
  border-color: var(--line-subtle);
  border-radius: 12px;
  background: var(--surface-raised, var(--popover));
  padding: 8px;
  color: var(--text);
  box-shadow: 0 18px 52px rgb(0 0 0 / 0.34);
}

:global([role="dialog"].repository-branches-popover) {
  width: min(400px, calc(100vw - 24px));
  border-color: var(--line-subtle);
  border-radius: 12px;
  background: var(--surface-raised, var(--popover));
  padding: 8px;
  color: var(--text);
  box-shadow: 0 18px 52px rgb(0 0 0 / 0.34);
}

.repository-environment-head,
.repository-environment-title,
.repository-environment-row,
.repository-environment-primary,
.repository-environment-state,
.repository-environment-notice {
  display: flex;
  align-items: center;
}

.repository-environment-head {
  justify-content: space-between;
  padding: 5px 6px 9px 9px;
}

.repository-environment-title {
  gap: 8px;
  color: var(--text-strong);
}

.repository-environment-title strong {
  font-size: 13px;
  font-weight: 750;
}

.repository-environment-refresh {
  display: grid;
  width: 27px;
  height: 27px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
}

.repository-environment-refresh:hover:not(:disabled),
.repository-environment-refresh:focus-visible {
  background: var(--surface-subtle);
  color: var(--text);
}

.repository-environment-refresh:disabled {
  cursor: default;
  opacity: 0.55;
}

.repository-environment-row {
  width: 100%;
  min-height: 54px;
  gap: 10px;
  border: 0;
  border-top: 1px solid var(--line-subtle);
  background: transparent;
  color: inherit;
  padding: 8px 8px;
  text-align: left;
}

button.repository-environment-row {
  cursor: pointer;
}

button.repository-environment-row:hover:not(:disabled),
button.repository-environment-row:focus-visible {
  border-radius: 7px;
  background: var(--surface-subtle);
}

button.repository-environment-row:disabled {
  cursor: default;
  opacity: 0.72;
}

.repository-environment-row-icon {
  display: grid;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 7px;
  background: var(--surface-subtle);
  color: var(--text-muted);
}

.repository-environment-row-copy {
  display: grid;
  flex: 1 1 auto;
  gap: 2px;
  min-width: 0;
}

.repository-environment-row-copy strong {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 700;
}

.repository-environment-row-copy small,
.repository-environment-state small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.35;
  text-overflow: ellipsis;
}

.repository-environment-branch-summary {
  white-space: nowrap;
}

.repository-environment-count {
  min-width: 20px;
  border-radius: 999px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  font-size: 10px;
  line-height: 20px;
  text-align: center;
}

.repository-environment-primary {
  width: 100%;
  min-height: 38px;
  justify-content: flex-start;
  gap: 9px;
  margin-top: 7px;
  border: 1px solid var(--line-subtle);
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--text-strong);
  cursor: pointer;
  padding: 0 11px;
  font-size: 12px;
  font-weight: 700;
}

.repository-environment-primary:hover,
.repository-environment-primary:focus-visible {
  border-color: var(--focus-ring);
}

.repository-environment-primary svg:last-child {
  margin-left: auto;
}

.repository-environment-state {
  min-height: 78px;
  align-items: flex-start;
  gap: 10px;
  border-top: 1px solid var(--line-subtle);
  padding: 14px 10px 10px;
  color: var(--text-muted);
}

.repository-environment-state > span {
  display: grid;
  gap: 4px;
}

.repository-environment-state strong {
  color: var(--text-strong);
  font-size: 12px;
}

.repository-environment-state.error,
.repository-environment-notice {
  color: var(--status-warning);
}

.repository-environment-notice {
  align-items: flex-start;
  gap: 8px;
  margin-top: 7px;
  border-top: 1px solid var(--line-subtle);
  padding: 11px 9px 5px;
  font-size: 11px;
  line-height: 1.4;
}

.repository-environment-spin {
  animation: repository-environment-spin 0.9s linear infinite;
}

@keyframes repository-environment-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .repository-environment-spin { animation: none; }
}
</style>
