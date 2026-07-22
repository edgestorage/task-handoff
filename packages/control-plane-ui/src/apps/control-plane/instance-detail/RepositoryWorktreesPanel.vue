<template>
  <section class="repository-worktrees-panel" aria-label="Repository worktrees">
    <header>
      <span>
        <GitFork :size="16" />
        <strong>Worktrees</strong>
      </span>
      <span class="repository-worktree-header-actions">
        <button
          v-if="canStartAiSession"
          type="button"
          aria-label="New managed worktree AI session"
          title="New managed worktree AI session"
          :aria-expanded="createOpen"
          @click="toggleCreate"
        >
          <X v-if="createOpen" :size="14" />
          <Plus v-else :size="14" />
        </button>
        <button
          type="button"
          aria-label="Refresh worktrees"
          title="Refresh worktrees"
          :disabled="worktreesQuery.isFetching.value"
          @click="worktreesQuery.refetch()"
        >
          <LoaderCircle v-if="worktreesQuery.isFetching.value" class="repository-worktree-spin" :size="14" />
          <RefreshCw v-else :size="14" />
        </button>
      </span>
    </header>

    <form v-if="createOpen" class="repository-worktree-create" @submit.prevent="createManagedWorktreeSession">
      <div>
        <strong>New isolated AI session</strong>
        <small>A managed worktree is created first. The current session stays in this worktree.</small>
      </div>
      <label>
        <span>New branch</span>
        <input
          v-model="createBranchName"
          name="branchName"
          autocomplete="off"
          placeholder="feature/my-change"
          :disabled="creatingManagedSession"
        />
      </label>
      <label>
        <span>Start ref</span>
        <input
          v-model="createStartRef"
          name="startRef"
          autocomplete="off"
          placeholder="HEAD"
          :disabled="creatingManagedSession"
        />
      </label>
      <RepositoryErrorNotice v-if="createError" :error="createError" fallback="Failed to create the managed worktree AI session." />
      <small v-if="createRecovery" class="repository-worktree-recovery">{{ createRecovery }}</small>
      <button
        type="submit"
        class="repository-worktree-create-submit"
        :disabled="creatingManagedSession || !worktrees?.snapshotId || !createBranchName.trim() || !createStartRef.trim()"
      >
        <LoaderCircle v-if="creatingManagedSession" class="repository-worktree-spin" :size="14" />
        <GitFork v-else :size="14" />
        <span>{{ creatingManagedSession ? "Creating worktree and starting…" : "Create worktree and AI session" }}</span>
      </button>
    </form>

    <div v-if="worktreesQuery.isPending.value" class="repository-worktree-state" role="status">
      <LoaderCircle class="repository-worktree-spin" :size="17" />
      <span>Reading worktrees…</span>
    </div>
    <RepositoryErrorNotice v-else-if="worktreesQuery.error.value" :error="worktreesQuery.error.value" fallback="The instance did not return worktrees." />
    <div v-else-if="!worktrees?.items.length" class="repository-worktree-state" role="status">
      <GitFork :size="17" />
      <span>No worktrees were returned.</span>
    </div>
    <div v-else class="repository-worktree-list">
      <div v-if="removeSuccess" class="repository-worktree-mutation-success" role="status">
        <Check :size="14" />
        <span>{{ removeSuccess }}</span>
      </div>
      <RepositoryErrorNotice v-if="startError" :error="startError" fallback="Failed to start an AI session in this worktree." />
      <article
        v-for="worktree in orderedWorktrees"
        :key="worktree.id"
        class="repository-worktree-card"
        :data-current="worktree.isCurrent ? 'true' : undefined"
      >
        <div class="repository-worktree-card-head">
          <span class="repository-worktree-branch">
            <GitBranch v-if="worktree.head.state === 'branch'" :size="15" />
            <GitCommitHorizontal v-else :size="15" />
            <strong :title="worktreeLabel(worktree)">{{ worktreeLabel(worktree) }}</strong>
          </span>
          <span v-if="worktree.isCurrent" class="repository-worktree-current"><Check :size="12" /> Current</span>
        </div>
        <div class="repository-worktree-badges">
          <span>{{ worktree.isMain ? "Main" : worktree.managed ? "Managed" : "External" }}</span>
          <span v-if="worktree.dirty" class="warning">Dirty</span>
          <span v-if="worktree.locked" class="warning">Locked</span>
          <span v-if="worktree.prunable" class="warning">Prunable</span>
          <span v-if="activeSessionCount(worktree)">{{ activeSessionCount(worktree) }} active session{{ activeSessionCount(worktree) === 1 ? "" : "s" }}</span>
        </div>
        <small v-if="worktree.lockReason" class="repository-worktree-reason">{{ worktree.lockReason }}</small>
        <button
          v-if="canStartAiSession && worktree.canCreateAiSession"
          type="button"
          class="repository-worktree-start"
          :disabled="Boolean(startingWorktreeId)"
          @click="startAiSession(worktree)"
        >
          <LoaderCircle v-if="startingWorktreeId === worktree.id" class="repository-worktree-spin" :size="14" />
          <Plus v-else :size="14" />
          <span>{{ startingWorktreeId === worktree.id ? "Starting AI session…" : "New AI session here" }}</span>
        </button>
        <small v-else-if="canStartAiSession && !worktree.canCreateAiSession" class="repository-worktree-blocked">
          {{ blockerSummary(worktree) }}
        </small>
        <div v-if="!worktree.canCreateAiSession && worktree.createAiSessionBlockers.length" class="repository-worktree-blockers">
          <span v-for="blocker in worktree.createAiSessionBlockers" :key="blocker">{{ blockerLabel(blocker) }}</span>
        </div>
        <button
          v-if="canManageWorktrees && worktree.managed && !worktree.isCurrent"
          type="button"
          class="repository-worktree-remove"
          :disabled="!worktree.canRemove || removingWorktree"
          :title="worktree.canRemove ? 'Remove managed worktree' : removeBlockerSummary(worktree)"
          @click="confirmRemove(worktree)"
        >
          <Trash2 :size="13" />
          <span>Remove worktree</span>
        </button>
      </article>
    </div>

    <Dialog v-model:open="removeDialogOpen">
      <DialogContent class="repository-worktree-remove-dialog">
        <DialogHeader>
          <DialogTitle>Remove managed worktree?</DialogTitle>
          <DialogDescription>
            This deletes the managed worktree directory. The Git branch is retained, and this action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div v-if="removeTarget" class="repository-worktree-remove-summary">
          <span><GitBranch :size="15" /><strong>{{ worktreeLabel(removeTarget) }}</strong></span>
          <small>The current AI session and its working directory will not change.</small>
          <div v-if="removeTarget.removeBlockers.length" class="repository-worktree-blockers">
            <span v-for="blocker in removeTarget.removeBlockers" :key="blocker">{{ blockerLabel(blocker) }}</span>
          </div>
        </div>
        <RepositoryErrorNotice v-if="removeError" :error="removeError" fallback="Failed to remove the managed worktree." />
        <DialogFooter>
          <Button variant="outline" :disabled="removingWorktree" @click="removeDialogOpen = false">Cancel</Button>
          <Button variant="destructive" :disabled="removingWorktree || !removeTarget?.canRemove" @click="removeSelectedWorktree">
            <LoaderCircle v-if="removingWorktree" class="repository-worktree-spin" :size="14" />
            <Trash2 v-else :size="14" />
            <span>{{ removingWorktree ? "Removing…" : "Remove worktree" }}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

<script setup lang="ts">
import type { RepositoryAiSessionLaunchResult, RepositorySessionKind, RepositoryWorktree, RepositoryWorktreeBlocker } from "@task-handoff/protocol/repository";
import { Check, GitBranch, GitCommitHorizontal, GitFork, LoaderCircle, Plus, RefreshCw, Trash2, X } from "@lucide/vue";
import { computed, ref } from "vue";
import { ApiError } from "../../../api/client";
import { createRepositoryWorktreeAiSession, removeRepositoryWorktree, startRepositoryAiSession, useRepositoryWorktreesQuery } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";

const props = defineProps<{
  aiAgent?: "codex" | "claude";
  instanceId: string;
  open: boolean;
  sessionId: string;
  sessionKind: RepositorySessionKind;
}>();

const emit = defineEmits<{
  aiSessionStarted: [result: RepositoryAiSessionLaunchResult];
}>();

const target = computed(() => ({
  instanceId: props.instanceId,
  sessionKind: props.sessionKind,
  sessionId: props.sessionId,
}));
const worktreesQuery = useRepositoryWorktreesQuery(target, computed(() => props.open));
const worktrees = computed(() => worktreesQuery.data.value);
const orderedWorktrees = computed(() => [...(worktrees.value?.items || [])].sort((left, right) => {
  if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
  if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
  return worktreeLabel(left).localeCompare(worktreeLabel(right));
}));
const canStartAiSession = computed(() => props.sessionKind === "ai-session" && Boolean(props.aiAgent));
const canManageWorktrees = computed(() => props.sessionKind === "ai-session");
const startingWorktreeId = ref("");
const startError = ref<unknown>();
const createOpen = ref(false);
const createBranchName = ref("");
const createStartRef = ref("HEAD");
const creatingManagedSession = ref(false);
const createError = ref<unknown>();
const createRecovery = ref("");
const removeDialogOpen = ref(false);
const removeTarget = ref<RepositoryWorktree>();
const removingWorktree = ref(false);
const removeError = ref<unknown>();
const removeSuccess = ref("");

function worktreeLabel(worktree: RepositoryWorktree) {
  if (worktree.head.state === "branch") return worktree.head.branch || "Unknown branch";
  if (worktree.head.state === "unborn") return "Unborn branch";
  return `Detached at ${worktree.head.oid?.slice(0, 8) || "unknown"}`;
}

function activeSessionCount(worktree: RepositoryWorktree) {
  return worktree.activeAiSessionIds.length + worktree.activeAppSessionIds.length;
}

function blockerSummary(worktree: RepositoryWorktree) {
  if (worktree.locked) return "Locked worktree";
  if (worktree.prunable) return "Prunable worktree record";
  if (worktree.createAiSessionBlockers.includes("outside-workspace-roots")) return "Outside authorized workspace roots";
  if (worktree.createAiSessionBlockers.includes("path-inaccessible")) return "Worktree directory is inaccessible";
  return "Unavailable for a new AI session";
}

function removeBlockerSummary(worktree: RepositoryWorktree) {
  return worktree.removeBlockers.map(blockerLabel).join(", ") || "Worktree cannot be removed";
}

function blockerLabel(blocker: RepositoryWorktreeBlocker) {
  return ({
    "main-worktree": "Main worktree",
    "external-worktree": "External worktree",
    "outside-workspace-roots": "Outside authorized roots",
    dirty: "Uncommitted changes",
    locked: "Locked",
    prunable: "Prunable record",
    "session-occupied": "Active session",
    "path-inaccessible": "Directory inaccessible",
  })[blocker];
}

function confirmRemove(worktree: RepositoryWorktree) {
  if (!canManageWorktrees.value || !worktree.canRemove) return;
  removeTarget.value = worktree;
  removeError.value = undefined;
  removeDialogOpen.value = true;
}

async function removeSelectedWorktree() {
  if (!removeTarget.value?.canRemove || !worktrees.value?.snapshotId || removingWorktree.value) return;
  removingWorktree.value = true;
  removeError.value = undefined;
  removeSuccess.value = "";
  try {
    const result = await removeRepositoryWorktree(target.value, {
      worktreeId: removeTarget.value.id,
      expectedSnapshotId: worktrees.value.snapshotId,
      confirm: true,
    });
    removeSuccess.value = result.branchRetained
      ? "Managed worktree removed. Its branch was retained."
      : "Managed worktree removed.";
    removeDialogOpen.value = false;
    removeTarget.value = undefined;
    await worktreesQuery.refetch();
  } catch (error) {
    removeError.value = error;
    await worktreesQuery.refetch();
  } finally {
    removingWorktree.value = false;
  }
}

function toggleCreate() {
  createOpen.value = !createOpen.value;
  createError.value = undefined;
  createRecovery.value = "";
  if (createOpen.value && createStartRef.value === "HEAD") {
    const current = worktrees.value?.items.find((item) => item.isCurrent);
    createStartRef.value = current?.head.branch || current?.head.oid || "HEAD";
  }
}

async function createManagedWorktreeSession() {
  if (!props.aiAgent || !worktrees.value?.snapshotId || creatingManagedSession.value) return;
  const branchName = createBranchName.value.trim();
  const startRef = createStartRef.value.trim();
  if (!branchName || !startRef) return;
  createError.value = undefined;
  createRecovery.value = "";
  creatingManagedSession.value = true;
  try {
    const result = await createRepositoryWorktreeAiSession(target.value, {
      agent: props.aiAgent,
      worktree: { mode: "new-branch", branchName, startRef, expectedSnapshotId: worktrees.value.snapshotId },
    });
    emit("aiSessionStarted", result);
    createBranchName.value = "";
    createOpen.value = false;
    await worktreesQuery.refetch();
  } catch (error) {
    createError.value = error;
    if (error instanceof ApiError) {
      if (error.details?.worktreeRemoved === true) {
        createRecovery.value = "The new worktree directory was removed; its branch was retained.";
      } else if (error.details?.recoverable === true) {
        createRecovery.value = "The new worktree was retained so its state can be recovered safely.";
      }
    }
    await worktreesQuery.refetch();
  } finally {
    creatingManagedSession.value = false;
  }
}

async function startAiSession(worktree: RepositoryWorktree) {
  if (!props.aiAgent || !worktrees.value || startingWorktreeId.value) return;
  startError.value = undefined;
  startingWorktreeId.value = worktree.id;
  try {
    const result = await startRepositoryAiSession(target.value, {
      agent: props.aiAgent,
      workspaceSelection: {
        type: "worktree",
        repositoryContextId: worktrees.value.repositoryContextId,
        worktreeId: worktree.id,
      },
    });
    emit("aiSessionStarted", result);
    await worktreesQuery.refetch();
  } catch (error) {
    startError.value = error;
  } finally {
    startingWorktreeId.value = "";
  }
}
</script>

<style scoped>
.repository-worktrees-panel {
  display: grid;
  max-height: min(620px, calc(100vh - 32px));
  overflow: hidden;
}

.repository-worktrees-panel > header,
.repository-worktrees-panel > header > span,
.repository-worktree-card-head,
.repository-worktree-branch,
.repository-worktree-current,
.repository-worktree-badges,
.repository-worktree-start,
.repository-worktree-state {
  display: flex;
  align-items: center;
}

.repository-worktrees-panel > header {
  justify-content: space-between;
  padding: 3px 3px 10px 7px;
}

.repository-worktrees-panel > header > span {
  gap: 8px;
}

.repository-worktrees-panel > header strong {
  font-size: 13px;
}

.repository-worktree-header-actions {
  display: flex;
  align-items: center;
  gap: 3px;
}

.repository-worktrees-panel > header button {
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

.repository-worktrees-panel > header button:hover:not(:disabled),
.repository-worktrees-panel > header button:focus-visible {
  background: var(--surface-subtle);
  color: var(--text);
}

.repository-worktree-create {
  display: grid;
  gap: 9px;
  margin-bottom: 8px;
  border: 1px solid color-mix(in srgb, var(--focus-ring) 45%, var(--line-subtle));
  border-radius: 9px;
  background: var(--workspace-bg, var(--background));
  padding: 10px;
}

.repository-worktree-create > div:first-child,
.repository-worktree-create label,
.repository-worktree-create-error > span {
  display: grid;
  gap: 3px;
}

.repository-worktree-create strong,
.repository-worktree-create label > span {
  color: var(--text-strong);
  font-size: 11px;
  font-weight: 700;
}

.repository-worktree-create small {
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.4;
}

.repository-worktree-recovery {
  color: var(--text-muted);
  font-size: 9px;
  line-height: 1.4;
}

.repository-worktree-create input {
  width: 100%;
  height: 31px;
  border: 1px solid var(--line-subtle);
  border-radius: 7px;
  outline: none;
  background: var(--surface-subtle);
  color: var(--text);
  padding: 0 9px;
  font-size: 11px;
}

.repository-worktree-create input:focus-visible {
  border-color: var(--focus-ring);
}

.repository-worktree-create-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--status-warning);
}

.repository-worktree-create-error strong,
.repository-worktree-create-error small {
  color: inherit;
}

.repository-worktree-create-submit {
  display: flex;
  min-height: 33px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid var(--focus-ring);
  border-radius: 7px;
  background: color-mix(in srgb, var(--focus-ring) 16%, var(--surface-subtle));
  color: var(--text-strong);
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}

.repository-worktree-create-submit:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.repository-worktree-list {
  display: grid;
  min-width: 0;
  gap: 2px;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 1px 2px 2px;
}

.repository-worktree-mutation-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  border: 1px solid color-mix(in srgb, var(--status-warning) 45%, var(--line-subtle));
  border-radius: 7px;
  color: var(--status-warning);
  padding: 8px;
  font-size: 10px;
  line-height: 1.4;
}

.repository-worktree-mutation-success {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid color-mix(in srgb, var(--status-success, #2dd4bf) 45%, var(--line-subtle));
  border-radius: 7px;
  color: var(--status-success, #2dd4bf);
  padding: 8px;
  font-size: 10px;
}

.repository-worktree-card {
  display: grid;
  min-width: 0;
  max-width: 100%;
  gap: 5px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 7px 8px;
  transition: background-color 120ms ease;
}

.repository-worktree-card[data-current="true"] {
  background: color-mix(in srgb, var(--brand-accent) 9%, transparent);
}

.repository-worktree-card:hover {
  background: color-mix(in srgb, var(--surface-subtle) 58%, transparent);
}

.repository-worktree-card[data-current="true"] .repository-worktree-branch strong,
.repository-worktree-card[data-current="true"] .repository-worktree-current {
  color: var(--brand-accent-muted, var(--brand-accent));
}

.repository-worktree-card-head {
  min-width: 0;
  justify-content: space-between;
  gap: 8px;
}

.repository-worktree-branch {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  gap: 7px;
}

.repository-worktree-branch svg {
  flex: 0 0 auto;
}

.repository-worktree-branch strong {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-worktree-current {
  flex: 0 0 auto;
  gap: 3px;
  color: var(--brand-accent-muted, var(--brand-accent));
  font-size: 10px;
  font-weight: 700;
}

.repository-worktree-badges {
  flex-wrap: wrap;
  gap: 5px;
}

.repository-worktree-badges span {
  border-radius: 999px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  padding: 1px 6px;
  font-size: 10px;
}

.repository-worktree-badges span.warning,
.repository-worktree-blocked,
.repository-worktree-state.error {
  color: var(--status-warning);
}

.repository-worktree-reason,
.repository-worktree-blocked {
  font-size: 10px;
  line-height: 1.35;
}

.repository-worktree-blockers {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.repository-worktree-blockers span {
  border: 1px solid color-mix(in srgb, var(--status-warning) 35%, var(--line-subtle));
  border-radius: 999px;
  color: var(--status-warning);
  padding: 2px 6px;
  font-size: 9px;
}

.repository-worktree-start {
  justify-content: center;
  gap: 7px;
  min-height: 31px;
  border: 1px solid var(--line-subtle);
  border-radius: 7px;
  background: var(--surface-subtle);
  color: var(--text-strong);
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}

.repository-worktree-start:hover:not(:disabled),
.repository-worktree-start:focus-visible {
  border-color: var(--focus-ring);
}

.repository-worktree-start:disabled {
  cursor: wait;
  opacity: 0.7;
}

.repository-worktree-remove {
  display: flex;
  min-height: 29px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--line-subtle);
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 10px;
}

.repository-worktree-remove:hover:not(:disabled),
.repository-worktree-remove:focus-visible {
  border-color: var(--status-danger);
  color: var(--status-danger);
}

.repository-worktree-remove:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

:global([role="dialog"].repository-worktree-remove-dialog) {
  width: min(460px, calc(100vw - 24px));
  border-color: var(--line-subtle);
  border-radius: 12px;
  background: var(--surface-raised, var(--background));
  color: var(--text);
}

.repository-worktree-remove-summary {
  display: grid;
  gap: 9px;
  border: 1px solid var(--line-subtle);
  border-radius: 8px;
  background: var(--workspace-bg, var(--background));
  padding: 10px;
}

.repository-worktree-remove-summary > span {
  display: flex;
  align-items: center;
  gap: 7px;
}

.repository-worktree-remove-summary small {
  color: var(--text-muted);
  font-size: 10px;
}

.repository-worktree-state {
  min-height: 74px;
  justify-content: center;
  gap: 8px;
  border-top: 1px solid var(--line-subtle);
  color: var(--text-muted);
  font-size: 11px;
}

.repository-worktree-spin {
  animation: repository-worktree-spin 0.9s linear infinite;
}

@keyframes repository-worktree-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .repository-worktree-spin { animation: none; }
}
</style>
