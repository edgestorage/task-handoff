<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="repository-environment-trigger"
        :class="{
          'repository-environment-trigger-detail': triggerAppearance === 'detail',
          'repository-environment-trigger-menu': triggerAppearance === 'menu',
        }"
        :aria-label="t('repository.environment.title')"
      >
        <TooltipProvider :delay-duration="120">
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="repository-environment-trigger-content">
              <FolderGit2 :size="triggerAppearance === 'menu' ? 16 : 15" />
              <span v-if="triggerAppearance === 'menu'">{{ t("repository.environment.title") }}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" :side-offset="8">{{ t("repository.environment.title") }}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
          <strong>{{ t("repository.environment.title") }}</strong>
        </span>
        <button
          type="button"
          class="repository-environment-refresh"
          :aria-label="t('repository.environment.refresh')"
          :title="t('repository.environment.refresh')"
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
          <strong>{{ t("repository.environment.offline") }}</strong>
          <small>{{ t("repository.environment.offlineHint") }}</small>
        </span>
      </div>
      <div v-else-if="contextQuery.isPending.value" class="repository-environment-state" role="status">
        <LoaderCircle class="repository-environment-spin" :size="17" />
        <span>
          <strong>{{ t("repository.environment.reading") }}</strong>
          <small>{{ t("repository.environment.readingHint") }}</small>
        </span>
      </div>
      <RepositoryErrorNotice v-else-if="contextQuery.error.value" :error="contextQuery.error.value" :fallback="t('repository.errors.contextLoad')" />
      <template v-else-if="context">
        <button
          type="button"
          class="repository-environment-row repository-environment-files"
          :disabled="context.availability !== 'available'"
          @click="openRepositoryWorkspace('files')"
        >
          <span class="repository-environment-row-icon"><Files :size="16" /></span>
          <span class="repository-environment-row-copy">
            <strong>{{ t("repository.environment.filesChanges") }}</strong>
            <small v-if="context.availability === 'available'">{{ changeSummary }}</small>
            <small v-else>{{ t("repository.environment.filesUnavailable") }}</small>
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
            <strong>{{ t("repository.environment.review") }}</strong>
            <small v-if="context.availability === 'available'">{{ t("repository.environment.reviewHint") }}</small>
            <small v-else>{{ t("repository.environment.changesUnavailable") }}</small>
          </span>
          <span v-if="changeCount" class="repository-environment-count">{{ changeCount }}</span>
          <ChevronRight :size="15" />
        </button>

        <div v-if="context.availability === 'available' && context.head?.state !== 'branch'" class="repository-environment-notice head-state" role="status">
          <GitCommitHorizontal :size="15" />
          <span v-if="context.head?.state === 'detached'">{{ t("repository.environment.detachedNotice", { commit: context.head.oid?.slice(0, 8) || t("repository.environmentExtra.unknownCommit") }) }}</span>
          <span v-else>{{ t("repository.environment.unbornNotice") }}</span>
        </div>

        <button
          type="button"
          class="repository-environment-row"
          :disabled="context.availability !== 'available'"
          @click="openWorktrees"
        >
          <span class="repository-environment-row-icon"><GitFork :size="16" /></span>
          <span class="repository-environment-row-copy">
            <strong>{{ t("repository.environment.worktree") }}</strong>
            <small v-if="context.currentWorktree">{{ worktreeSummary }}</small>
            <small v-else>{{ unavailableMessage }}</small>
          </span>
          <ChevronRight v-if="context.availability === 'available'" :size="15" />
        </button>

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
                <strong>{{ t("repository.environment.branch") }}</strong>
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
import { useI18n } from "vue-i18n";
import { useRepositoryContextQuery } from "../../../api/repository";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import type { RepositoryWorkspaceTabTarget } from "../useInstanceSessions";
import RepositoryBranchesPanel from "./RepositoryBranchesPanel.vue";
import RepositoryDeliveryDialog from "./RepositoryDeliveryDialog.vue";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";

const props = defineProps<{
  aiAgent?: "codex" | "claude";
  connectionStatus: string;
  instanceId: string;
  sessionId: string;
  sessionKind: RepositorySessionKind;
  triggerAppearance?: "toolbar" | "detail" | "menu";
}>();
const { t } = useI18n();

const emit = defineEmits<{
  openWorkspace: [target: RepositoryWorkspaceTabTarget];
}>();

const open = ref(false);
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
  if (!summary || changeCount.value === 0) return t("repository.environment.noChanges");
  const parts = [
    summary.conflicts ? t("repository.environmentExtra.conflict", { count: summary.conflicts }) : "",
    summary.staged ? t("repository.environmentExtra.staged", { count: summary.staged }) : "",
    summary.unstaged ? t("repository.environmentExtra.unstaged", { count: summary.unstaged }) : "",
    summary.untracked ? t("repository.environmentExtra.untracked", { count: summary.untracked }) : "",
  ].filter(Boolean);
  return parts.join(" · ");
});
const worktreeSummary = computed(() => {
  const worktree = context.value?.currentWorktree;
  if (!worktree) return unavailableMessage.value;
  const occupied = worktree.activeAiSessionIds.length + worktree.activeAppSessionIds.length;
  const flags = [t(worktree.isMain ? "repository.environmentExtra.main" : worktree.managed ? "repository.environmentExtra.managed" : "repository.environmentExtra.external")];
  if (worktree.dirty) flags.push(t("repository.environmentExtra.dirty"));
  if (occupied) flags.push(t("repository.environmentExtra.activeSessions", { count: occupied }));
  return flags.join(" · ");
});
const branchSummary = computed(() => {
  const head = context.value?.head;
  if (!head) return unavailableMessage.value;
  if (head.state === "branch") {
    const tracking = context.value?.upstream;
    if (tracking && (tracking.ahead || tracking.behind)) return t("repository.environment.branchSync", { branch: head.branch || t("repository.common.unknownBranch"), ahead: tracking.ahead, behind: tracking.behind });
    return head.branch || t("repository.common.unknownBranch");
  }
  if (head.state === "unborn") return t("repository.common.unbornBranch");
  return t("repository.common.detachedAt", { commit: head.oid?.slice(0, 8) || t("repository.environmentExtra.unknownCommit") });
});
const unavailableMessage = computed(() => t({
  "session-not-found": "repository.environment.unavailable.sessionNotFound",
  "session-inactive": "repository.environment.unavailable.sessionInactive",
  "cwd-missing": "repository.environmentExtra.availability.cwdMissing",
  "cwd-inaccessible": "repository.environmentExtra.availability.cwdInaccessible",
  "git-unavailable": "repository.environmentExtra.availability.gitUnavailable",
  "not-worktree": "repository.environmentExtra.availability.notWorktree",
  available: "repository.environmentExtra.availability.available",
}[context.value?.availability || "cwd-missing"]));
const primaryActionLabel = computed(() => t({
  "review-changes": "repository.environmentExtra.actions.review",
  "resolve-conflicts": "repository.environmentExtra.actions.resolve",
  "publish-branch": "repository.environmentExtra.actions.publish",
  push: "repository.environmentExtra.actions.push",
  pull: "repository.environmentExtra.actions.pull",
  diverged: "repository.environmentExtra.actions.diverged",
  "up-to-date": "repository.environmentExtra.actions.upToDate",
}[context.value?.primaryAction || "up-to-date"]));

function toggleBranches() {
  branchesOpen.value = !branchesOpen.value;
}

function openWorktrees() {
  emit("openWorkspace", {
    aiAgent: props.aiAgent,
    initialView: "files",
    page: "worktrees",
    sessionId: props.sessionId,
    sessionKind: props.sessionKind,
  });
  open.value = false;
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

.repository-environment-trigger-content {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
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

.repository-environment-trigger-menu {
  display: flex;
  width: 100%;
  height: auto;
  min-height: 32px;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
  padding: 6px 8px;
}

.repository-environment-trigger-menu span {
  font-size: inherit;
}

.repository-environment-trigger-menu .repository-environment-trigger-content {
  justify-content: flex-start;
  gap: 8px;
}

.repository-environment-trigger-menu:hover,
.repository-environment-trigger-menu:focus-visible,
.repository-environment-trigger-menu[data-state="open"] {
  border-color: transparent;
  background: var(--accent);
  color: var(--accent-foreground);
  outline: none;
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
