<template>
  <section class="story-view">
    <div v-if="error" class="story-error" role="alert">{{ error }}</div>

    <div ref="workspaceEl" class="story-workspace" :data-resizing="resizingSidebar ? 'true' : undefined" :style="{ '--story-sidebar-width': `${sidebarWidth}px` }">
      <aside class="story-sidebar" aria-label="Stories">
        <Button class="story-new-button" size="sm" @click="openCreate"><Plus :size="15" /> New story</Button>
        <div v-if="loading" class="story-empty">Loading stories...</div>
        <div v-else-if="!stories.length" class="story-empty">No stories yet.</div>
        <div v-for="story in stories" :key="`${story.ownerNodeId}:${story.id}`" class="story-tree">
          <div class="story-tree-story-row">
            <button type="button" class="story-tree-disclosure-button" :aria-label="isStoryOpen(story) ? 'Collapse Story' : 'Expand Story'" :aria-expanded="isStoryOpen(story)" @click.stop="toggleStoryExpanded(story)">
              <ChevronRight :size="15" class="story-tree-disclosure" :class="{ expanded: isStoryOpen(story) }" />
            </button>
            <button type="button" class="story-tree-item story-tree-story" :class="{ active: isStorySelected(story) }" @click="selectStory(story)">
              <BookOpen :size="15" />
              <span><strong>{{ story.title }}</strong></span>
            </button>
            <button type="button" class="story-tree-add story-tree-story-add" aria-label="New AI session" title="New AI session" :disabled="Boolean(story.archivedAt) || !instancesForStory(story).length" @click.stop="openNewSession(story)"><MessageSquarePlus :size="14" /></button>
          </div>
          <div v-if="isStoryOpen(story)" class="story-tree-children">
            <button v-for="document in story.documents" :key="document.storyPath" type="button" class="story-tree-item" :class="{ active: isDocumentSelected(story, document.storyPath) }" @click="selectDocument(story, document.storyPath)">
              <FileText :size="14" /><span><strong>{{ document.title }}</strong><small>{{ document.storyPath }}</small></span>
            </button>
            <ContextMenu v-for="entry in sessionsFor(story)" :key="entry.session.id">
              <ContextMenuTrigger as-child>
                <button type="button" class="story-tree-item" :class="{ active: isSessionSelected(story, entry.session.id) }" @click="selectSession(story, entry)">
                  <span v-if="entry.session.status === 'running'" class="story-session-status"><AiSessionStatusIndicator :status="entry.session.status" /></span>
                  <MessageSquare v-else :size="14" /><span><strong>{{ entry.session.title || entry.session.userPrompt || entry.session.id }}</strong><small>{{ entry.instance.name }} · {{ entry.session.status }}</small></span>
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
            <div v-if="!sessionsFor(story).length" class="story-tree-empty">No linked sessions.</div>
          </div>
        </div>
      </aside>
      <button type="button" class="story-sidebar-resize-handle" aria-label="Resize Story list" title="Resize Story list" @pointerdown.stop.prevent="startSidebarResize" @click.stop @dragstart.prevent />

      <main class="story-content" :class="{ 'story-session-pane': (selectedResource?.kind === 'session' || selectedResource?.kind === 'new-session') }">
        <template v-if="selectedResource?.kind === 'new-session'">
          <AiSessionPanel v-if="newSessionInstance" class="story-session-creator" :active-session="creationActiveSession" creation-only :creation-story-id="selectedResource.story.id" :creation-initial-cwd="newSessionInitialCwd" :creation-initial-cwd-folder-id="newSessionInitialCwdFolderId" :creation-instances="storyInstances" :instance="newSessionInstance" :launchable-apps="launchableAppsForInstance(newSessionInstance, t)" :node-local-folders="nodeLocalFoldersByNodeId[newSessionInstance.nodeId] || []" :selected-ai-session="noSelectedAiSession" @update:creation-instance="selectCreationInstance" @session-created="finishStorySessionCreation" />
          <div v-else class="story-content-state">No available instance on this Story's node.</div>
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
            <div class="story-content-actions"><a class="story-content-download" :href="downloadUrl(selectedResource.story, selectedResource.document.storyPath)" :download="selectedResource.document.storyPath.split('/').pop()"><Download :size="14" /> Download</a><Button variant="outline" size="sm" @click="renameDocument(selectedResource.story, selectedResource.document.storyPath, selectedResource.document.title)">Rename</Button><Button variant="outline" size="sm" @click="deleteDocument(selectedResource.story, selectedResource.document.storyPath)">Delete</Button></div>
          </header>
          <div v-if="previewLoading" class="story-content-state">Loading document...</div>
          <div v-else-if="previewError" class="story-content-state story-error">{{ previewError }}</div>
          <div v-else class="story-document-markdown">
            <AiSessionStreamingMarkdown
              class="story-document-markdown-content"
              :instance-id="documentInstanceId"
              :session-id="documentMarkdownSessionId"
              :code-tools="markdownCodeTools"
              :content="previewText"
              :file-links="true"
              @open-file="onOpenDocumentLink"
            />
          </div>
        </template>
        <template v-else-if="selectedResource?.kind === 'story'">
          <header class="story-content-header">
            <div class="story-content-title"><h2>{{ selectedResource.story.title }}</h2><small>{{ storyOwnerNodeName(selectedResource.story.ownerNodeId) }}</small></div>
            <div class="story-content-actions"><Button variant="outline" size="sm" @click="openEdit"><Pencil :size="14" /> Edit</Button><DropdownMenu><DropdownMenuTrigger as-child><Button variant="outline" size="icon" aria-label="More Story actions" title="More Story actions"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt)" @select="openNewSession(selectedResource.story)">New session</DropdownMenuItem><DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt) || !availableSessions.length" @select="openAssignSession">Add existing</DropdownMenuItem><DropdownMenuItem @select="toggleArchive">{{ selectedResource.story.archivedAt ? 'Restore' : 'Archive' }}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
          </header>
          <p v-if="selectedResource.story.description" class="story-description">{{ selectedResource.story.description }}</p>
          <div class="story-overview-grid"><div><strong>{{ selectedResource.story.documents.length }}</strong><span>Documents</span></div><div><strong>{{ sessionCount(selectedResource.story) }}</strong><span>AI Sessions</span></div><div><strong>{{ selectedResource.story.actions.length }}</strong><span>Preset actions</span></div></div>
          <section class="story-actions-section"><h3>Preset actions</h3><div v-if="!selectedResource.story.actions.length" class="story-empty">No preset actions.</div><button v-for="action in selectedResource.story.actions" :key="action.id" type="button" class="story-action" :disabled="Boolean(selectedResource.story.archivedAt)" @click="$emit('run-action', selectedResource.story, action)"><Play :size="14" /><span>{{ action.title }}</span></button></section>
        </template>
        <div v-else class="story-content-state">Select a Story, document, or AI Session.</div>
      </main>
    </div>
  </section>

  <Dialog v-model:open="editorOpen">
    <DialogContent class="story-editor-dialog"><DialogHeader><DialogTitle>{{ editing ? 'Edit story' : 'New story' }}</DialogTitle><DialogDescription>Choose the node that owns this Story and its files.</DialogDescription></DialogHeader><div class="story-editor-fields"><label>Title<Input v-model="draftTitle" placeholder="Story title" /></label><label>Description<Textarea v-model="draftDescription" placeholder="Optional description" /></label><label>Owner node<ControlPlaneSelect v-model="draftNodeId" :disabled="editing"><ControlPlaneSelectItem v-for="node in nodes.filter((candidate) => candidate.status === 'online')" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label></div><DialogFooter><Button variant="outline" @click="editorOpen = false">Cancel</Button><Button :disabled="!draftTitle.trim() || !draftNodeId || saving" @click="saveStory">{{ saving ? 'Saving...' : 'Save' }}</Button></DialogFooter></DialogContent>
  </Dialog>
  <Dialog v-model:open="assignSessionOpen"><DialogContent class="story-editor-dialog"><DialogHeader><DialogTitle>Add existing session</DialogTitle><DialogDescription>Only unassigned sessions on this Story's node are available.</DialogDescription></DialogHeader><div class="story-editor-fields"><label>AI session<ControlPlaneSelect v-model="assignSessionId"><ControlPlaneSelectItem v-for="entry in availableSessions" :key="`${entry.instance.id}:${entry.session.id}`" :value="`${entry.instance.id}:${entry.session.id}`">{{ entry.session.title || entry.session.userPrompt || entry.session.id }} · {{ entry.instance.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label></div><DialogFooter><Button variant="outline" @click="assignSessionOpen = false">Cancel</Button><Button :disabled="!assignSessionId || assigningSession" @click="assignExistingSession">{{ assigningSession ? 'Adding...' : 'Add session' }}</Button></DialogFooter></DialogContent></Dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { BookOpen, ChevronRight, Download, FileText, MessageSquare, MessageSquarePlus, MoreHorizontal, Pencil, Play, Plus } from "@lucide/vue";
import AiSessionStatusIndicator from "../../../components/ai-session/AiSessionStatusIndicator.vue";
import AiSessionStreamingMarkdown from "../../../components/ai-session/AiSessionStreamingMarkdown.vue";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import Input from "../../../components/ui/input/Input.vue";
import Textarea from "../../../components/ui/textarea/Textarea.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { ContextMenu, ContextMenuTrigger } from "../../../components/ui/context-menu";
import AiSessionCardContextMenu from "../../../components/ai-session/AiSessionCardContextMenu.vue";
import { closeAiSession, useStoriesQuery } from "../../../api/queries";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { showControlPlaneToast, showDelayedControlPlaneLoadingToast } from "../useControlPlaneToasts";
import { translateApiError } from "../../../i18n/apiError";
import { createBrowserUuid } from "../../../lib/random-id";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, Node, NodeLocalFolder } from "../../../api/types";
import type { Story, StoryAction } from "@task-handoff/protocol/stories";
import AiSessionPanel from "../instance-detail/AiSessionPanel.vue";
import { launchableAppsForInstance, type RepositoryWorkspaceTabTarget, type SessionTab } from "../useInstanceSessions";

const props = withDefaults(defineProps<{ instances: InstanceWithAiSessions[]; nodes: Node[]; nodeLocalFoldersByNodeId?: Record<string, NodeLocalFolder[]> }>(), { nodeLocalFoldersByNodeId: () => ({}) });
const { t } = useI18n();
const emit = defineEmits<{
  "launch-app": [instance: InstanceBoardItem, appId: string, cwdFolderId?: string, options?: Record<string, unknown>];
  "open-session": [instance: InstanceWithAiSessions, session: AiSessionSummary | undefined];
  "open-repository-workspace": [target: RepositoryWorkspaceTabTarget];
  "run-action": [story: Story, action: StoryAction];
}>();
type SessionEntry = { instance: InstanceWithAiSessions; session: any };
type Resource = { kind: "story"; story: Story } | { kind: "new-session"; story: Story } | { kind: "document"; story: Story; document: Story["documents"][number] } | { kind: "session"; story: Story; entry: SessionEntry };
const EXPANDED_STORY_KEYS_STORAGE_KEY = "task-handoff.control-plane.stories.expanded";
function storedExpandedStoryKeys() { try { const value = JSON.parse(window.localStorage?.getItem(EXPANDED_STORY_KEYS_STORAGE_KEY) || "[]"); return new Set<string>(Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []); } catch { return new Set<string>(); } }
function persistExpandedStoryKeys(keys: Set<string>) { try { window.localStorage?.setItem(EXPANDED_STORY_KEYS_STORAGE_KEY, JSON.stringify([...keys])); } catch { /* Local storage may be unavailable in restricted browser contexts. */ } }
const storiesQuery = useStoriesQuery();
const stories = computed(() => storiesQuery.data.value?.stories ?? []);
const selectedResource = ref<Resource>(); const expandedStoryKeys = ref(storedExpandedStoryKeys()); const loading = ref(false); const error = ref("");
const sidebarWidth = ref(320); const workspaceEl = ref<HTMLElement>(); const resizingSidebar = ref(false); let resizingPointerId: number | undefined;
const previewText = ref(""); const previewLoading = ref(false); const previewError = ref("");
const editorOpen = ref(false); const editing = ref(false); const draftTitle = ref(""); const draftDescription = ref(""); const draftNodeId = ref(""); const saving = ref(false);
const newSessionInstanceId = ref(""); const newSessionInitialCwd = ref(""); const newSessionInitialCwdFolderId = ref(""); const assignSessionOpen = ref(false); const assignSessionId = ref(""); const assigningSession = ref(false);
const sessionsFor = (story: Story) => props.instances.flatMap((instance) => (instance.aiSessions.sessions || []).filter((session) => session.storyId === story.id && instance.node?.id === story.ownerNodeId).map((session) => ({ instance, session })));
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
const creationActiveSession = computed<SessionTab>(() => ({ key: "ai", label: "AI", status: "running", kind: "ai", aiSessions: newSessionInstance.value?.aiSessions.sessions || [] }));
const selectedSessionInstance = computed<InstanceWithAiSessions | undefined>(() => {
  const resource = selectedResource.value;
  if (resource?.kind !== "session") return undefined;
  return props.instances.find((instance) => instance.id === resource.entry.instance.id) || resource.entry.instance;
});
const storySessionTab = computed<SessionTab>(() => {
  return { key: "ai", label: "AI", status: "running", kind: "ai", aiSessions: selectedSessionInstance.value?.aiSessions.sessions || [] };
});
const noSelectedAiSession = () => undefined as AiSessionSummary | undefined;
const selectedStorySession = (_instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => {
  const resource = selectedResource.value;
  if (resource?.kind !== "session") return undefined;
  const entryId = resource.entry.session.id;
  return sessions?.find((session) => session.id === entryId) || resource.entry.session;
};
const availableSessions = computed(() => { const story = selectedResource.value?.story; return story ? props.instances.flatMap((instance) => (instance.aiSessions.sessions || []).filter((session) => !session.storyId && instance.node?.id === story.ownerNodeId).map((session) => ({ instance, session }))) : []; });
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
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const result = await storiesQuery.refetch();
    if (result.error) error.value = result.error instanceof Error ? result.error.message : String(result.error);
    if (!selectedResource.value && stories.value[0]) selectStory(stories.value[0]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}
watch(selectedResource, async (resource) => { previewText.value = ""; previewError.value = ""; if (resource?.kind === "document") { previewLoading.value = true; try { const response = await fetch(`/api/stories/${encodeURIComponent(resource.story.id)}/content/file?nodeId=${encodeURIComponent(resource.story.ownerNodeId)}&storyPath=${encodeURIComponent(resource.document.storyPath)}`); if (!response.ok) throw new Error((await response.json()).error?.message || "Could not read document."); previewText.value = await response.text(); } catch (cause) { previewError.value = cause instanceof Error ? cause.message : String(cause); } finally { previewLoading.value = false; } } }, { immediate: true });
function openCreate() { editing.value = false; draftTitle.value = ""; draftDescription.value = ""; draftNodeId.value = props.nodes.find((node) => node.status === "online")?.id || ""; editorOpen.value = true; }
function openEdit() { const story = selectedResource.value?.story; if (!story) return; editing.value = true; draftTitle.value = story.title; draftDescription.value = story.description || ""; draftNodeId.value = story.ownerNodeId; editorOpen.value = true; }
function openNewSession(story: Story) { if (!story) return; const latest = latestSessionFor(story); setStoryExpanded(story, true); newSessionInstanceId.value = latest?.instance.id || instancesForStory(story)[0]?.id || ""; newSessionInitialCwd.value = latest?.session.cwd || ""; newSessionInitialCwdFolderId.value = latest?.session.cwdFolderId || ""; selectedResource.value = { kind: "new-session", story }; }
function selectCreationInstance(instanceId: string) { newSessionInstanceId.value = instanceId; newSessionInitialCwd.value = ""; newSessionInitialCwdFolderId.value = ""; }
function openAssignSession() { assignSessionId.value = availableSessions.value[0] ? `${availableSessions.value[0].instance.id}:${availableSessions.value[0].session.id}` : ""; assignSessionOpen.value = true; }
async function finishStorySessionCreation() { const story = selectedResource.value?.story; await load(); const refreshed = story && stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); }
async function assignExistingSession() { const story = selectedResource.value?.story; const [instanceId, sessionId] = assignSessionId.value.split(":"); if (!story || !instanceId || !sessionId || assigningSession.value) return; assigningSession.value = true; try { const response = await fetch(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/story`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ storyId: story.id }) }); if (!response.ok) throw new Error("Could not add session to Story."); assignSessionOpen.value = false; await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { assigningSession.value = false; } }
async function saveStory() { if (!draftTitle.value.trim() || !draftNodeId.value || saving.value) return; saving.value = true; try { const story = selectedResource.value?.story; const response = await fetch(editing.value && story ? `/api/stories/${encodeURIComponent(story.id)}` : "/api/stories", { method: editing.value ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(editing.value ? { nodeId: draftNodeId.value, input: { title: draftTitle.value.trim(), description: draftDescription.value.trim() || null } } : { nodeId: draftNodeId.value, input: { title: draftTitle.value.trim(), description: draftDescription.value.trim() || undefined } }) }); if (!response.ok) throw new Error((await response.json()).error?.message || "Could not save story."); editorOpen.value = false; await load(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { saving.value = false; } }
async function toggleArchive() { const story = selectedResource.value?.story; if (!story) return; const action = story.archivedAt ? "restore" : "archive"; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId }) }); if (!response.ok) { error.value = "Story update failed."; return; } await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); }
function downloadUrl(story: Story, storyPath: string) { return `/api/stories/${encodeURIComponent(story.id)}/content/file?nodeId=${encodeURIComponent(story.ownerNodeId)}&storyPath=${encodeURIComponent(storyPath)}`; }
async function renameDocument(story: Story, storyPath: string, title: string) { const next = window.prompt("Document title", title)?.trim(); if (!next || next === title) return; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}/documents/${encodeURIComponent(storyPath)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId, input: { title: next } }) }); if (!response.ok) { error.value = "Document rename failed."; return; } await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectDocument(refreshed, storyPath); }
async function deleteDocument(story: Story, storyPath: string) { if (!window.confirm("Delete this Story document?")) return; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}/documents/${encodeURIComponent(storyPath)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId }) }); if (!response.ok) { error.value = "Document delete failed."; return; } await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); }
onMounted(load);
onBeforeUnmount(stopSidebarResize);
</script>

<style scoped>
.story-view { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; padding:12px 0; color:var(--text); }
.story-content-header h2 { margin:0; color:var(--text-strong); font-size:18px; font-weight:500; }
.story-description,.story-content-header small { color:var(--text-muted); font-size:12px; }
.story-description { max-width:640px; margin:12px 0 0; line-height:1.5; }
.story-workspace { display:grid; grid-template-columns:minmax(240px,var(--story-sidebar-width,320px)) 2px minmax(0,1fr); gap:0; flex:1 1 auto; min-height:0; margin-top:0; overflow:hidden; }
.story-sidebar { min-width:0; overflow:auto; padding:0 12px; }
.story-new-button { width:100%; justify-content:center; margin-bottom:8px; }
.story-sidebar-resize-handle { position:relative; z-index:20; align-self:stretch; width:2px; min-width:2px; height:100%; margin-inline-end:12px; border:0; background:transparent; cursor:col-resize; padding:0; touch-action:none; }
.story-sidebar-resize-handle::after { display:block; width:2px; height:100%; margin:0 auto; background:var(--line); content:""; opacity:.45; transition:background 120ms ease,opacity 120ms ease,box-shadow 120ms ease; }
.story-sidebar-resize-handle:hover::after,.story-sidebar-resize-handle:focus-visible::after,.story-workspace[data-resizing="true"] .story-sidebar-resize-handle::after { background:color-mix(in srgb,var(--line-strong) 72%,var(--brand-accent)); box-shadow:0 0 0 1px color-mix(in srgb,var(--line-strong) 42%,transparent); opacity:1; }
.story-sidebar-resize-handle:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-3px; }
.story-workspace[data-resizing="true"] { user-select:none; cursor:col-resize; }
.story-tree + .story-tree { margin-top:2px; }
.story-tree-children { display:grid; gap:2px; margin:2px 0 10px 16px; padding-left:10px; border-left:1px solid var(--line); }
.story-tree-story-row { position:relative; }
.story-tree-item { display:flex; align-items:center; width:100%; min-width:0; gap:8px; border:0; border-radius:6px; background:transparent; color:inherit; cursor:pointer; padding:8px; text-align:left; }
.story-tree-story { padding-right:36px; padding-left:34px; }
.story-tree-item:hover,.story-tree-item.active { background:var(--surface-active); }
.story-tree-disclosure-button { position:absolute; z-index:1; top:50%; left:8px; display:grid; width:24px; height:24px; place-items:center; border:0; border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; transform:translateY(-50%); }
.story-tree-disclosure-button:hover,.story-tree-disclosure-button:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
.story-tree-disclosure { flex:0 0 auto; transition:transform 120ms ease; }
.story-tree-disclosure.expanded { transform:rotate(90deg); }
.story-session-status { display:grid; width:14px; height:14px; flex:0 0 auto; place-items:center; }
.story-tree-item > span:not(.story-session-status) { display:grid; min-width:0; flex:1; gap:2px; }
.story-tree-item strong,.story-tree-item small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-tree-item strong { font-size:13px; font-weight:500; }
.story-tree-item small,.story-tree-empty { color:var(--text-muted); font-size:12px; }
.story-tree-add { display:grid; grid:1fr/1fr; width:18px; height:18px; place-items:center; border:0; border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; }
.story-tree-story-add { position:absolute; top:50%; right:6px; width:24px; height:24px; transform:translateY(-50%); }
.story-tree-add:hover,.story-tree-add:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
.story-tree-add:disabled { cursor:default; opacity:.4; }
.story-tree-empty { padding:8px; }
.story-content { display:flex; min-width:0; min-height:0; flex-direction:column; overflow:hidden; padding:0 20px; }
.story-content.story-session-pane { padding:0; }
.story-content.story-session-pane > .story-session-creator { padding:0; background:transparent; }
.story-content-header { display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); padding:12px 0; flex:0 0 auto; }
.story-content-header > div:first-child:not(.story-content-title) { display:grid; min-width:0; gap:3px; }
.story-content-header .story-content-title { display:flex; align-items:baseline; gap:10px; min-width:0; }
.story-content-title h2 { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-content-title small { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.story-content-state { display:grid; flex:1; place-items:center; color:var(--text-muted); font-size:13px; padding:24px; }
.story-document-markdown { flex:1; min-height:0; overflow:auto; margin:20px 0; padding:20px 24px; background:var(--workspace-bg); border:1px solid var(--line); border-radius:8px; color:var(--text); font-size:13px; line-height:1.6; }
.story-document-markdown-content { min-width:0; }
.story-content-download { display:inline-flex; align-items:center; gap:6px; color:var(--text-muted); font-size:12px; text-decoration:none; }
.story-content-download:hover { color:var(--text-strong); }
.story-content-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.story-session-creator { flex:1; min-height:0; }
.story-overview-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:12px; margin:16px 0 20px; }
.story-overview-grid > div { display:grid; gap:4px; padding:14px 16px; background:var(--surface-raised); border:1px solid var(--line); border-radius:8px; }
.story-overview-grid strong { color:var(--text-strong); font-size:18px; font-weight:500; }
.story-overview-grid span { color:var(--text-muted); font-size:12px; }
.story-actions-section { margin:4px 0 0; }
.story-actions-section h3 { margin:0; color:var(--text-strong); font-size:14px; font-weight:500; }
.story-action { display:flex; align-items:center; gap:8px; width:100%; margin-top:8px; border:1px solid var(--line); border-radius:8px; background:var(--surface-raised); color:inherit; cursor:pointer; padding:10px 12px; text-align:left; }
.story-action:hover { background:var(--surface-active); }
.story-empty { color:var(--text-muted); font-size:12px; padding:16px; text-align:center; }
.story-error { color:var(--status-danger); font-size:12px; }
.story-editor-fields { display:grid; gap:14px; }
.story-editor-fields label { display:grid; gap:6px; color:var(--text-muted); font-size:12px; }
.story-editor-dialog { max-width:460px; }
@media (max-width:800px) { .story-view { padding:16px 0; } .story-workspace { grid-template-columns:minmax(220px,38%) minmax(0,1fr); } .story-sidebar-resize-handle { display:none; } .story-content-header { padding:14px 0; } }
@media (max-width:560px) { .story-view { padding:10px 0; } .story-workspace { grid-template-columns:1fr; } .story-sidebar { max-height:38%; border-right:0; border-bottom:1px solid var(--line); } .story-overview-grid { margin:14px 0; } .story-actions-section { margin:0; } }
</style>
