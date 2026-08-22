<template>
  <section class="repository-worktrees-panel" :data-appearance="appearance" :aria-label="t('repository.worktreesPanel.region')">
    <header>
      <span class="repository-worktree-title">
        <GitFork :size="16" />
        <span>
          <strong>{{ t("repository.worktreesPanel.title") }}</strong>
          <small v-if="appearance === 'page'">{{ t("repository.worktreesPanel.description") }}</small>
        </span>
      </span>
      <span class="repository-worktree-header-actions">
        <button
          v-if="canStartAiSession"
          type="button"
          :aria-label="t('repository.worktreesPanel.createSession')"
          :title="t('repository.worktreesPanel.createSession')"
          :aria-expanded="createOpen"
          @click="toggleCreate"
        >
          <X v-if="createOpen" :size="14" />
          <Plus v-else :size="14" />
        </button>
        <button
          type="button"
          :aria-label="t('repository.worktreesPanel.refresh')"
          :title="t('repository.worktreesPanel.refresh')"
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
        <strong>{{ t("repository.worktreesPanel.newTitle") }}</strong>
        <small>{{ t("repository.worktreesPanel.newHint") }}</small>
      </div>
      <label>
        <span>{{ t("repository.worktreesPanel.newBranch") }}</span>
        <!-- i18n-audit-allow-next-line code-token: example Git branch name -->
        <input v-model="createBranchName" name="branchName" autocomplete="off" placeholder="feature/my-change" :disabled="creatingManagedSession" />
      </label>
      <label>
        <span>{{ t("repository.worktreesPanel.startRef") }}</span>
        <!-- i18n-audit-allow-next-line code-token: Git revision token -->
        <input v-model="createStartRef" name="startRef" autocomplete="off" placeholder="HEAD" :disabled="creatingManagedSession" />
      </label>
      <label>
        <span>{{ t("repository.worktreesPanel.task") }}</span>
        <textarea v-model="createMessage" name="message" :placeholder="t('repository.worktreesPanel.taskPlaceholder')" :disabled="creatingManagedSession" />
      </label>
      <RepositoryErrorNotice v-if="createError" :error="createError" :fallback="t('repository.worktreesPanel.createError')" />
      <small v-if="createRecoveryKey" class="repository-worktree-recovery">{{ t(createRecoveryKey) }}</small>
      <button
        type="submit"
        class="repository-worktree-create-submit"
        :disabled="creatingManagedSession || !worktrees?.snapshotId || !createBranchName.trim() || !createStartRef.trim() || !createMessage.trim()"
      >
        <LoaderCircle v-if="creatingManagedSession" class="repository-worktree-spin" :size="14" />
        <GitFork v-else :size="14" />
        <span>{{ t(creatingManagedSession ? "repository.worktreesPanel.creating" : "repository.worktreesPanel.create") }}</span>
      </button>
    </form>

    <label v-if="worktrees?.items.length" class="repository-worktree-search">
      <Search :size="15" />
      <input v-model="searchQuery" type="search" :placeholder="t('repository.worktreesPanel.search')" />
      <span>{{ t("repository.worktreesPanel.count", { count: filteredWorktrees.length }) }}</span>
    </label>

    <div v-if="worktreesQuery.isPending.value" class="repository-worktree-state" role="status">
      <LoaderCircle class="repository-worktree-spin" :size="17" />
      <span>{{ t("repository.worktreesPanel.reading") }}</span>
    </div>
    <RepositoryErrorNotice v-else-if="worktreesQuery.error.value" :error="worktreesQuery.error.value" :fallback="t('repository.errors.worktreesLoad')" />
    <div v-else-if="!worktrees?.items.length" class="repository-worktree-state" role="status">
      <GitFork :size="17" />
      <span>{{ t("repository.worktreesPanel.empty") }}</span>
    </div>
    <ScrollArea v-else class="repository-worktree-scroll" :horizontal="false">
      <div class="repository-worktree-list">
      <div v-if="removeSuccessKey" class="repository-worktree-mutation-success" role="status">
        <Check :size="14" />
        <span>{{ t(removeSuccessKey) }}</span>
      </div>
      <RepositoryErrorNotice v-if="startError" :error="startError" :fallback="t('repository.worktreesPanel.startError')" />
      <article
        v-for="worktree in filteredWorktrees"
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
          <span v-if="worktree.isCurrent" class="repository-worktree-current"><Check :size="12" /> {{ t("repository.worktreesPanel.current") }}</span>
        </div>
        <div class="repository-worktree-badges">
          <span>{{ t(worktree.isMain ? "repository.worktreesPanel.main" : worktree.managed ? "repository.worktreesPanel.managed" : "repository.worktreesPanel.external") }}</span>
          <span v-if="worktree.dirty" class="warning">{{ t("repository.worktreesPanel.dirty") }}</span>
          <span v-if="worktree.locked" class="warning">{{ t("repository.worktreesPanel.locked") }}</span>
          <span v-if="worktree.prunable" class="warning">{{ t("repository.worktreesPanel.prunable") }}</span>
          <span v-if="activeSessionCount(worktree)">{{ t("repository.environmentExtra.activeSessions", { count: activeSessionCount(worktree) }) }}</span>
        </div>
        <small v-if="worktree.lockReason" class="repository-worktree-reason">{{ worktree.lockReason }}</small>
        <button
          v-if="canStartAiSession && worktree.canCreateAiSession && startingComposerWorktreeId !== worktree.id"
          type="button"
          class="repository-worktree-start"
          :disabled="Boolean(startingWorktreeId)"
          @click="openStartComposer(worktree)"
        >
          <LoaderCircle v-if="startingWorktreeId === worktree.id" class="repository-worktree-spin" :size="14" />
          <Plus v-else :size="14" />
          <span>{{ t(startingWorktreeId === worktree.id ? "repository.worktreesPanel.starting" : "repository.worktreesPanel.newHere") }}</span>
        </button>
        <form
          v-else-if="canStartAiSession && worktree.canCreateAiSession"
          class="repository-worktree-start-composer"
          @submit.prevent="startAiSession(worktree)"
        >
          <textarea v-model="startMessage" :placeholder="t('repository.worktreesPanel.taskPlaceholder')" :disabled="Boolean(startingWorktreeId)" autofocus />
          <span>
            <Button type="button" variant="outline" size="sm" :disabled="Boolean(startingWorktreeId)" @click="closeStartComposer">{{ t("repository.common.cancel") }}</Button>
            <Button type="submit" size="sm" :disabled="Boolean(startingWorktreeId) || !startMessage.trim()">
              <LoaderCircle v-if="startingWorktreeId === worktree.id" class="repository-worktree-spin" :size="14" />
              <Plus v-else :size="14" />
              {{ t(startingWorktreeId === worktree.id ? "repository.worktreesPanel.starting" : "repository.worktreesPanel.start") }}
            </Button>
          </span>
        </form>
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
          :title="worktree.canRemove ? t('repository.worktreesPanel.removeManaged') : removeBlockerSummary(worktree)"
          @click="confirmRemove(worktree)"
        >
          <Trash2 :size="13" />
          <span>{{ t("repository.worktreesPanel.remove") }}</span>
        </button>
      </article>
      <div v-if="!filteredWorktrees.length" class="repository-worktree-state">
        <Search :size="17" />
        <span>{{ t("repository.worktreesPanel.noMatch") }}</span>
      </div>
      </div>
    </ScrollArea>

    <Dialog v-model:open="removeDialogOpen">
      <DialogContent class="repository-worktree-remove-dialog">
        <DialogHeader>
          <DialogTitle>{{ t("repository.worktreesPanel.removeTitle") }}</DialogTitle>
          <DialogDescription>{{ t("repository.worktreeRemoveDescription") }}</DialogDescription>
        </DialogHeader>
        <div v-if="removeTarget" class="repository-worktree-remove-summary">
          <span><GitBranch :size="15" /><strong>{{ worktreeLabel(removeTarget) }}</strong></span>
          <small>{{ t("repository.worktreesPanel.removeHint") }}</small>
          <div v-if="removeTarget.removeBlockers.length" class="repository-worktree-blockers">
            <span v-for="blocker in removeTarget.removeBlockers" :key="blocker">{{ blockerLabel(blocker) }}</span>
          </div>
        </div>
        <RepositoryErrorNotice v-if="removeError" :error="removeError" :fallback="t('repository.worktreesPanel.removeError')" />
        <DialogFooter>
          <Button variant="outline" :disabled="removingWorktree" @click="removeDialogOpen = false">{{ t("repository.common.cancel") }}</Button>
          <Button variant="destructive" :disabled="removingWorktree || !removeTarget?.canRemove" @click="removeSelectedWorktree">
            <LoaderCircle v-if="removingWorktree" class="repository-worktree-spin" :size="14" />
            <Trash2 v-else :size="14" />
            <span>{{ t(removingWorktree ? "repository.worktreesPanel.removing" : "repository.worktreesPanel.remove") }}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

<script setup lang="ts">
import type { RepositoryAiSessionLaunchResult, RepositorySessionKind, RepositoryWorktree, RepositoryWorktreeBlocker } from "@task-handoff/protocol/repository";
import { Check, GitBranch, GitCommitHorizontal, GitFork, LoaderCircle, Plus, RefreshCw, Search, Trash2, X } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError } from "../../../api/client";
import { createRepositoryWorktreeAiSession, removeRepositoryWorktree, startRepositoryAiSession, useRepositoryWorktreesQuery } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import { createBrowserUuid } from "../../../lib/random-id";

const props = withDefaults(defineProps<{
  aiAgent?: "codex" | "claude";
  appearance?: "popover" | "page";
  instanceId: string;
  open: boolean;
  sessionId: string;
  sessionKind: RepositorySessionKind;
}>(), { appearance: "popover" });
const { t } = useI18n();

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
const searchQuery = ref("");
const orderedWorktrees = computed(() => [...(worktrees.value?.items || [])].sort((left, right) => {
  if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
  if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
  return worktreeLabel(left).localeCompare(worktreeLabel(right));
}));
const filteredWorktrees = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  if (!query) return orderedWorktrees.value;
  return orderedWorktrees.value.filter((worktree) => [
    worktreeLabel(worktree),
    worktree.head.oid,
    worktree.isMain ? t("repository.worktreesPanel.main") : "",
    worktree.managed ? t("repository.worktreesPanel.managed") : t("repository.worktreesPanel.external"),
  ].some((value) => value?.toLocaleLowerCase().includes(query)));
});
const canStartAiSession = computed(() => props.sessionKind === "ai-session" && Boolean(props.aiAgent));
const canManageWorktrees = computed(() => props.sessionKind === "ai-session");
const startingWorktreeId = ref("");
const startError = ref<unknown>();
const createOpen = ref(false);
const createBranchName = ref("");
const createStartRef = ref("HEAD");
const createMessage = ref("");
const creatingManagedSession = ref(false);
const createError = ref<unknown>();
const createRecoveryKey = ref("");
const removeDialogOpen = ref(false);
const removeTarget = ref<RepositoryWorktree>();
const removingWorktree = ref(false);
const removeError = ref<unknown>();
const removeSuccessKey = ref("");
const startingComposerWorktreeId = ref("");
const startMessage = ref("");

function worktreeLabel(worktree: RepositoryWorktree) {
  if (worktree.head.state === "branch") return worktree.head.branch || t("repository.common.unknownBranch");
  if (worktree.head.state === "unborn") return t("repository.common.unbornBranch");
  return t("repository.common.detachedAt", { commit: worktree.head.oid?.slice(0, 8) || t("repository.environmentExtra.unknownCommit") });
}

function activeSessionCount(worktree: RepositoryWorktree) {
  return worktree.activeAiSessionIds.length + worktree.activeAppSessionIds.length;
}

function blockerSummary(worktree: RepositoryWorktree) {
  if (worktree.locked) return t("repository.worktreesPanel.blockers.locked");
  if (worktree.prunable) return t("repository.worktreesPanel.blockers.prunable");
  if (worktree.createAiSessionBlockers.includes("outside-workspace-roots")) return t("repository.worktreesPanel.blockers.outside");
  if (worktree.createAiSessionBlockers.includes("path-inaccessible")) return t("repository.worktreesPanel.blockers.inaccessible");
  return t("repository.worktreesPanel.blockers.unavailable");
}

function removeBlockerSummary(worktree: RepositoryWorktree) {
  return worktree.removeBlockers.map(blockerLabel).join(", ") || t("repository.worktreesPanel.blockers.cannotRemove");
}

function blockerLabel(blocker: RepositoryWorktreeBlocker) {
  return t({
    "main-worktree": "repository.worktreesPanel.blockers.main",
    "external-worktree": "repository.worktreesPanel.blockers.external",
    "outside-workspace-roots": "repository.worktreesPanel.blockers.outsideRoots",
    dirty: "repository.worktreesPanel.blockers.uncommitted",
    locked: "repository.worktreesPanel.locked",
    prunable: "repository.worktreesPanel.blockers.prunable",
    "session-occupied": "repository.worktreesPanel.blockers.activeSession",
    "path-inaccessible": "repository.worktreesPanel.blockers.directoryInaccessible",
  }[blocker]);
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
  removeSuccessKey.value = "";
  try {
    const result = await removeRepositoryWorktree(target.value, {
      worktreeId: removeTarget.value.id,
      expectedSnapshotId: worktrees.value.snapshotId,
      confirm: true,
    });
    removeSuccessKey.value = result.branchRetained
      ? "repository.worktreesPanel.removedRetained"
      : "repository.worktreesPanel.removed";
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
  createRecoveryKey.value = "";
  if (createOpen.value && createStartRef.value === "HEAD") {
    const current = worktrees.value?.items.find((item) => item.isCurrent);
    createStartRef.value = current?.head.branch || current?.head.oid || "HEAD";
  }
}

async function createManagedWorktreeSession() {
  if (!props.aiAgent || !worktrees.value?.snapshotId || creatingManagedSession.value) return;
  const branchName = createBranchName.value.trim();
  const startRef = createStartRef.value.trim();
  const message = createMessage.value.trim();
  if (!branchName || !startRef || !message) return;
  createError.value = undefined;
  createRecoveryKey.value = "";
  creatingManagedSession.value = true;
  try {
    const result = await createRepositoryWorktreeAiSession(target.value, {
      agent: props.aiAgent,
      worktree: { mode: "new-branch", branchName, startRef, expectedSnapshotId: worktrees.value.snapshotId },
      message,
      clientRequestId: createBrowserUuid(),
    });
    emit("aiSessionStarted", result);
    createBranchName.value = "";
    createMessage.value = "";
    createOpen.value = false;
    await worktreesQuery.refetch();
  } catch (error) {
    createError.value = error;
    if (error instanceof ApiError) {
      if (error.details?.worktreeRemoved === true) {
        createRecoveryKey.value = "repository.worktreeDirectoryRemoved";
      } else if (error.details?.recoverable === true) {
        createRecoveryKey.value = "repository.worktreesPanel.recovery";
      }
    }
    await worktreesQuery.refetch();
  } finally {
    creatingManagedSession.value = false;
  }
}

function openStartComposer(worktree: RepositoryWorktree) {
  startingComposerWorktreeId.value = worktree.id;
  startMessage.value = "";
  startError.value = undefined;
}

function closeStartComposer() {
  if (startingWorktreeId.value) return;
  startingComposerWorktreeId.value = "";
  startMessage.value = "";
}

async function startAiSession(worktree: RepositoryWorktree) {
  const message = startMessage.value.trim();
  if (!props.aiAgent || !worktrees.value || !message || startingWorktreeId.value) return;
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
      message,
      clientRequestId: createBrowserUuid(),
    });
    emit("aiSessionStarted", result);
    startingComposerWorktreeId.value = "";
    startMessage.value = "";
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

.repository-worktrees-panel[data-appearance="page"] {
  display: flex;
  flex-direction: column;
  width: min(1120px, 100%);
  height: 100%;
  max-height: none;
  min-height: 0;
  margin: 0 auto;
  padding: 24px;
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

.repository-worktree-title > span {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.repository-worktree-title small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
}

.repository-worktrees-panel[data-appearance="page"] > header {
  padding: 2px 2px 18px;
}

.repository-worktrees-panel[data-appearance="page"] > header strong {
  font-size: 16px;
}

.repository-worktrees-panel[data-appearance="page"] > header .repository-worktree-title > svg {
  width: 19px;
  height: 19px;
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
  font-size: 12px;
  font-weight: 700;
}

.repository-worktree-create small {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.repository-worktree-recovery {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.repository-worktree-create input,
.repository-worktree-create textarea,
.repository-worktree-start-composer textarea {
  width: 100%;
  border: 1px solid var(--line-subtle);
  border-radius: 7px;
  outline: none;
  background: var(--surface-subtle);
  color: var(--text);
  padding: 7px 9px;
  font-size: 12px;
}

.repository-worktree-create input {
  height: 31px;
}

.repository-worktree-create textarea,
.repository-worktree-start-composer textarea {
  min-height: 68px;
  resize: vertical;
}

.repository-worktree-create input:focus-visible,
.repository-worktree-create textarea:focus-visible,
.repository-worktree-start-composer textarea:focus-visible {
  border-color: var(--focus-ring);
}

.repository-worktree-start-composer {
  display: grid;
  gap: 7px;
}

.repository-worktree-start-composer > span {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
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
  font-size: 12px;
  font-weight: 700;
}

.repository-worktree-create-submit:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.repository-worktree-search {
  display: flex;
  min-width: 0;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  margin: 0 2px 9px;
  border: 1px solid var(--line-subtle);
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  padding: 0 10px;
}

.repository-worktree-search input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 12px;
}

.repository-worktree-search span {
  flex: 0 0 auto;
  font-size: 12px;
}

.repository-worktree-search:focus-within {
  border-color: var(--focus-ring);
}

.repository-worktree-scroll {
  min-height: 0;
  max-height: 500px;
}

.repository-worktrees-panel[data-appearance="page"] .repository-worktree-scroll {
  flex: 1 1 auto;
  height: auto;
  max-height: none;
}

.repository-worktrees-panel[data-appearance="page"] > .repository-worktree-state {
  flex: 1 1 auto;
}

.repository-worktree-list {
  display: grid;
  min-width: 0;
  gap: 2px;
  padding: 1px 10px 2px 2px;
}

.repository-worktrees-panel[data-appearance="page"] .repository-worktree-list {
  grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr));
  align-items: start;
  gap: 10px;
}

.repository-worktrees-panel[data-appearance="page"] .repository-worktree-list > .repository-worktree-mutation-success,
.repository-worktrees-panel[data-appearance="page"] .repository-worktree-list > :deep(.repository-error-notice),
.repository-worktrees-panel[data-appearance="page"] .repository-worktree-list > .repository-worktree-state {
  grid-column: 1 / -1;
}

.repository-worktree-mutation-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  border: 1px solid color-mix(in srgb, var(--status-warning) 45%, var(--line-subtle));
  border-radius: 7px;
  color: var(--status-warning);
  padding: 8px;
  font-size: 12px;
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
  font-size: 12px;
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

.repository-worktrees-panel[data-appearance="page"] .repository-worktree-card {
  border: 1px solid var(--line-subtle);
  border-radius: 10px;
  background: var(--surface-raised, var(--background));
  padding: 12px;
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
  font-size: 12px;
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
  font-size: 12px;
}

.repository-worktree-badges span.warning,
.repository-worktree-blocked,
.repository-worktree-state.error {
  color: var(--status-warning);
}

.repository-worktree-reason,
.repository-worktree-blocked {
  font-size: 12px;
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
  font-size: 12px;
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
  font-size: 12px;
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
  font-size: 12px;
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
  font-size: 12px;
}

.repository-worktree-state {
  min-height: 74px;
  justify-content: center;
  gap: 8px;
  border-top: 1px solid var(--line-subtle);
  color: var(--text-muted);
  font-size: 12px;
}

@media (max-width: 720px) {
  .repository-worktrees-panel[data-appearance="page"] {
    padding: 14px;
  }

  .repository-worktrees-panel[data-appearance="page"] .repository-worktree-list {
    grid-template-columns: 1fr;
  }
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
