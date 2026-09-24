<template>
  <section class="repository-worktrees-panel" :aria-label="t('repository.worktreesPanel.region')">
    <header class="repository-worktrees-head">
      <span class="repository-worktrees-title">
        <GitFork :size="17" />
        <span>
          <strong>{{ t("repository.worktreesPanel.title") }}</strong>
          <small :title="t('repository.worktreesPanel.description')">{{ t("repository.worktreesPanel.description") }}</small>
        </span>
      </span>
      <span class="repository-worktrees-head-actions">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="repository-worktrees-refresh"
          :aria-label="t('repository.worktreesPanel.refresh')"
          :title="t('repository.worktreesPanel.refresh')"
          :disabled="worktreesQuery.isFetching.value"
          @click="worktreesQuery.refetch()"
        >
          <LoaderCircle v-if="worktreesQuery.isFetching.value" class="repository-worktree-spin" :size="14" />
          <RefreshCw v-else :size="14" />
        </Button>
        <Button v-if="canManageWorktrees" type="button" size="sm" @click="openCreateDialog">
          <Plus :size="14" />
          <span>{{ t("repository.worktreesPanel.createSession") }}</span>
        </Button>
      </span>
    </header>

    <div class="repository-worktrees-toolbar">
      <div class="repository-worktrees-search">
        <Search :size="15" aria-hidden="true" />
        <ControlPlaneInput v-model="searchQuery" :aria-label="t('repository.worktreesPanel.search')" :placeholder="t('repository.worktreesPanel.search')" />
      </div>
    </div>

    <section class="repository-worktree-directory" :aria-label="t('repository.worktreesPanel.count', { count: filteredWorktrees.length })">
      <header class="repository-worktree-directory-head">
        <strong>{{ t("repository.worktreesPanel.count", { count: filteredWorktrees.length }) }}</strong>
        <span v-if="searchActive">{{ t("repository.worktreesPanel.filteredFrom", { count: worktrees?.items.length || 0 }) }}</span>
      </header>

      <div v-if="worktreesQuery.isPending.value" class="repository-worktree-state" role="status">
        <LoaderCircle class="repository-worktree-spin" :size="17" />
        <span>{{ t("repository.worktreesPanel.reading") }}</span>
      </div>
      <RepositoryErrorNotice
        v-else-if="worktreesQuery.error.value"
        class="repository-worktree-directory-error"
        :error="worktreesQuery.error.value"
        :fallback="t('repository.errors.worktreesLoad')"
      />
      <div v-else-if="!worktrees?.items.length" class="repository-worktree-state" role="status">
        <GitFork :size="17" />
        <span>{{ t("repository.worktreesPanel.empty") }}</span>
      </div>
      <ScrollArea v-else class="repository-worktree-scroll" :horizontal="false">
        <div class="repository-worktree-list">
          <div v-if="removeSuccessKey" class="repository-worktree-notice" role="status">
            <Check :size="14" />
            <span>{{ t(removeSuccessKey) }}</span>
          </div>
          <RepositoryErrorNotice v-if="startError" :error="startError" :fallback="t('repository.worktreesPanel.startError')" />
          <article
            v-for="worktree in filteredWorktrees"
            :key="worktree.id"
            class="repository-worktree-row"
            :data-current="worktree.isCurrent ? 'true' : undefined"
          >
            <div class="repository-worktree-identity">
              <span class="repository-worktree-icon" aria-hidden="true">
                <GitBranch v-if="worktree.head.state === 'branch'" :size="16" />
                <GitCommitHorizontal v-else :size="16" />
              </span>
              <div class="repository-worktree-copy">
                <div class="repository-worktree-title">
                  <strong :title="worktreeLabel(worktree)">{{ worktreeLabel(worktree) }}</strong>
                  <Badge v-if="worktree.isCurrent" variant="default"><Check :size="12" />{{ t("repository.worktreesPanel.current") }}</Badge>
                  <Badge variant="secondary">{{ worktreeKindLabel(worktree) }}</Badge>
                </div>
                <code v-if="worktreeCommit(worktree)" :title="worktree.head.oid">{{ worktreeCommit(worktree) }}</code>
              </div>
            </div>
            <div class="repository-worktree-summary">
              <span v-if="activeSessionCount(worktree)" class="repository-worktree-summary-item">
                <MessagesSquare :size="13" aria-hidden="true" />
                <span>{{ t("repository.environmentExtra.associatedSessions", { count: activeSessionCount(worktree) }) }}</span>
              </span>
              <span v-if="worktree.dirty" class="repository-worktree-summary-item" data-state="warning">
                <FileDiff :size="13" aria-hidden="true" />
                <span>{{ t("repository.worktreesPanel.dirty") }}</span>
              </span>
              <span v-if="worktree.locked" class="repository-worktree-summary-item" data-state="warning">
                <LockKeyhole :size="13" aria-hidden="true" />
                <span>{{ t("repository.worktreesPanel.locked") }}</span>
              </span>
              <span v-if="worktree.prunable" class="repository-worktree-summary-item" data-state="warning">
                <Eraser :size="13" aria-hidden="true" />
                <span>{{ t("repository.worktreesPanel.prunable") }}</span>
              </span>
            </div>
            <div class="repository-worktree-row-actions">
              <DropdownMenu v-if="canStartAiSession || canManageWorktrees">
                <DropdownMenuTrigger as-child>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    class="repository-worktree-row-menu"
                    :aria-label="t('repository.worktreesPanel.actions')"
                    :title="t('repository.worktreesPanel.actions')"
                  >
                    <MoreHorizontal :size="16" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent class="repository-worktree-menu" align="end" :side-offset="5">
                  <DropdownMenuItem
                    v-if="canStartAiSession"
                    :disabled="!worktree.canCreateAiSession || Boolean(startingWorktreeId)"
                    :title="worktree.canCreateAiSession ? t('repository.worktreesPanel.newHere') : blockerSummary(worktree)"
                    @select="openStartComposer(worktree)"
                  >
                    <Plus :size="14" />
                    <span class="repository-worktree-menu-copy">
                      <strong>{{ t("repository.worktreesPanel.newHere") }}</strong>
                      <small v-if="!worktree.canCreateAiSession">{{ blockerSummary(worktree) }}</small>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    v-if="canManageWorktrees"
                    class="repository-worktree-menu-remove"
                    :disabled="worktree.isMain || worktree.isCurrent || !worktree.canRemove || removingWorktree"
                    @select="confirmRemove(worktree)"
                  >
                    <Trash2 :size="14" />
                    <span class="repository-worktree-menu-copy">
                      <strong>{{ t("repository.worktreesPanel.remove") }}</strong>
                      <small v-if="worktree.isMain || worktree.isCurrent || !worktree.canRemove">{{ removeBlockerSummary(worktree) }}</small>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <small v-if="worktree.lockReason" class="repository-worktree-warning">
              <TriangleAlert :size="13" aria-hidden="true" />
              <span>{{ worktree.lockReason }}</span>
            </small>
            <small v-else-if="canStartAiSession && !worktree.canCreateAiSession" class="repository-worktree-warning">
              <TriangleAlert :size="13" aria-hidden="true" />
              <span>{{ worktreeBlockerSummary(worktree) }}</span>
            </small>
            <form
              v-if="canStartAiSession && worktree.canCreateAiSession && startingComposerWorktreeId === worktree.id"
              class="repository-worktree-start-composer"
              @submit.prevent="startAiSession(worktree)"
            >
              <Textarea v-model="startMessage" :placeholder="t('repository.worktreesPanel.taskPlaceholder')" :disabled="Boolean(startingWorktreeId)" autofocus />
              <span>
                <Button type="button" variant="outline" size="sm" :disabled="Boolean(startingWorktreeId)" @click="closeStartComposer">{{ t("repository.common.cancel") }}</Button>
                <Button type="submit" size="sm" :disabled="Boolean(startingWorktreeId) || !startMessage.trim()">
                  <LoaderCircle v-if="startingWorktreeId === worktree.id" class="repository-worktree-spin" :size="14" />
                  <Plus v-else :size="14" />
                  {{ t(startingWorktreeId === worktree.id ? "repository.worktreesPanel.starting" : "repository.worktreesPanel.start") }}
                </Button>
              </span>
            </form>
          </article>
          <div v-if="!filteredWorktrees.length" class="repository-worktree-state">
            <Search :size="17" />
            <span>{{ t("repository.worktreesPanel.noMatch") }}</span>
          </div>
        </div>
      </ScrollArea>
    </section>

    <NewWorktreeDialog
      :branches="createBranches"
      :busy="creatingManagedSession"
      :busy-label="t('repository.worktreesPanel.creating')"
      :confirm-enabled="Boolean(worktrees?.snapshotId)"
      :confirm-label="t('repository.worktreesPanel.create')"
      :default-start-ref="createStartRef"
      :description="t('repository.worktreesPanel.createDescription')"
      :open="createOpen"
      @confirm="createWorktree"
      @update:open="setCreateDialogOpen"
    >
      <RepositoryErrorNotice v-if="createError" :error="createError" :fallback="t('repository.worktreesPanel.createError')" />
    </NewWorktreeDialog>

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
import { Check, Eraser, FileDiff, GitBranch, GitCommitHorizontal, GitFork, LoaderCircle, LockKeyhole, MessagesSquare, MoreHorizontal, Plus, RefreshCw, Search, Trash2, TriangleAlert } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { createRepositoryWorkspaceWorktree, removeRepositoryWorkspaceWorktree, useRepositoryWorkspaceBranchesQuery, useRepositoryWorkspaceWorktreesQuery } from "../../../api/repository";
import { createAiSession } from "../../../api/queries";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Textarea } from "../../../components/ui/textarea";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import { createBrowserUuid } from "../../../lib/random-id";
import NewWorktreeDialog, { type NewWorktreeBranch, type NewWorktreeSelection } from "./NewWorktreeDialog.vue";

const props = defineProps<{
  aiAgent?: "codex" | "claude" | "opencode";
  cwdFolderId?: string;
  instanceId: string;
  open: boolean;
  sessionId?: string;
  sessionKind?: RepositorySessionKind;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  aiSessionStarted: [result: RepositoryAiSessionLaunchResult];
}>();

const target = computed(() => ({
  instanceId: props.instanceId,
  ...(props.cwdFolderId ? { cwdFolderId: props.cwdFolderId } : {}),
  ...(props.sessionId && props.sessionKind ? { legacySession: { instanceId: props.instanceId, sessionId: props.sessionId, sessionKind: props.sessionKind } } : {}),
}));
const worktreesQuery = useRepositoryWorkspaceWorktreesQuery(target, computed(() => props.open));
const worktrees = computed(() => worktreesQuery.data.value);
const searchQuery = ref("");
const searchActive = computed(() => searchQuery.value.trim().length > 0);
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
    worktreeKindLabel(worktree),
  ].some((value) => value?.toLocaleLowerCase().includes(query)));
});
const canStartAiSession = computed(() => Boolean(props.aiAgent));
const canManageWorktrees = computed(() => true);
const branchesQuery = useRepositoryWorkspaceBranchesQuery(target, computed(() => props.open));
const startingWorktreeId = ref("");
const startError = ref<unknown>();
const createOpen = ref(false);
const createStartRef = ref("HEAD");
const creatingManagedSession = ref(false);
const createError = ref<unknown>();
const removeDialogOpen = ref(false);
const removeTarget = ref<RepositoryWorktree>();
const removingWorktree = ref(false);
const removeError = ref<unknown>();
const removeSuccessKey = ref("");
const startingComposerWorktreeId = ref("");
const startMessage = ref("");
const createBranches = computed<NewWorktreeBranch[]>(() => (branchesQuery.data.value?.branches || [])
  .filter((branch) => branch.kind === "local")
  .map((branch) => ({
    name: branch.name,
    worktreeCheckout: branch.checkedOutWorktreeIds.length ? "detached" : "attached",
    worktreeSelectable: true,
  })));

function worktreeLabel(worktree: RepositoryWorktree) {
  if (worktree.head.state === "branch") return worktree.head.branch || t("repository.common.unknownBranch");
  if (worktree.head.state === "unborn") return t("repository.common.unbornBranch");
  return t("repository.common.detachedAt", { commit: worktree.head.oid?.slice(0, 8) || t("repository.environmentExtra.unknownCommit") });
}

function worktreeKindLabel(worktree: RepositoryWorktree) {
  if (worktree.isMain) return t("repository.worktreesPanel.main");
  return t(worktree.managed ? "repository.worktreesPanel.managed" : "repository.worktreesPanel.external");
}

function worktreeCommit(worktree: RepositoryWorktree) {
  return worktree.head.state === "branch" ? worktree.head.oid?.slice(0, 8) : undefined;
}

function activeSessionCount(worktree: RepositoryWorktree) {
  return worktree.activeAiSessionIds.length + worktree.activeAppSessionIds.length;
}

function worktreeBlockerSummary(worktree: RepositoryWorktree) {
  return worktree.createAiSessionBlockers.map(blockerLabel).join(" · ") || blockerSummary(worktree);
}

function blockerSummary(worktree: RepositoryWorktree) {
  if (worktree.locked) return t("repository.worktreesPanel.blockers.locked");
  if (worktree.prunable) return t("repository.worktreesPanel.blockers.prunable");
  if (worktree.createAiSessionBlockers.includes("outside-workspace-roots")) return t("repository.worktreesPanel.blockers.outside");
  if (worktree.createAiSessionBlockers.includes("path-inaccessible")) return t("repository.worktreesPanel.blockers.inaccessible");
  return t("repository.worktreesPanel.blockers.unavailable");
}

function removeBlockerSummary(worktree: RepositoryWorktree) {
  if (worktree.isCurrent) return t("repository.worktreesPanel.blockers.currentWorktree");
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
    const result = await removeRepositoryWorkspaceWorktree(target.value, {
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

function openCreateDialog() {
  createError.value = undefined;
  const current = worktrees.value?.items.find((item) => item.isCurrent);
  createStartRef.value = current?.head.branch || current?.head.oid || "HEAD";
  createOpen.value = true;
}

function setCreateDialogOpen(open: boolean) {
  if (creatingManagedSession.value) return;
  createOpen.value = open;
}

async function createWorktree(selection: NewWorktreeSelection) {
  if (!canManageWorktrees.value || !worktrees.value?.snapshotId || creatingManagedSession.value) return;
  createError.value = undefined;
  creatingManagedSession.value = true;
  try {
    await createRepositoryWorkspaceWorktree(target.value, { ...selection, expectedSnapshotId: worktrees.value.snapshotId });
    createOpen.value = false;
    await worktreesQuery.refetch();
  } catch (error) {
    createError.value = error;
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
    const created = await createAiSession(props.instanceId, {
      agent: props.aiAgent,
      ...(props.cwdFolderId ? { cwdFolderId: props.cwdFolderId } : {}),
      workspaceSelection: {
        type: "existing-worktree",
        repositoryContextId: worktrees.value.repositoryContextId,
        worktreeId: worktree.id,
      },
      message,
      attachments: [],
      references: [],
      clientRequestId: createBrowserUuid(),
    });
    const result: RepositoryAiSessionLaunchResult = {
      aiSessionId: created.aiSessionId,
      providerSessionId: created.providerSessionId,
      worktreeId: worktree.id,
      disposition: "started",
    };
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
  container: repository-worktrees / inline-size;
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-rows: auto auto minmax(0, 1fr);
  overflow: hidden;
  background: var(--workspace-bg);
  color: var(--text);
}

.repository-worktrees-head {
  display: flex;
  min-width: 0;
  min-height: 52px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--line-subtle);
  background: var(--surface);
  padding: 0 11px 0 15px;
}

.repository-worktrees-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.repository-worktrees-title > svg {
  flex: 0 0 auto;
  color: var(--brand-accent);
}

.repository-worktrees-title > span {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.repository-worktrees-title strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-worktrees-title small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-worktrees-head-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.repository-worktrees-head-actions :deep(button) {
  height: 28px;
  gap: 5px;
  font-size: 12px;
}

.repository-worktrees-refresh {
  width: 28px;
  padding: 0;
}

.repository-worktrees-toolbar {
  display: flex;
  min-width: 0;
  min-height: 42px;
  align-items: center;
  border-bottom: 1px solid var(--line-subtle);
  background: var(--surface-raised);
  padding: 5px 11px;
}

.repository-worktrees-search {
  position: relative;
  display: flex;
  width: min(400px, 100%);
  min-width: 0;
  align-items: center;
}

.repository-worktrees-search > svg {
  position: absolute;
  left: 10px;
  z-index: 1;
  color: var(--text-muted);
  pointer-events: none;
}

.repository-worktrees-search :deep(input) {
  padding-left: 32px;
}

.repository-worktree-directory {
  display: flex;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  margin: 12px 14px 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
}

.repository-worktree-directory-head {
  display: flex;
  min-width: 0;
  min-height: 38px;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--line);
  padding: 0 12px;
}

.repository-worktree-directory-head strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.repository-worktree-directory-head span {
  color: var(--text-muted);
  font-size: 12px;
}

.repository-worktree-directory-error {
  margin: 12px;
}

.repository-worktree-scroll {
  min-height: 0;
  flex: 1 1 auto;
}

.repository-worktree-list {
  display: grid;
  min-width: 0;
}

.repository-worktree-list > :deep(.repository-error-notice) {
  margin: 10px 12px 0;
}

.repository-worktree-row {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1.35fr) minmax(190px, 1fr) auto;
  align-items: center;
  gap: 8px 16px;
  min-height: 76px;
  padding: 10px 12px;
}

.repository-worktree-row + .repository-worktree-row {
  border-top: 1px solid var(--line);
}

.repository-worktree-identity {
  display: grid;
  min-width: 0;
  align-items: flex-start;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
}

.repository-worktree-icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  color: var(--brand-accent-muted);
}

.repository-worktree-row[data-current="true"] .repository-worktree-icon {
  color: var(--repository-current-text, var(--brand-accent-muted));
}

.repository-worktree-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.repository-worktree-title {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.repository-worktree-title strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-worktree-row[data-current="true"] .repository-worktree-title strong {
  color: var(--repository-current-text, var(--brand-accent-muted, var(--brand-accent)));
}

.repository-worktree-copy code {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-worktree-summary {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.repository-worktree-summary-item {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
}

.repository-worktree-summary-item > svg {
  flex: 0 0 auto;
}

.repository-worktree-summary-item > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-worktree-summary-item[data-state="warning"] {
  color: var(--status-warning);
}

.repository-worktree-warning {
  display: flex;
  min-width: 0;
  grid-column: 1 / -1;
  align-items: flex-start;
  gap: 5px;
  color: var(--status-warning);
  font-size: 12px;
  line-height: 1.35;
}

.repository-worktree-warning svg {
  flex: 0 0 auto;
  margin-top: 1px;
}

.repository-worktree-row-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.repository-worktree-notice {
  display: flex;
  align-items: center;
  gap: 7px;
  border-bottom: 1px solid var(--line);
  color: var(--status-success, #2dd4bf);
  padding: 8px 12px;
  font-size: 12px;
}

.repository-worktree-start-composer {
  display: grid;
  grid-column: 1 / -1;
  gap: 7px;
}

.repository-worktree-start-composer :deep(textarea) {
  min-height: 68px;
  font-size: 12px;
  resize: vertical;
}

.repository-worktree-start-composer > span {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.repository-worktree-row-menu {
  width: 28px;
  height: 28px;
}

:global(.repository-worktree-menu) {
  width: min(260px, calc(100vw - 24px));
}

:global(.repository-worktree-menu-remove) {
  color: var(--status-danger);
}

:global(.repository-worktree-menu-copy) {
  display: grid;
  min-width: 0;
  gap: 1px;
}

:global(.repository-worktree-menu-copy strong) {
  font-size: 13px;
  font-weight: 500;
}

:global(.repository-worktree-menu-copy small) {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.35;
  white-space: normal;
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
  display: flex;
  min-height: 120px;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

@container repository-worktrees (max-width: 720px) {
  .repository-worktrees-head { min-height: 44px; gap: 8px; padding: 0 9px 0 11px; }
  .repository-worktrees-head-actions :deep(button span) { display: none; }
  .repository-worktrees-head-actions :deep(button) { width: 28px; padding: 0; }
  .repository-worktrees-toolbar { min-height: 38px; padding: 4px 9px; }
  .repository-worktrees-search { width: 100%; }
  .repository-worktree-directory { margin: 10px; }
  .repository-worktree-row {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 8px 10px;
  }
  .repository-worktree-summary {
    grid-column: 1 / -1;
  }
  .repository-worktree-row-actions { align-items: flex-start; }
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
