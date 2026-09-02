<template>
  <section class="story-view">
    <div v-if="error" class="story-error" role="alert">{{ error }}</div>

    <div ref="workspaceEl" class="story-workspace" :data-resizing="resizingSidebar ? 'true' : undefined" :style="{ '--story-sidebar-width': `${sidebarWidth}px` }">
      <aside class="story-sidebar" :aria-busy="storiesFetching ? 'true' : undefined" :aria-label="t('stories.region')">
        <div class="story-sidebar-actions">
          <button type="button" class="story-tree-item story-new-button" @click="openCreate"><Plus :size="15" /><span><strong>{{ t("stories.newStory") }}</strong></span></button>
          <div class="story-sidebar-section">
            <span class="story-sidebar-section-label">{{ t("stories.section") }}</span>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-sm" class="story-view-mode-button" :aria-label="t('stories.viewMode')" :title="t('stories.viewMode')"><LayoutList :size="15" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem :aria-current="treeViewMode === 'compact'" @select="setTreeViewMode('compact')"><Check v-if="treeViewMode === 'compact'" :size="13" /><LayoutList :size="13" />{{ t("stories.compactMode") }}</DropdownMenuItem>
                <DropdownMenuItem :aria-current="treeViewMode === 'detailed'" @select="setTreeViewMode('detailed')"><Check v-if="treeViewMode === 'detailed'" :size="13" /><Rows3 :size="13" />{{ t("stories.detailedMode") }}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <ScrollArea type="hover" :horizontal="false" class="story-sidebar-scroll">
          <div class="story-sidebar-scroll-inner">
            <div v-if="!stories.length && !storiesPending" class="story-empty">{{ t("stories.empty") }}</div>
            <div v-for="story in stories" :key="`${story.ownerNodeId}:${story.id}`" class="story-tree">
              <div class="story-tree-story-row">
                <button type="button" class="story-tree-disclosure-button" :aria-label="t(isStoryOpen(story) ? 'stories.collapse' : 'stories.expand')" :aria-expanded="isStoryOpen(story)" @click.stop="toggleStoryExpanded(story)">
                  <ChevronRight :size="15" class="story-tree-disclosure" :class="{ expanded: isStoryOpen(story) }" />
                </button>
                <ContextMenu>
                  <ContextMenuTrigger as-child>
                    <button type="button" class="story-tree-item story-tree-story" :class="{ active: isStorySelected(story) }" @click="selectStory(story)">
                      <BookOpen :size="15" />
                      <span><strong>{{ story.title }}</strong></span>
                    </button>
                  </ContextMenuTrigger>
                  <StoryTreeContextMenu
                    :story="story"
                    :can-new-session="!Boolean(story.archivedAt) && instancesForStory(story).length > 0"
                    :can-add-existing="!Boolean(story.archivedAt) && unassignedSessionsFor(story).length > 0"
                    @new-session="openNewSession(story)"
                    @add-existing="openAssignSessionFor(story)"
                    @edit="editStoryFromTree(story)"
                    @toggle-archive="toggleArchive(story)"
                    @delete="deleteStory(story)"
                  />
                </ContextMenu>
                <button type="button" class="story-tree-add story-tree-story-add" :aria-label="t('stories.newSession')" :title="t('stories.newSession')" :disabled="Boolean(story.archivedAt) || !instancesForStory(story).length" @click.stop="openNewSession(story)"><MessageSquarePlus :size="14" /></button>
              </div>
              <div v-if="isStoryOpen(story)" class="story-tree-children">
                <ContextMenu v-for="document in story.documents" :key="document.storyPath">
                  <ContextMenuTrigger as-child>
                    <button type="button" class="story-tree-item" :class="{ active: isDocumentSelected(story, document.storyPath), 'story-tree-item-detailed': treeViewMode === 'detailed' }" @click="selectDocument(story, document.storyPath)">
                      <FileText :size="14" /><span :class="{ 'story-tree-item-detail': treeViewMode === 'detailed' }"><strong>{{ document.title }}</strong><small v-if="treeViewMode === 'detailed'">{{ document.storyPath }}</small></span><small v-if="treeViewMode === 'compact'" class="story-tree-item-hint" aria-hidden="true">{{ document.storyPath }}</small>
                    </button>
                  </ContextMenuTrigger>
                  <DocumentTreeContextMenu :disabled="Boolean(story.archivedAt)" @open="selectDocument(story, document.storyPath)" @download="downloadDocument(story, document.storyPath)" @rename="renameDocument(story, document.storyPath, document.title)" @delete="deleteDocument(story, document.storyPath)" />
                </ContextMenu>
                <ContextMenu v-for="entry in sessionsFor(story)" :key="entry.session.id">
                  <ContextMenuTrigger as-child>
                    <button type="button" class="story-tree-item" :class="{ active: isSessionSelected(story, entry.session.id), 'story-tree-item-detailed': treeViewMode === 'detailed', 'story-tree-item-unread': entry.session.unread }" :data-state="entry.session.status" :data-unread="entry.session.unread ? 'true' : undefined" @click="selectSession(story, entry)">
                      <span v-if="entry.session.status === 'running'" class="story-session-status"><AiSessionStatusIndicator :status="entry.session.status" /></span><span v-else class="story-session-icon"><MessageSquare :size="14" /><AiSessionStatusIndicator class="story-session-icon-status" :status="entry.session.status" size="compact" /></span><span :class="{ 'story-tree-item-detail': treeViewMode === 'detailed' }"><strong>{{ entry.session.title || entry.session.userPrompt || entry.session.id }}</strong><small v-if="treeViewMode === 'detailed'">{{ entry.instance.name }} · {{ sessionStatusLabel(entry.session.status, t) }}</small></span><small v-if="treeViewMode === 'compact'" class="story-tree-item-hint" aria-hidden="true">{{ entry.instance.name }}</small><span v-if="entry.session.unread" class="story-session-unread" :aria-label="t('sessions.actions.unread')" :title="t('sessions.actions.unread')" />
                    </button>
                  </ContextMenuTrigger>
                  <AiSessionCardContextMenu
                    :bound-trigger-count="0"
                    :has-app-session="Boolean(entry.session.appSessionId)"
                    :can-open-app="Boolean(entry.session.appSessionId || entry.session.actions?.openApp)"
                    :can-open-terminal="false"
                    :can-fork="false"
                    :is-forking="false"
                    :is-opening-terminal="false"
                    :is-stopping-app-session="closingSessionKey === entry.session.id"
                    :show-trigger-actions="false"
                    :story-target="storyTargetFor(entry)"
                    :is-trigger-bound="() => false"
                    :is-trigger-busy="() => false"
                    :short-hash="shortHash"
                    :trigger-templates="[]"
                    @close-session="closeSession(entry)"
                    @open-app="openStoryAiSessionApp(entry.instance, entry.session)"
                    @story-assigned="onStoryAssigned"
                    @story-assign-failed="onStoryAssignFailed"
                  />
                </ContextMenu>
                <div v-if="!sessionsFor(story).length" class="story-tree-empty">{{ t("stories.noLinkedSessions") }}</div>
              </div>
            </div>
            <div v-if="storiesFetching" class="story-loading-overlay" role="status" aria-live="polite">
              <LoaderCircle class="story-loading-spin" :size="18" />
            </div>
          </div>
        </ScrollArea>
      </aside>
      <button type="button" class="story-sidebar-resize-handle" :aria-label="t('stories.resizeList')" :title="t('stories.resizeList')" @pointerdown.stop.prevent="startSidebarResize" @click.stop @dragstart.prevent />

      <main class="story-content" :class="{ 'story-session-pane': (selectedResource?.kind === 'session' || selectedResource?.kind === 'new-session') }">
        <template v-if="selectedResource?.kind === 'new-session'">
          <AiSessionPanel v-if="newSessionInstance" class="story-session-creator" :active-session="creationActiveSession" creation-only :creation-story-id="selectedResource.story.id" :creation-initial-cwd="newSessionInitialCwd" :creation-initial-cwd-folder-id="newSessionInitialCwdFolderId" :creation-instances="storyInstances" :instance="newSessionInstance" :launchable-apps="launchableAppsForInstance(newSessionInstance, t)" :node-local-folders="nodeLocalFoldersByNodeId[newSessionInstance.nodeId] || []" :selected-ai-session="noSelectedAiSession" @update:creation-instance="selectCreationInstance" @session-created="finishStorySessionCreation" />
          <div v-else class="story-content-state">{{ t("stories.noAvailableInstance") }}</div>
        </template>
        <template v-else-if="selectedResource?.kind === 'session'">
          <AiSessionPanel
            class="story-session-creator"
            :active-session="storySessionTab"
            detail-only
            :instance="selectedSessionInstance"
            :launchable-apps="launchableAppsForInstance(selectedSessionInstance, t)"
            :node-local-folders="nodeLocalFoldersByNodeId[selectedSessionInstance?.nodeId || ''] || []"
            :selected-ai-session="selectedStorySession"
            @select-ai-session="handleSelectAiSession"
            @launch-app="(target, appId, cwdFolderId, options) => emit('launch-app', target, appId, cwdFolderId, options)"
            @open-ai-session-app="(target, session) => openStoryAiSessionApp(target, session)"
            @open-repository-workspace="$emit('open-repository-workspace', $event)"
            @session-created="finishStorySessionCreation"
          />
        </template>
        <template v-else-if="selectedResource?.kind === 'document'">
          <header class="story-content-header">
            <div class="story-content-title"><h2>{{ selectedResource.document.title }}</h2><small>{{ selectedResource.document.storyPath }}</small></div>
            <div class="story-content-actions"><a class="story-content-download" :href="downloadUrl(selectedResource.story, selectedResource.document.storyPath)" :download="selectedResource.document.storyPath.split('/').pop()"><Download :size="14" /> {{ t("common.actions.download") }}</a><Button variant="outline" size="sm" :disabled="Boolean(selectedResource.story.archivedAt)" @click="renameDocument(selectedResource.story, selectedResource.document.storyPath, selectedResource.document.title)">{{ t("common.actions.rename") }}</Button><Button variant="outline" size="sm" :disabled="Boolean(selectedResource.story.archivedAt)" @click="deleteDocument(selectedResource.story, selectedResource.document.storyPath)">{{ t("common.actions.delete") }}</Button></div>
          </header>
          <div v-if="previewLoading" class="story-content-state">{{ t("stories.loadingDocument") }}</div>
          <div v-else-if="previewError" class="story-content-state story-error">{{ previewError }}</div>
          <ScrollArea v-else type="auto" :horizontal="false" class="story-document-markdown">
            <div class="story-document-markdown-content">
              <AiSessionStreamingMarkdown
                :instance-id="documentInstanceId"
                :session-id="documentMarkdownSessionId"
                :html-policy="documentHtmlPolicy"
                :code-tools="markdownCodeTools"
                :content="previewText"
                :file-links="true"
                @open-file="onOpenDocumentLink"
              />
            </div>
          </ScrollArea>
        </template>
        <template v-else-if="selectedResource?.kind === 'story'">
          <header class="story-content-header">
            <div class="story-content-title"><h2>{{ selectedResource.story.title }}</h2><small>{{ storyOwnerNodeName(selectedResource.story.ownerNodeId) }}</small></div>
            <div class="story-content-actions"><Button variant="outline" size="sm" @click="openEdit"><Pencil :size="14" /> {{ t("common.actions.edit") }}</Button><DropdownMenu><DropdownMenuTrigger as-child><Button variant="outline" size="icon-sm" :aria-label="t('stories.moreActions')" :title="t('stories.moreActions')"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt)" @select="openNewSession(selectedResource.story)">{{ t("stories.newSession") }}</DropdownMenuItem><DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt) || !availableSessions.length" @select="openAssignSession">{{ t("stories.addExisting") }}</DropdownMenuItem><DropdownMenuItem @select="toggleArchive(selectedResource.story)">{{ t(selectedResource.story.archivedAt ? "common.actions.restore" : "common.actions.archive") }}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
          </header>
          <p v-if="selectedResource.story.description" class="story-description">{{ selectedResource.story.description }}</p>
          <div class="story-overview-grid"><div><strong>{{ selectedResource.story.documents.length }}</strong><span>{{ t("stories.documents") }}</span></div><div><strong>{{ sessionCount(selectedResource.story) }}</strong><span>{{ t("stories.aiSessions") }}</span></div><div><strong>{{ selectedResource.story.actions.length }}</strong><span>{{ t("stories.presetActions") }}</span></div></div>
          <section class="story-actions-section">
            <div class="story-actions-header"><h3>{{ t("stories.presetActions") }}</h3><Button variant="outline" size="sm" :disabled="Boolean(selectedResource.story.archivedAt)" @click="openCreateAction"><Plus :size="14" /> {{ t("stories.addAction") }}</Button></div>
            <div v-if="!selectedResource.story.actions.length" class="story-empty">{{ t("stories.noPresetActions") }}</div>
            <div v-for="action in selectedResource.story.actions" :key="action.id" class="story-action-item">
              <button type="button" class="story-action-run" :disabled="Boolean(selectedResource.story.archivedAt)" @click="$emit('run-action', selectedResource.story, action)">
                <span class="story-action-icon"><Play :size="14" /></span>
                <span class="story-action-copy">
                  <strong>{{ action.title }}</strong>
                  <small>{{ action.promptTemplate }}</small>
                  <span class="story-action-meta">{{ actionTargetName(selectedResource.story, action) }}<template v-if="action.parameters.length"> · {{ t("stories.parameterCount", { count: action.parameters.length }) }}</template><template v-if="actionSessionPresetSummary(action)"> · {{ actionSessionPresetSummary(action) }}</template></span>
                </span>
              </button>
              <button type="button" class="story-action-edit" :disabled="Boolean(selectedResource.story.archivedAt)" :aria-label="t('stories.editNamed', { name: action.title })" :title="t('stories.editNamed', { name: action.title })" @click.stop="openEditAction(action)"><Pencil :size="13" /></button>
            </div>
          </section>
        </template>
        <div v-else class="story-content-state">{{ t("stories.selectResource") }}</div>
      </main>
    </div>
  </section>

  <Dialog v-model:open="editorOpen">
    <DialogContent class="story-editor-dialog"><DialogHeader><DialogTitle>{{ t(editing ? "stories.editor.editTitle" : "stories.editor.newTitle") }}</DialogTitle><DialogDescription>{{ t("stories.editor.description") }}</DialogDescription></DialogHeader><div class="story-editor-fields"><label>{{ t("stories.editor.title") }}<Input v-model="draftTitle" :placeholder="t('stories.editor.titlePlaceholder')" /></label><label>{{ t("stories.editor.descriptionLabel") }}<Textarea v-model="draftDescription" :placeholder="t('stories.editor.descriptionPlaceholder')" /></label><label>{{ t("stories.editor.ownerNode") }}<ControlPlaneSelect v-model="draftNodeId" :disabled="editing"><ControlPlaneSelectItem v-for="node in nodes.filter((candidate) => candidate.status === 'online')" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label></div><DialogFooter><Button variant="outline" @click="editorOpen = false">{{ t("common.actions.cancel") }}</Button><Button :disabled="!draftTitle.trim() || !draftNodeId || saving" @click="saveStory">{{ saving ? t("stories.editor.saving") : t("common.actions.save") }}</Button></DialogFooter></DialogContent>
  </Dialog>
  <Dialog v-model:open="assignSessionOpen"><DialogContent class="story-editor-dialog"><DialogHeader><DialogTitle>{{ t("stories.assign.title") }}</DialogTitle><DialogDescription>{{ t("stories.assign.description") }}</DialogDescription></DialogHeader><div class="story-editor-fields"><label>{{ t("stories.assign.session") }}<ControlPlaneSelect v-model="assignSessionId"><ControlPlaneSelectItem v-for="entry in availableSessions" :key="`${entry.instance.id}:${entry.session.id}`" :value="`${entry.instance.id}:${entry.session.id}`">{{ entry.session.title || entry.session.userPrompt || entry.session.id }} · {{ entry.instance.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label></div><DialogFooter><Button variant="outline" @click="assignSessionOpen = false">{{ t("common.actions.cancel") }}</Button><Button :disabled="!assignSessionId || assigningSession" @click="assignExistingSession">{{ assigningSession ? t("stories.assign.adding") : t("stories.assign.submit") }}</Button></DialogFooter></DialogContent></Dialog>
  <Dialog v-model:open="actionEditorOpen">
    <DialogContent class="story-editor-dialog story-action-editor-dialog">
      <DialogHeader><DialogTitle>{{ t(editingActionId ? "stories.actionEditor.editTitle" : "stories.actionEditor.newTitle") }}</DialogTitle><DialogDescription>{{ t("stories.actionEditor.description") }}</DialogDescription></DialogHeader>
      <ScrollArea class="story-action-editor-scroll" :horizontal="false">
        <div class="story-editor-fields story-action-editor-fields">
        <label>{{ t("stories.actionEditor.title") }}<Input v-model="actionDraftTitle" :placeholder="t('stories.actionEditor.titlePlaceholder')" /></label>
        <label>{{ t("stories.actionEditor.promptTemplate") }}<Textarea v-model="actionDraftPrompt" :placeholder="t('stories.actionEditor.promptPlaceholder')" /></label>
        <label>{{ t("stories.actionEditor.targetInstance") }}<ControlPlaneSelect v-model="actionDraftTargetInstanceId" :placeholder="t('stories.actionEditor.selectTargetInstance')"><ControlPlaneSelectItem v-for="instance in storyInstances" :key="instance.id" :value="instance.id">{{ instance.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
        <div class="story-action-preset">
          <div class="story-action-preset-title">{{ t("stories.actionEditor.sessionPreset") }}</div>
          <div class="story-action-preset-grid">
            <label>{{ t("stories.actionEditor.agent") }}<ControlPlaneSelect v-model="actionDraftAgent" :placeholder="t('stories.actionEditor.defaultAgent')"><ControlPlaneSelectItem value="codex">{{ t("common.products.codex") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="claude">{{ t("common.products.claude") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="opencode">{{ t("common.products.opencode") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.messageMode") }}<ControlPlaneSelect v-model="actionDraftMode" :placeholder="t('stories.actionEditor.defaultValue')"><ControlPlaneSelectItem value="auto">{{ t("stories.actionEditor.auto") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="queue">{{ t("stories.actionEditor.queue") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="steer">{{ t("stories.actionEditor.steer") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="immediate">{{ t("stories.actionEditor.immediate") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.permission") }}<ControlPlaneSelect v-model="actionDraftPermissionMode" :placeholder="t('stories.actionEditor.defaultPermission')"><ControlPlaneSelectItem value="ask">{{ t("stories.actionEditor.ask") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="auto-review">{{ t("stories.actionEditor.autoReview") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="full-access">{{ t("stories.actionEditor.fullAccess") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.reasoningEffort") }}<ControlPlaneSelect v-model="actionDraftReasoningEffort" :placeholder="t('stories.actionEditor.defaultValue')"><ControlPlaneSelectItem v-for="effort in reasoningEfforts" :key="effort" :value="effort">{{ t(`stories.actionEditor.reasoning.${effort}`) }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.modelEntityId") }}<Input v-model="actionDraftModelEntityId" :placeholder="t('stories.actionEditor.optionalModelId')" /></label>
            <label>{{ t("stories.actionEditor.modelName") }}<Input v-model="actionDraftModelName" :placeholder="t('stories.actionEditor.optionalModelName')" /></label>
            <label>{{ t("stories.actionEditor.workingFolder") }}<ControlPlaneSelect v-model="actionDraftCwdFolderId" :placeholder="t('stories.actionEditor.defaultValue')"><ControlPlaneSelectItem v-for="folder in actionDraftCwdFolders" :key="folder.id" :value="folder.id">{{ folder.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.gitMode") }}<ControlPlaneSelect v-model="actionDraftGitMode" :placeholder="t('stories.actionEditor.defaultValue')"><ControlPlaneSelectItem value="current-folder">{{ t("stories.actionEditor.currentFolder") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="worktree">{{ t("stories.actionEditor.worktree") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label>{{ t("stories.actionEditor.gitBranch") }}<Input v-model="actionDraftGitBranch" :placeholder="t('stories.actionEditor.optionalBranch')" /></label>
          </div>
        </div>
        <div class="story-action-parameters">
          <div class="story-action-parameters-header"><span>{{ t("stories.actionEditor.parameters") }}</span><Button type="button" variant="ghost" size="sm" @click="addActionParameter"><Plus :size="13" /> {{ t("stories.actionEditor.addParameter") }}</Button></div>
          <div v-for="(parameter, index) in actionDraftParameters" :key="index" class="story-action-parameter">
            <Input v-model="parameter.name" :placeholder="t('stories.actionEditor.namePlaceholder')" :aria-label="t('stories.actionEditor.parameterName')" />
            <Input v-model="parameter.label" :placeholder="t('stories.actionEditor.labelPlaceholder')" :aria-label="t('stories.actionEditor.parameterLabel')" />
            <Input v-model="parameter.defaultValue" :placeholder="t('stories.actionEditor.defaultValue')" :aria-label="t('stories.actionEditor.parameterDefault')" />
            <label class="story-action-parameter-required"><Checkbox :model-value="parameter.required" @update:model-value="parameter.required = Boolean($event)" /> {{ t("stories.actionEditor.required") }}</label>
            <Button type="button" variant="ghost" size="icon" :aria-label="t('stories.actionEditor.removeParameter')" @click="removeActionParameter(index)"><X :size="13" /></Button>
          </div>
          <div v-if="!actionDraftParameters.length" class="story-empty">{{ t("stories.actionEditor.noParameters") }}</div>
        </div>
        </div>
      </ScrollArea>
      <DialogFooter><Button variant="outline" @click="actionEditorOpen = false">{{ t("common.actions.cancel") }}</Button><Button :disabled="!actionDraftTitle.trim() || !actionDraftPrompt.trim() || !actionDraftTargetInstanceId || actionSaving" @click="saveAction">{{ actionSaving ? t("stories.actionEditor.saving") : t("common.actions.save") }}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { BookOpen, Check, ChevronRight, Download, FileText, LayoutList, LoaderCircle, MessageSquare, MessageSquarePlus, MoreHorizontal, Pencil, Play, Plus, Rows3, X } from "@lucide/vue";
import AiSessionStatusIndicator from "../../../components/ai-session/AiSessionStatusIndicator.vue";
import AiSessionStreamingMarkdown from "../../../components/ai-session/AiSessionStreamingMarkdown.vue";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import Input from "../../../components/ui/input/Input.vue";
import Textarea from "../../../components/ui/textarea/Textarea.vue";
import { Checkbox } from "../../../components/ui/checkbox";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { ContextMenu, ContextMenuTrigger } from "../../../components/ui/context-menu";
import AiSessionCardContextMenu from "../../../components/ai-session/AiSessionCardContextMenu.vue";
import StoryTreeContextMenu from "./StoryTreeContextMenu.vue";
import DocumentTreeContextMenu from "./DocumentTreeContextMenu.vue";
import { closeAiSession, useStoriesQuery } from "../../../api/queries";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { showControlPlaneToast, showDelayedControlPlaneLoadingToast } from "../useControlPlaneToasts";
import { translateApiError } from "../../../i18n/apiError";
import { createBrowserUuid } from "../../../lib/random-id";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, Node, NodeLocalFolder } from "../../../api/types";
import type { Story, StoryAction, StorySessionPreset } from "@task-handoff/protocol/stories";
import AiSessionPanel from "../instance-detail/AiSessionPanel.vue";
import { launchableAppsForInstance, sessionStatusLabel, type RepositoryWorkspaceTabTarget, type SessionTab } from "../useInstanceSessions";

const props = withDefaults(defineProps<{ instances: InstanceWithAiSessions[]; nodes: Node[]; nodeLocalFoldersByNodeId?: Record<string, NodeLocalFolder[]>; filterNodeId?: string }>(), { nodeLocalFoldersByNodeId: () => ({}), filterNodeId: "" });
const { t } = useI18n();
const emit = defineEmits<{
  "launch-app": [instance: InstanceBoardItem, appId: string, cwdFolderId?: string, options?: Record<string, unknown>];
  "open-session": [instance: InstanceWithAiSessions, session: AiSessionSummary | undefined];
  "open-repository-workspace": [target: RepositoryWorkspaceTabTarget];
  "run-action": [story: Story, action: StoryAction];
}>();
type SessionEntry = { instance: InstanceWithAiSessions; session: AiSessionSummary };
type Resource = { kind: "story"; story: Story } | { kind: "new-session"; story: Story } | { kind: "document"; story: Story; document: Story["documents"][number] } | { kind: "session"; story: Story; entry: SessionEntry };
type ActionParameterDraft = { name: string; label: string; required: boolean; defaultValue: string };
const EXPANDED_STORY_KEYS_STORAGE_KEY = "task-handoff.control-plane.stories.expanded";
function storedExpandedStoryKeys() { try { const value = JSON.parse(window.localStorage?.getItem(EXPANDED_STORY_KEYS_STORAGE_KEY) || "[]"); return new Set<string>(Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []); } catch { return new Set<string>(); } }
function persistExpandedStoryKeys(keys: Set<string>) { try { window.localStorage?.setItem(EXPANDED_STORY_KEYS_STORAGE_KEY, JSON.stringify([...keys])); } catch { /* Local storage may be unavailable in restricted browser contexts. */ } }
const storiesQuery = useStoriesQuery();
const stories = computed(() => {
  const allStories = storiesQuery.data.value?.stories ?? [];
  const nodeId = props.filterNodeId?.trim();
  return nodeId ? allStories.filter((story) => story.ownerNodeId === nodeId) : allStories;
});
const storiesPending = computed(() => storiesQuery.isPending.value);
const storiesFetching = computed(() => storiesQuery.isFetching.value);
const selectedResource = ref<Resource>(); const expandedStoryKeys = ref(storedExpandedStoryKeys()); const error = ref("");
type TreeViewMode = "compact" | "detailed";
const TREE_VIEW_MODE_STORAGE_KEY = "task-handoff.control-plane.stories.tree-view-mode";
function storedTreeViewMode(): TreeViewMode {
  try {
    const value = window.localStorage?.getItem(TREE_VIEW_MODE_STORAGE_KEY);
    return value === "detailed" ? "detailed" : "compact";
  } catch { return "compact"; }
}
const treeViewMode = ref<TreeViewMode>(storedTreeViewMode());
function setTreeViewMode(mode: TreeViewMode) {
  treeViewMode.value = mode;
  try { window.localStorage?.setItem(TREE_VIEW_MODE_STORAGE_KEY, mode); } catch { /* Local storage may be unavailable in restricted browser contexts. */ }
}
const SIDEBAR_WIDTH_STORAGE_KEY = "task-handoff.control-plane.stories.sidebar-width";
function storedSidebarWidth() {
  try {
    const value = Number(window.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) ? Math.min(520, Math.max(240, value)) : 320;
  } catch { return 320; }
}
const sidebarWidth = ref(storedSidebarWidth()); const workspaceEl = ref<HTMLElement>(); const resizingSidebar = ref(false); let resizingPointerId: number | undefined;
const previewText = ref(""); const previewLoading = ref(false); const previewError = ref("");
const editorOpen = ref(false); const editing = ref(false); const draftTitle = ref(""); const draftDescription = ref(""); const draftNodeId = ref(""); const saving = ref(false);
const newSessionInstanceId = ref(""); const newSessionInitialCwd = ref(""); const newSessionInitialCwdFolderId = ref(""); const assignSessionOpen = ref(false); const assignSessionId = ref(""); const assigningSession = ref(false);
const actionEditorOpen = ref(false); const editingActionId = ref<string | null>(null); const actionSaving = ref(false); const actionDraftTitle = ref(""); const actionDraftPrompt = ref(""); const actionDraftTargetInstanceId = ref(""); const actionDraftParameters = ref<ActionParameterDraft[]>([]);
const actionDraftAgent = ref(""); const actionDraftMode = ref(""); const actionDraftPermissionMode = ref(""); const actionDraftReasoningEffort = ref(""); const actionDraftModelEntityId = ref(""); const actionDraftModelName = ref(""); const actionDraftCwdFolderId = ref(""); const actionDraftGitMode = ref(""); const actionDraftGitBranch = ref("");
const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const targetInstance = (instanceId: string) => props.instances.find((instance) => instance.id === instanceId);
const foldersForInstance = (instanceId: string) => {
  const nodeId = targetInstance(instanceId)?.nodeId;
  return nodeId ? props.nodeLocalFoldersByNodeId[nodeId] || [] : [];
};
const actionDraftCwdFolders = computed(() => foldersForInstance(actionDraftTargetInstanceId.value));
const sessionsFor = (story: Story) => props.instances.flatMap((instance) => (instance.aiSessions.sessions || []).filter((session) => session.storyId === story.id && instance.node?.id === story.ownerNodeId).map((session) => ({ instance, session })));
const unassignedSessionsFor = (story: Story) => props.instances.flatMap((instance) => (instance.aiSessions.sessions || []).filter((session) => !session.storyId && instance.node?.id === story.ownerNodeId).map((session) => ({ instance, session })));
type StoryTarget = { nodeId: string; instanceId: string; sessionId: string; storyId?: string | null };
const queryClient = useQueryClient();
const closingSessionKey = ref("");
function storyTargetFor(entry: SessionEntry): StoryTarget | undefined {
  const nodeId = entry.instance.nodeId;
  if (!nodeId) return undefined;
  return { nodeId, instanceId: entry.instance.id, sessionId: entry.session.id, storyId: entry.session.storyId ?? null };
}
function shortHash(value: string) { return value.length > 14 ? `${value.slice(0, 10)}...` : value; }
function storyOwnerNodeName(nodeId: string) { return props.nodes.find((node) => node.id === nodeId)?.name || nodeId; }
function actionTargetName(story: Story, action: StoryAction) { const id = action.targetInstanceId; const instance = id && instancesForStory(story).find((item) => item.id === id); return instance?.name || id || t("stories.defaultTarget"); }
function actionAgentLabel(agent: string) {
  return ["codex", "claude", "opencode"].includes(agent) ? t(`common.products.${agent}`) : agent;
}
function actionSessionPresetSummary(action: StoryAction) {
  const preset = action.sessionPreset;
  if (!preset) return "";
  const parts: string[] = [];
  if (preset.agent) parts.push(actionAgentLabel(preset.agent));
  if (preset.modelSelection?.modelName) parts.push(preset.modelSelection.modelName);
  if (preset.reasoningEffort) parts.push(t(`stories.actionEditor.reasoning.${preset.reasoningEffort}`));
  if (preset.mode) parts.push(t(`stories.actionEditor.${preset.mode === "auto" ? "auto" : preset.mode}`));
  if (preset.permissionMode) parts.push(t(`stories.actionEditor.${preset.permissionMode === "auto-review" ? "autoReview" : preset.permissionMode === "full-access" ? "fullAccess" : "ask"}`));
  if (preset.cwdFolderId) {
    const folder = foldersForInstance(action.targetInstanceId || "").find((item) => item.id === preset.cwdFolderId);
    parts.push(folder?.name || t("stories.folderFallback"));
  }
  if (preset.gitSelection) parts.push(t(preset.gitSelection.mode === "worktree" ? "stories.actionEditor.worktree" : "stories.actionEditor.currentFolder"));
  return parts.join(" · ");
}
async function refreshStorySessions() { await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }); }
async function closeSession(entry: SessionEntry) {
  if (closingSessionKey.value) return;
  closingSessionKey.value = entry.session.id;
  const loadingToast = showDelayedControlPlaneLoadingToast(t("sessions.actions.closingSession"));
  try {
    await closeAiSession(entry.instance.id, entry.session.id, createBrowserUuid());
    showControlPlaneToast(t("sessions.actions.closeSession"), "success");
    await refreshStorySessions();
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t, t("sessions.panel.closeSessionFailed")));
  } finally {
    loadingToast.dismiss();
    closingSessionKey.value = "";
  }
}
async function onStoryAssigned(_target: StoryTarget) {
  showControlPlaneToast(t("sessions.actions.storyAssigned"), "success");
  await refreshStorySessions();
}
function onStoryAssignFailed(_target: StoryTarget, error: unknown) {
  showControlPlaneToast(translateApiError(error, t, t("sessions.actions.storyAssignFailed")));
}
const latestSessionFor = (story: Story) => sessionsFor(story).reduce<SessionEntry | undefined>((latest, entry) => !latest || Date.parse(entry.session.updatedAt) > Date.parse(latest.session.updatedAt) ? entry : latest, undefined);
const instancesForStory = (story: Story) => props.instances.filter((instance) => instance.node?.id === story.ownerNodeId);
const documentResource = computed(() => selectedResource.value?.kind === "document" ? selectedResource.value : undefined);
const documentInstanceId = computed(() => { const resource = documentResource.value; return resource ? instancesForStory(resource.story)[0]?.id ?? "" : ""; });
const documentMarkdownSessionId = computed(() => { const resource = documentResource.value; return resource ? `${resource.story.ownerNodeId}:${resource.story.id}:${resource.document.storyPath}` : ""; });
const documentHtmlPolicy = computed<"escape" | "safe">(() => {
  const resource = documentResource.value;
  return resource && /\.html?$/i.test(resource.document.storyPath) ? "safe" : "escape";
});
const markdownCodeTools = computed(() => ({ copiedLabel: t("sessions.markdown.copied"), copyLabel: t("sessions.markdown.copy"), plainTextLabel: t("sessions.markdown.plainText") }));
function onOpenDocumentLink(href: string) {
  const resource = selectedResource.value;
  if (resource?.kind !== "document") return;
  const clean = href.split("#")[0]?.split("?")[0]?.replace(/^\.?\//, "").trim();
  if (!clean) return;
  const target = resource.story.documents.find((candidate) => candidate.storyPath === clean || candidate.storyPath.endsWith(`/${clean}`));
  if (target) selectDocument(resource.story, target.storyPath);
}
const storyInstances = computed(() => { const story = selectedResource.value?.story; return story ? instancesForStory(story) : []; });
const newSessionInstance = computed(() => storyInstances.value.find((instance) => instance.id === newSessionInstanceId.value));
const creationActiveSession = computed<SessionTab>(() => ({ key: "ai", label: t("navigation.ai"), status: "running", kind: "ai", aiSessions: newSessionInstance.value?.aiSessions.sessions || [] }));
const selectedSessionInstance = computed<InstanceWithAiSessions | undefined>(() => {
  const resource = selectedResource.value;
  if (resource?.kind !== "session") return undefined;
  return props.instances.find((instance) => instance.id === resource.entry.instance.id) || resource.entry.instance;
});
const storySessionTab = computed<SessionTab>(() => {
  return { key: "ai", label: t("navigation.ai"), status: "running", kind: "ai", aiSessions: selectedSessionInstance.value?.aiSessions.sessions || [] };
});
const noSelectedAiSession = () => undefined as AiSessionSummary | undefined;
const selectedStorySession = (_instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => {
  const resource = selectedResource.value;
  if (resource?.kind !== "session") return undefined;
  const entryId = resource.entry.session.id;
  return sessions?.find((session) => session.id === entryId) || resource.entry.session;
};
const availableSessions = computed(() => { const story = selectedResource.value?.story; return story ? unassignedSessionsFor(story) : []; });
const sessionCount = (story: Story) => sessionsFor(story).length;
const storyKey = (story: Story) => `${story.ownerNodeId}:${story.id}`;
const isSelectedStory = (story: Story) => selectedResource.value?.story.id === story.id && selectedResource.value?.story.ownerNodeId === story.ownerNodeId;
const isStoryOpen = (story: Story) => expandedStoryKeys.value.has(storyKey(story));
const isStorySelected = (story: Story) => (selectedResource.value?.kind === "story" || selectedResource.value?.kind === "new-session") && isSelectedStory(story);
const isDocumentSelected = (story: Story, path: string) => selectedResource.value?.kind === "document" && isSelectedStory(story) && selectedResource.value.document.storyPath === path;
const isSessionSelected = (story: Story, id: string) => selectedResource.value?.kind === "session" && isSelectedStory(story) && selectedResource.value.entry.session.id === id;
function setStoryExpanded(story: Story, expanded: boolean) { const next = new Set(expandedStoryKeys.value); const key = storyKey(story); if (expanded) next.add(key); else next.delete(key); expandedStoryKeys.value = next; persistExpandedStoryKeys(next); }
function toggleStoryExpanded(story: Story) { setStoryExpanded(story, !isStoryOpen(story)); }
function selectStory(story: Story) { setStoryExpanded(story, true); selectedResource.value = { kind: "story", story }; }
function selectDocument(story: Story, path: string) { const document = story.documents.find((item) => item.storyPath === path); if (document) { setStoryExpanded(story, true); selectedResource.value = { kind: "document", story, document }; } }
function selectSession(story: Story, entry: SessionEntry) { setStoryExpanded(story, true); selectedResource.value = { kind: "session", story, entry }; }
function handleSelectAiSession(instanceId: string, sessionId: string) {
  const resource = selectedResource.value;
  if (resource?.kind !== "session") return;
  const instance = props.instances.find((candidate) => candidate.id === instanceId);
  const session = instance?.aiSessions.sessions.find((candidate) => candidate.id === sessionId);
  if (instance && session) selectedResource.value = { kind: "session", story: resource.story, entry: { instance, session } };
}
function openStoryAiSessionApp(instance: InstanceBoardItem, session?: AiSessionSummary) {
  emit("open-session", instance as InstanceWithAiSessions, session);
}
function startSidebarResize(event: PointerEvent) { if (window.matchMedia("(max-width: 800px)").matches || !workspaceEl.value) return; resizingSidebar.value = true; resizingPointerId = event.pointerId; (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId); window.addEventListener("pointermove", resizeSidebar); window.addEventListener("pointerup", stopSidebarResize); window.addEventListener("pointercancel", stopSidebarResize); }
function resizeSidebar(event: PointerEvent) { if (!resizingSidebar.value || event.pointerId !== resizingPointerId || !workspaceEl.value) return; sidebarWidth.value = Math.min(520, Math.max(240, event.clientX - workspaceEl.value.getBoundingClientRect().left)); }
function stopSidebarResize(event?: PointerEvent) { if (event && resizingPointerId !== undefined && event.pointerId !== resizingPointerId) return; resizingSidebar.value = false; resizingPointerId = undefined; window.removeEventListener("pointermove", resizeSidebar); window.removeEventListener("pointerup", stopSidebarResize); window.removeEventListener("pointercancel", stopSidebarResize); }
watch(sidebarWidth, (width) => { try { window.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width)); } catch { /* Local storage may be unavailable in restricted browser contexts. */ } });
async function load() {
  error.value = "";
  try {
    const result = await storiesQuery.refetch();
    if (result.error) error.value = result.error instanceof Error ? result.error.message : String(result.error);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
watch(selectedResource, async (resource) => { previewText.value = ""; previewError.value = ""; if (resource?.kind === "document") { previewLoading.value = true; try { const response = await fetch(`/api/stories/${encodeURIComponent(resource.story.id)}/content/file?nodeId=${encodeURIComponent(resource.story.ownerNodeId)}&storyPath=${encodeURIComponent(resource.document.storyPath)}`); if (!response.ok) throw new Error((await response.json()).error?.message || "Could not read document."); previewText.value = await response.text(); } catch (cause) { previewError.value = cause instanceof Error ? cause.message : String(cause); } finally { previewLoading.value = false; } } }, { immediate: true });
watch(stories, (value) => {
  const resource = selectedResource.value;
  if (!resource) {
    if (value[0]) selectStory(value[0]);
    return;
  }
  const present = value.some((story) => story.id === resource.story.id && story.ownerNodeId === resource.story.ownerNodeId);
  if (!present) selectedResource.value = value[0] ? { kind: "story", story: value[0] } : undefined;
}, { immediate: true });
function openCreate() {
  editing.value = false;
  draftTitle.value = "";
  draftDescription.value = "";
  const filterNodeId = props.filterNodeId?.trim();
  draftNodeId.value = filterNodeId && props.nodes.some((node) => node.id === filterNodeId && node.status === "online")
    ? filterNodeId
    : props.nodes.find((node) => node.status === "online")?.id || "";
  editorOpen.value = true;
}
function openEdit() { const story = selectedResource.value?.story; if (!story) return; editing.value = true; draftTitle.value = story.title; draftDescription.value = story.description || ""; draftNodeId.value = story.ownerNodeId; editorOpen.value = true; }
function openNewSession(story: Story) { if (!story) return; const latest = latestSessionFor(story); setStoryExpanded(story, true); newSessionInstanceId.value = latest?.instance.id || instancesForStory(story)[0]?.id || ""; newSessionInitialCwd.value = latest?.session.cwd || ""; newSessionInitialCwdFolderId.value = latest?.session.cwdFolderId || ""; selectedResource.value = { kind: "new-session", story }; }
function selectCreationInstance(instanceId: string) { newSessionInstanceId.value = instanceId; newSessionInitialCwd.value = ""; newSessionInitialCwdFolderId.value = ""; }
function openAssignSession() { assignSessionId.value = availableSessions.value[0] ? `${availableSessions.value[0].instance.id}:${availableSessions.value[0].session.id}` : ""; assignSessionOpen.value = true; }
function openAssignSessionFor(story: Story) { if (!story || story.archivedAt) return; selectStory(story); openAssignSession(); }
function editStoryFromTree(story: Story) { if (!story) return; selectStory(story); openEdit(); }
function resetActionPreset() { actionDraftAgent.value = ""; actionDraftMode.value = ""; actionDraftPermissionMode.value = ""; actionDraftReasoningEffort.value = ""; actionDraftModelEntityId.value = ""; actionDraftModelName.value = ""; actionDraftCwdFolderId.value = ""; actionDraftGitMode.value = ""; actionDraftGitBranch.value = ""; }
function openCreateAction() { const story = selectedResource.value?.story; if (!story || story.archivedAt) return; editingActionId.value = null; actionDraftTitle.value = ""; actionDraftPrompt.value = ""; actionDraftTargetInstanceId.value = ""; actionDraftParameters.value = []; resetActionPreset(); actionEditorOpen.value = true; }
function openEditAction(action: StoryAction) { const story = selectedResource.value?.story; if (!story || story.archivedAt) return; editingActionId.value = action.id; actionDraftTitle.value = action.title; actionDraftPrompt.value = action.promptTemplate; actionDraftTargetInstanceId.value = action.targetInstanceId || ""; actionDraftParameters.value = action.parameters.map((parameter) => ({ name: parameter.name, label: parameter.label, required: parameter.required, defaultValue: parameter.defaultValue || "" })); const preset = action.sessionPreset; actionDraftAgent.value = preset?.agent || ""; actionDraftMode.value = preset?.mode || ""; actionDraftPermissionMode.value = preset?.permissionMode || ""; actionDraftReasoningEffort.value = preset?.reasoningEffort || ""; actionDraftModelEntityId.value = preset?.modelSelection?.modelEntityId || ""; actionDraftModelName.value = preset?.modelSelection?.modelName || ""; actionDraftCwdFolderId.value = preset?.cwdFolderId || ""; actionDraftGitMode.value = preset?.gitSelection?.mode || ""; actionDraftGitBranch.value = preset?.gitSelection?.branch || ""; actionEditorOpen.value = true; }
function addActionParameter() { actionDraftParameters.value.push({ name: "", label: "", required: false, defaultValue: "" }); }
function removeActionParameter(index: number) { actionDraftParameters.value.splice(index, 1); }
async function saveAction() {
  const story = selectedResource.value?.story;
  if (!story || story.archivedAt || actionSaving.value) return;
  const title = actionDraftTitle.value.trim();
  const promptTemplate = actionDraftPrompt.value.trim();
  if (!title || !promptTemplate) { error.value = t("stories.actionEditor.validationRequired"); return; }
  const parameters = actionDraftParameters.value
    .filter((parameter) => parameter.name.trim() || parameter.label.trim())
    .map((parameter) => ({ name: parameter.name.trim(), label: parameter.label.trim() || parameter.name.trim(), required: parameter.required, ...(parameter.defaultValue.trim() ? { defaultValue: parameter.defaultValue.trim() } : {}) }));
  if (parameters.some((parameter) => !parameter.name || !parameter.label)) { error.value = t("stories.actionEditor.validationParameter"); return; }
  const actions = [...story.actions];
  const targetInstanceId = actionDraftTargetInstanceId.value;
  if (!targetInstanceId) { error.value = t("stories.actionEditor.validationTarget"); return; }
  const hasPreset = Boolean(actionDraftAgent.value || actionDraftMode.value || actionDraftPermissionMode.value || actionDraftReasoningEffort.value || (actionDraftModelEntityId.value && actionDraftModelName.value) || actionDraftCwdFolderId.value || (actionDraftGitMode.value && actionDraftGitBranch.value));
  const sessionPreset = hasPreset ? {
    ...(actionDraftAgent.value ? { agent: actionDraftAgent.value } : {}),
    ...(actionDraftMode.value ? { mode: actionDraftMode.value } : {}),
    ...(actionDraftPermissionMode.value ? { permissionMode: actionDraftPermissionMode.value } : {}),
    ...(actionDraftReasoningEffort.value ? { reasoningEffort: actionDraftReasoningEffort.value } : {}),
    ...(actionDraftModelEntityId.value && actionDraftModelName.value ? { modelSelection: { modelEntityId: actionDraftModelEntityId.value, modelName: actionDraftModelName.value } } : {}),
    ...(actionDraftCwdFolderId.value ? { cwdFolderId: actionDraftCwdFolderId.value } : {}),
    ...(actionDraftGitMode.value && actionDraftGitBranch.value ? { gitSelection: { mode: actionDraftGitMode.value, branch: actionDraftGitBranch.value } } : {}),
  } as StorySessionPreset : undefined;
  if (editingActionId.value) {
    const index = actions.findIndex((action) => action.id === editingActionId.value);
    if (index < 0) { error.value = t("stories.actionEditor.notFound"); return; }
    actions[index] = { ...actions[index], title, promptTemplate, targetInstanceId, parameters, sessionPreset };
  } else {
    actions.push({ id: createBrowserUuid(), title, promptTemplate, targetInstanceId, parameters, sessionPreset });
  }
  actionSaving.value = true;
  try {
    const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId, input: { actions } }) });
    if (!response.ok) throw new Error((await response.json()).error?.message || t("stories.actionEditor.saveFailed"));
    actionEditorOpen.value = false; await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { actionSaving.value = false; }
}
async function finishStorySessionCreation() { const story = selectedResource.value?.story; await load(); const refreshed = story && stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); }
async function assignExistingSession() { const story = selectedResource.value?.story; const [instanceId, sessionId] = assignSessionId.value.split(":"); if (!story || !instanceId || !sessionId || assigningSession.value) return; assigningSession.value = true; try { const response = await fetch(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/story`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ storyId: story.id }) }); if (!response.ok) throw new Error(t("stories.errors.assignFailed")); assignSessionOpen.value = false; await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { assigningSession.value = false; } }
async function saveStory() { if (!draftTitle.value.trim() || !draftNodeId.value || saving.value) return; saving.value = true; try { const story = selectedResource.value?.story; const response = await fetch(editing.value && story ? `/api/stories/${encodeURIComponent(story.id)}` : "/api/stories", { method: editing.value ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(editing.value ? { nodeId: draftNodeId.value, input: { title: draftTitle.value.trim(), description: draftDescription.value.trim() || null } } : { nodeId: draftNodeId.value, input: { title: draftTitle.value.trim(), description: draftDescription.value.trim() || undefined } }) }); if (!response.ok) throw new Error((await response.json()).error?.message || t("stories.errors.saveFailed")); editorOpen.value = false; await load(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { saving.value = false; } }
async function toggleArchive(story: Story = selectedResource.value?.story) { if (!story) return; const action = story.archivedAt ? "restore" : "archive"; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId }) }); if (!response.ok) { error.value = t("stories.errors.updateFailed"); return; } await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); }
function downloadUrl(story: Story, storyPath: string) { return `/api/stories/${encodeURIComponent(story.id)}/content/file?nodeId=${encodeURIComponent(story.ownerNodeId)}&storyPath=${encodeURIComponent(storyPath)}`; }
function downloadDocument(story: Story, storyPath: string) { const anchor = document.createElement("a"); anchor.href = downloadUrl(story, storyPath); anchor.download = storyPath.split("/").pop() || storyPath; anchor.click(); }
async function deleteStory(story: Story) { if (!story) return; if (!window.confirm(t("stories.confirm.deleteStory", { title: story.title }))) return; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}?nodeId=${encodeURIComponent(story.ownerNodeId)}`, { method: "DELETE" }); if (!response.ok) { error.value = t("stories.errors.deleteFailed"); return; } await load(); const resource = selectedResource.value; if (resource && resource.story.id === story.id && resource.story.ownerNodeId === story.ownerNodeId) selectedResource.value = undefined; }
async function renameDocument(story: Story, storyPath: string, title: string) { const next = window.prompt(t("stories.confirm.documentTitle"), title)?.trim(); if (!next || next === title) return; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}/documents/${encodeURIComponent(storyPath)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId, input: { title: next } }) }); if (!response.ok) { error.value = t("stories.errors.renameDocumentFailed"); return; } await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectDocument(refreshed, storyPath); }
async function deleteDocument(story: Story, storyPath: string) { if (!window.confirm(t("stories.confirm.deleteDocument"))) return; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}/documents/${encodeURIComponent(storyPath)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId }) }); if (!response.ok) { error.value = t("stories.errors.deleteDocumentFailed"); return; } await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); }
onBeforeUnmount(stopSidebarResize);
</script>

<style scoped>
.story-view { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; padding:12px 0; color:var(--text); }
.story-content-header h2 { margin:0; color:var(--text-strong); font-size:18px; font-weight:500; }
.story-description,.story-content-header small { color:var(--text-muted); font-size:12px; }
.story-description { max-width:640px; margin:12px 0 0; line-height:1.5; }
.story-workspace { display:grid; grid-template-columns:minmax(240px,var(--story-sidebar-width,320px)) 2px minmax(0,1fr); gap:0; flex:1 1 auto; min-height:0; margin-top:0; overflow:hidden; }
.story-sidebar { display:grid; min-width:0; min-height:0; grid-template-rows:auto minmax(0,1fr); }
.story-sidebar-actions { padding:0 10px; }
.story-new-button { width:100%; padding-block:11px; }
.story-sidebar-section { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0 4px 8px; }
.story-sidebar-section-label { color:var(--text-muted); font-size:12px; font-weight:500; line-height:1; }
.story-view-mode-button { width:26px; height:26px; color:var(--text-muted); }
.story-view-mode-button:hover { color:var(--text-strong); }
.story-sidebar-scroll { min-width:0; min-height:0; }
.story-sidebar-scroll-inner { min-width:0; padding:0 10px 12px; }
.story-sidebar-scroll :deep([data-task-handoff-scroll-viewport] > div) { width:100%; min-width:0 !important; }
.story-loading-overlay { position:absolute; inset:0; z-index:5; display:grid; place-items:center; border-radius:8px; background:color-mix(in srgb,var(--surface) 72%,transparent); backdrop-filter:blur(1px); }
.story-loading-spin { color:var(--text-muted); animation:story-loading-spin 0.9s linear infinite; }
@keyframes story-loading-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .story-loading-spin { animation:none; } }
.story-sidebar-resize-handle { position:relative; z-index:20; align-self:stretch; width:2px; min-width:2px; height:100%; margin-inline-end:12px; border:0; background:transparent; cursor:col-resize; padding:0; touch-action:none; }
.story-sidebar-resize-handle::after { display:block; width:2px; height:100%; margin:0 auto; background:var(--line); content:""; opacity:.45; transition:background 120ms ease,opacity 120ms ease,box-shadow 120ms ease; }
.story-sidebar-resize-handle:hover::after,.story-sidebar-resize-handle:focus-visible::after,.story-workspace[data-resizing="true"] .story-sidebar-resize-handle::after { background:color-mix(in srgb,var(--line-strong) 72%,var(--brand-accent)); box-shadow:0 0 0 1px color-mix(in srgb,var(--line-strong) 42%,transparent); opacity:1; }
.story-sidebar-resize-handle:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-3px; }
.story-workspace[data-resizing="true"] { user-select:none; cursor:col-resize; }
.story-tree + .story-tree { margin-top:2px; }
.story-tree-children { display:grid; gap:2px; margin:2px 0 8px 16px; padding-left:8px; border-left:1px solid var(--line); }
.story-tree-story-row { position:relative; }
.story-tree-item { position:relative; display:flex; align-items:center; width:100%; min-width:0; gap:8px; border:0; border-radius:6px; background:transparent; color:inherit; cursor:pointer; padding:8px; text-align:left; }
.story-tree-story { padding-right:36px; padding-left:32px; padding-block:11px; }
.story-tree-item:hover { background:var(--sidebar-row-hover-bg,var(--surface-active)); }
.story-tree-item.active,.story-tree-item.active:hover { background:var(--sidebar-row-selected-bg,var(--surface-active)); }
.story-tree-disclosure-button { position:absolute; z-index:1; top:50%; left:4px; display:grid; width:24px; height:24px; place-items:center; border:0; border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; transform:translateY(-50%); }
.story-tree-disclosure-button:hover,.story-tree-disclosure-button:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
.story-tree-disclosure { flex:0 0 auto; transition:transform 120ms ease; }
.story-tree-disclosure.expanded { transform:rotate(90deg); }
.story-session-status,.story-session-icon { position:relative; display:grid; width:14px; height:14px; flex:0 0 auto; place-items:center; overflow:visible; }
.story-session-icon-status { position:absolute; top:-2px; right:-5px; }
.story-tree-item > span:not(.story-session-status):not(.story-session-icon):not(.story-session-unread) { display:flex; align-items:center; min-width:0; flex:1; overflow:hidden; }
.story-tree-item > span:not(.story-session-status):not(.story-session-icon):not(.story-session-unread) strong { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.3; }
.story-tree-item > span.story-tree-item-detail { display:grid; gap:2px; line-height:1.5; overflow:visible; }
.story-tree-item > span.story-tree-item-detail strong,
.story-tree-item > span.story-tree-item-detail small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.5; }
.story-tree-item strong { font-size:13px; font-weight:500; }
.story-tree-item:not(.story-tree-story):not(.story-new-button):not(.story-tree-item-detailed) > span:not(.story-session-status):not(.story-session-icon):not(.story-session-unread) strong { font-weight:400; }
.story-tree-item small,.story-tree-empty { color:var(--text-muted); font-size:12px; }
.story-tree-item:not(.story-tree-story):not(.story-new-button) { height:32px; padding-block:6px; }
.story-tree-item.story-tree-item-detailed:not(.story-tree-story):not(.story-new-button) { height:auto; padding-block:8px; }
.story-tree-item-hint { position:absolute; top:50%; right:8px; z-index:1; max-width:64%; overflow:hidden; padding-left:18px; color:var(--text-muted); font-size:12px; white-space:nowrap; text-overflow:ellipsis; pointer-events:none; opacity:0; transform:translateY(-50%); background:linear-gradient(90deg, transparent, var(--surface-active) 18px); transition:opacity 140ms ease; }
.story-tree-item:hover > .story-tree-item-hint { background:linear-gradient(90deg,transparent,var(--sidebar-row-hover-bg,var(--surface-active)) 18px); opacity:1; }
.story-tree-item.active > .story-tree-item-hint { background:linear-gradient(90deg,transparent,var(--sidebar-row-selected-bg,var(--surface-active)) 18px); }
.story-tree-item-unread > .story-tree-item-hint { right:24px; }
.story-session-unread { width:7px; height:7px; flex:0 0 auto; border-radius:999px; background:var(--status-info); box-shadow:0 0 0 3px color-mix(in srgb,var(--status-info) 18%,transparent); }
.story-tree-add { display:grid; grid:1fr/1fr; width:18px; height:18px; place-items:center; border:0; border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; }
.story-tree-story-add { position:absolute; top:50%; right:6px; width:24px; height:24px; transform:translateY(-50%); opacity:0; pointer-events:none; transition:opacity 120ms ease; }
.story-tree-story-row:hover .story-tree-story-add,.story-tree-story-add:focus-visible { opacity:1; pointer-events:auto; }
.story-tree-add:hover,.story-tree-add:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
.story-tree-add:disabled { cursor:default; }
.story-tree-story-add:disabled { opacity:0; pointer-events:none; }
.story-tree-story-row:hover .story-tree-story-add:disabled { opacity:.4; }
.story-tree-empty { padding:8px; }
.story-content { display:flex; min-width:0; min-height:0; flex-direction:column; overflow:hidden; padding:0 20px; }
.story-content.story-session-pane { padding:0; }
.story-content.story-session-pane > .story-session-creator { padding:0; background:transparent; }
.story-content-header { display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); padding:0 0 12px; flex:0 0 auto; }
.story-content-header > div:first-child:not(.story-content-title) { display:grid; min-width:0; gap:3px; }
.story-content-header .story-content-title { display:flex; align-items:baseline; gap:10px; min-width:0; }
.story-content-title h2 { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-content-title small { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.story-content-state { display:grid; flex:1; place-items:center; color:var(--text-muted); font-size:13px; padding:24px; }
.story-document-markdown { flex:1; min-height:0; color:var(--text); font-size:13px; line-height:1.6; }
.story-document-markdown :deep([data-task-handoff-scroll-viewport] > div) { width:100%; min-width:0 !important; }
.story-document-markdown-content { min-width:0; padding:16px 0 32px; }
.story-content-download { display:inline-flex; align-items:center; gap:6px; color:var(--text-muted); font-size:12px; text-decoration:none; }
.story-content-download:hover { color:var(--text-strong); }
.story-content-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.story-session-creator { flex:1; min-height:0; }
.story-overview-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:12px; margin:16px 0 20px; }
.story-overview-grid > div { display:grid; gap:4px; padding:14px 16px; background:var(--surface-raised); border:1px solid var(--line); border-radius:8px; }
.story-overview-grid strong { color:var(--text-strong); font-size:18px; font-weight:500; }
.story-overview-grid span { color:var(--text-muted); font-size:12px; }
.story-actions-section { margin:4px 0 0; }
.story-actions-section h3 { margin:0; color:var(--text-strong); font-size:13px; font-weight:500; }
.story-actions-header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.story-action-item { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; margin-top:8px; border:1px solid var(--line); border-radius:8px; background:var(--surface-raised); }
.story-action-item:hover { background:var(--surface-active); }
.story-action-run { display:flex; align-items:flex-start; gap:10px; min-width:0; border:0; background:transparent; color:inherit; cursor:pointer; padding:10px 0 10px 12px; text-align:left; }
.story-action-run:disabled { cursor:default; }
.story-action-icon { display:flex; flex:0 0 auto; align-items:center; justify-content:center; width:32px; height:32px; border:1px solid var(--line-subtle); border-radius:7px; background:var(--surface-active); color:var(--text-muted); }
.story-action-copy { display:grid; gap:3px; min-width:0; }
.story-action-copy strong { color:var(--text-strong); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-action-copy small, .story-action-meta { color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-action-meta { display:block; }
.story-action-edit { display:grid; flex:0 0 auto; place-items:center; width:32px; height:32px; margin-right:12px; border:1px solid var(--line); border-radius:7px; background:var(--surface-raised); color:var(--text-muted); cursor:pointer; padding:0; }
.story-action-edit:hover,.story-action-edit:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
.story-action-edit:disabled { cursor:default; opacity:.5; }
:global(.story-editor-dialog.story-action-editor-dialog) { max-width:640px; grid-template-rows:auto minmax(0,1fr) auto; overflow:hidden; }
:global(.story-action-editor-scroll) { min-height:0; }
.story-action-editor-fields { padding-right:8px; }
.story-action-preset { display:grid; gap:8px; border-top:1px solid var(--line); padding-top:12px; }
.story-action-preset-title { color:var(--text-muted); font-size:12px; }
.story-action-preset-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.story-action-parameters { display:grid; gap:8px; }
.story-action-parameters-header { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--text-muted); font-size:12px; }
.story-action-parameter { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)) auto auto; gap:8px; align-items:center; }
.story-action-parameter-required { display:flex; align-items:center; gap:6px; color:var(--text-muted); font-size:12px; }
.story-empty { color:var(--text-muted); font-size:12px; padding:16px; text-align:center; }
.story-error { color:var(--status-danger); font-size:12px; }
.story-editor-fields { display:grid; gap:14px; }
.story-editor-fields label { display:grid; gap:6px; color:var(--text-muted); font-size:12px; }
:global(.story-editor-dialog) { max-width:460px; }
@media (max-width:800px) { .story-view { padding:16px 0; } .story-workspace { grid-template-columns:minmax(220px,38%) minmax(0,1fr); } .story-sidebar-resize-handle { display:none; } .story-content-header { padding:0 0 14px; } }
@media (max-width:560px) { .story-view { padding:10px 0; } .story-workspace { grid-template-columns:1fr; } .story-sidebar { max-height:38%; border-right:0; border-bottom:1px solid var(--line); } .story-overview-grid { margin:14px 0; } .story-actions-section { margin:0; } }
</style>
