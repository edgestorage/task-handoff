<template>
  <section class="story-view">
    <div v-if="error" class="story-error" role="alert">{{ error }}</div>

    <div ref="workspaceEl" class="story-workspace" :data-resizing="resizingSidebar ? 'true' : undefined" :style="{ '--story-sidebar-width': `${sidebarWidth}px` }">
      <aside class="story-sidebar" aria-label="Stories">
        <Button class="story-new-button" size="sm" @click="openCreate"><Plus :size="15" /> New story</Button>
        <div v-if="loading" class="story-empty">Loading stories...</div>
        <div v-else-if="!stories.length" class="story-empty">No stories yet.</div>
        <div v-for="story in stories" :key="`${story.ownerNodeId}:${story.id}`" class="story-tree">
          <button type="button" class="story-tree-item story-tree-story" :class="{ active: isStorySelected(story) }" @click="selectStory(story)">
            <BookOpen :size="15" />
            <span><strong>{{ story.title }}</strong><small>{{ story.documents.length }} documents · {{ sessionCount(story) }} sessions</small></span>
          </button>
          <div v-if="isStoryOpen(story)" class="story-tree-children">
            <div class="story-tree-heading">Documents</div>
            <button v-for="document in story.documents" :key="document.storyPath" type="button" class="story-tree-item" :class="{ active: isDocumentSelected(story, document.storyPath) }" @click="selectDocument(story, document.storyPath)">
              <FileText :size="14" /><span><strong>{{ document.title }}</strong><small>{{ document.storyPath }}</small></span>
            </button>
            <div class="story-tree-heading">AI Sessions</div>
            <button v-for="entry in sessionsFor(story)" :key="entry.session.id" type="button" class="story-tree-item" :class="{ active: isSessionSelected(story, entry.session.id) }" @click="selectSession(story, entry)">
              <MessageSquare :size="14" /><span><strong>{{ entry.session.title || entry.session.userPrompt || entry.session.id }}</strong><small>{{ entry.instance.name }} · {{ entry.session.status }}</small></span>
            </button>
            <div v-if="!sessionsFor(story).length" class="story-tree-empty">No linked sessions.</div>
          </div>
        </div>
      </aside>
      <button type="button" class="story-sidebar-resize-handle" aria-label="Resize Story list" title="Resize Story list" @pointerdown.stop.prevent="startSidebarResize" @click.stop @dragstart.prevent />

      <main class="story-content">
        <template v-if="selectedResource?.kind === 'new-session'">
          <header class="story-content-header story-creation-header">
            <div><span class="story-content-kicker">New AI Session · {{ selectedResource.story.title }}</span><h2>Start a new session</h2><small>The session will belong to this Story.</small></div>
            <ControlPlaneSelect v-model="newSessionInstanceId" class="story-instance-select"><ControlPlaneSelectItem v-for="instance in storyInstances" :key="instance.id" :value="instance.id">{{ instance.name }}</ControlPlaneSelectItem></ControlPlaneSelect>
          </header>
          <AiSessionPanel v-if="newSessionInstance" class="story-session-creator" :active-session="creationActiveSession" creation-only :creation-story-id="selectedResource.story.id" :instance="newSessionInstance" :launchable-apps="launchableAppsForInstance(newSessionInstance, t)" :node-local-folders="nodeLocalFoldersByNodeId[newSessionInstance.nodeId] || []" :selected-ai-session="noSelectedAiSession" @session-created="finishStorySessionCreation" />
          <div v-else class="story-content-state">No available instance on this Story's node.</div>
        </template>
        <template v-else-if="selectedResource?.kind === 'session'">
          <header class="story-content-header">
            <div><span class="story-content-kicker">AI Session · {{ selectedResource.story.title }}</span><h2>{{ selectedResource.entry.session.title || selectedResource.entry.session.userPrompt || selectedResource.entry.session.id }}</h2><small>{{ selectedResource.entry.instance.name }} · {{ selectedResource.entry.session.cwd || 'Workspace unavailable' }}</small></div>
            <Button variant="outline" size="sm" @click="$emit('open-session', selectedResource.entry.instance, selectedResource.entry.session)">Open instance</Button>
          </header>
          <div v-if="sessionLoading" class="story-content-state">Loading conversation...</div>
          <div v-else-if="sessionError" class="story-content-state story-error">{{ sessionError }}</div>
          <ScrollArea v-else-if="sessionTimeline" class="story-session-detail">
            <article v-for="item in sessionTimeline.items" :key="item.id" class="story-timeline-item" :data-type="item.type">
              <div class="story-timeline-label">{{ item.type === 'user-message' ? 'You' : item.type === 'ai-message' ? 'AI' : item.title }}</div>
              <MarkdownContent v-if="item.type === 'user-message' || item.type === 'ai-message'" :content="item.text" :code-tools="markdownCodeTools" />
              <div v-else class="story-timeline-activity"><strong>{{ item.status || 'activity' }}</strong><span v-if="item.summary">{{ item.summary }}</span><code v-if="item.output">{{ item.output }}</code></div>
            </article>
          </ScrollArea>
          <div v-else class="story-content-state">No conversation content.</div>
        </template>
        <template v-else-if="selectedResource?.kind === 'document'">
          <header class="story-content-header">
            <div><span class="story-content-kicker">Document · {{ selectedResource.story.title }}</span><h2>{{ selectedResource.document.title }}</h2><small>{{ selectedResource.document.storyPath }}</small></div>
            <div class="story-content-actions"><a class="story-content-download" :href="downloadUrl(selectedResource.story, selectedResource.document.storyPath)" :download="selectedResource.document.storyPath.split('/').pop()"><Download :size="14" /> Download</a><Button variant="outline" size="sm" @click="renameDocument(selectedResource.story, selectedResource.document.storyPath, selectedResource.document.title)">Rename</Button><Button variant="outline" size="sm" @click="deleteDocument(selectedResource.story, selectedResource.document.storyPath)">Delete</Button></div>
          </header>
          <div v-if="previewLoading" class="story-content-state">Loading document...</div>
          <div v-else-if="previewError" class="story-content-state story-error">{{ previewError }}</div>
          <pre v-else class="story-document-preview">{{ previewText }}</pre>
        </template>
        <template v-else-if="selectedResource?.kind === 'story'">
          <header class="story-content-header">
            <div><span class="story-content-kicker">Story</span><h2>{{ selectedResource.story.title }}</h2><small>Node {{ selectedResource.story.ownerNodeId }} · {{ selectedResource.story.id }}</small></div>
            <div class="story-content-actions"><Button variant="outline" size="sm" @click="openEdit"><Pencil :size="14" /> Edit</Button><DropdownMenu><DropdownMenuTrigger as-child><Button variant="outline" size="icon" aria-label="More Story actions" title="More Story actions"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt)" @select="openNewSession">New session</DropdownMenuItem><DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt) || !availableSessions.length" @select="openAssignSession">Add existing</DropdownMenuItem><DropdownMenuItem @select="toggleArchive">{{ selectedResource.story.archivedAt ? 'Restore' : 'Archive' }}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
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
import { BookOpen, Download, FileText, MessageSquare, MoreHorizontal, Pencil, Play, Plus } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import Input from "../../../components/ui/input/Input.vue";
import Textarea from "../../../components/ui/textarea/Textarea.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import { getAiSessionTimeline } from "../../../api/queries";
import type { AiSessionTimeline } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionSummary, InstanceWithAiSessions, Node, NodeLocalFolder } from "../../../api/types";
import type { Story, StoryAction } from "@task-handoff/protocol/stories";
import AiSessionPanel from "../instance-detail/AiSessionPanel.vue";
import { launchableAppsForInstance, type SessionTab } from "../useInstanceSessions";

const props = withDefaults(defineProps<{ instances: InstanceWithAiSessions[]; nodes: Node[]; nodeLocalFoldersByNodeId?: Record<string, NodeLocalFolder[]> }>(), { nodeLocalFoldersByNodeId: () => ({}) });
const { t } = useI18n();
defineEmits<{ "open-session": [instance: InstanceWithAiSessions, session: Record<string, any>]; "run-action": [story: Story, action: StoryAction] }>();
type SessionEntry = { instance: InstanceWithAiSessions; session: any };
type Resource = { kind: "story"; story: Story } | { kind: "new-session"; story: Story } | { kind: "document"; story: Story; document: Story["documents"][number] } | { kind: "session"; story: Story; entry: SessionEntry };
const stories = ref<Story[]>([]); const selectedResource = ref<Resource>(); const loading = ref(false); const error = ref("");
const sidebarWidth = ref(320); const workspaceEl = ref<HTMLElement>(); const resizingSidebar = ref(false); let resizingPointerId: number | undefined;
const previewText = ref(""); const previewLoading = ref(false); const previewError = ref(""); const sessionTimeline = ref<AiSessionTimeline>(); const sessionLoading = ref(false); const sessionError = ref("");
const editorOpen = ref(false); const editing = ref(false); const draftTitle = ref(""); const draftDescription = ref(""); const draftNodeId = ref(""); const saving = ref(false);
const newSessionInstanceId = ref(""); const assignSessionOpen = ref(false); const assignSessionId = ref(""); const assigningSession = ref(false);
const sessionsFor = (story: Story) => props.instances.flatMap((instance) => (instance.aiSessions.sessions || []).filter((session) => session.storyId === story.id && instance.node?.id === story.ownerNodeId).map((session) => ({ instance, session })));
const storyInstances = computed(() => { const story = selectedResource.value?.story; return story ? props.instances.filter((instance) => instance.node?.id === story.ownerNodeId) : []; });
const newSessionInstance = computed(() => storyInstances.value.find((instance) => instance.id === newSessionInstanceId.value));
const creationActiveSession = computed<SessionTab>(() => ({ key: "ai", label: "AI", status: "running", kind: "ai", aiSessions: newSessionInstance.value?.aiSessions.sessions || [] }));
const noSelectedAiSession = () => undefined as AiSessionSummary | undefined;
const availableSessions = computed(() => { const story = selectedResource.value?.story; return story ? props.instances.flatMap((instance) => (instance.aiSessions.sessions || []).filter((session) => !session.storyId && instance.node?.id === story.ownerNodeId).map((session) => ({ instance, session }))) : []; });
const markdownCodeTools = { copiedLabel: "Copied", copyLabel: "Copy", plainTextLabel: "Plain text" };
const sessionCount = (story: Story) => sessionsFor(story).length;
const isStoryOpen = (story: Story) => selectedResource.value?.story.id === story.id && selectedResource.value?.story.ownerNodeId === story.ownerNodeId;
const isStorySelected = (story: Story) => selectedResource.value?.kind === "story" && isStoryOpen(story);
const isDocumentSelected = (story: Story, path: string) => selectedResource.value?.kind === "document" && isStoryOpen(story) && selectedResource.value.document.storyPath === path;
const isSessionSelected = (story: Story, id: string) => selectedResource.value?.kind === "session" && isStoryOpen(story) && selectedResource.value.entry.session.id === id;
function selectStory(story: Story) { selectedResource.value = { kind: "story", story }; }
function selectDocument(story: Story, path: string) { const document = story.documents.find((item) => item.storyPath === path); if (document) selectedResource.value = { kind: "document", story, document }; }
function selectSession(story: Story, entry: SessionEntry) { selectedResource.value = { kind: "session", story, entry }; }
function startSidebarResize(event: PointerEvent) { if (window.matchMedia("(max-width: 800px)").matches || !workspaceEl.value) return; resizingSidebar.value = true; resizingPointerId = event.pointerId; (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId); window.addEventListener("pointermove", resizeSidebar); window.addEventListener("pointerup", stopSidebarResize); window.addEventListener("pointercancel", stopSidebarResize); }
function resizeSidebar(event: PointerEvent) { if (!resizingSidebar.value || event.pointerId !== resizingPointerId || !workspaceEl.value) return; sidebarWidth.value = Math.min(520, Math.max(240, event.clientX - workspaceEl.value.getBoundingClientRect().left)); }
function stopSidebarResize(event?: PointerEvent) { if (event && resizingPointerId !== undefined && event.pointerId !== resizingPointerId) return; resizingSidebar.value = false; resizingPointerId = undefined; window.removeEventListener("pointermove", resizeSidebar); window.removeEventListener("pointerup", stopSidebarResize); window.removeEventListener("pointercancel", stopSidebarResize); }
async function load() { loading.value = true; error.value = ""; try { const response = await fetch("/api/stories"); const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || "Could not load stories."); stories.value = payload.data?.stories || []; if (!selectedResource.value && stories.value[0]) selectStory(stories.value[0]); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { loading.value = false; } }
watch(selectedResource, async (resource) => { previewText.value = ""; previewError.value = ""; sessionTimeline.value = undefined; sessionError.value = ""; if (resource?.kind === "document") { previewLoading.value = true; try { const response = await fetch(`/api/stories/${encodeURIComponent(resource.story.id)}/content/file?nodeId=${encodeURIComponent(resource.story.ownerNodeId)}&storyPath=${encodeURIComponent(resource.document.storyPath)}`); if (!response.ok) throw new Error((await response.json()).error?.message || "Could not read document."); previewText.value = await response.text(); } catch (cause) { previewError.value = cause instanceof Error ? cause.message : String(cause); } finally { previewLoading.value = false; } } else if (resource?.kind === "session") { sessionLoading.value = true; try { sessionTimeline.value = await getAiSessionTimeline(resource.entry.instance.id, resource.entry.session.id); } catch (cause) { sessionError.value = cause instanceof Error ? cause.message : String(cause); } finally { sessionLoading.value = false; } } }, { immediate: true });
function openCreate() { editing.value = false; draftTitle.value = ""; draftDescription.value = ""; draftNodeId.value = props.nodes.find((node) => node.status === "online")?.id || ""; editorOpen.value = true; }
function openEdit() { const story = selectedResource.value?.story; if (!story) return; editing.value = true; draftTitle.value = story.title; draftDescription.value = story.description || ""; draftNodeId.value = story.ownerNodeId; editorOpen.value = true; }
function openNewSession() { const story = selectedResource.value?.story; if (!story) return; newSessionInstanceId.value = storyInstances.value[0]?.id || ""; selectedResource.value = { kind: "new-session", story }; }
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
.story-view { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; padding:12px 12px 12px; color:var(--text); }
.story-content-header h2 { margin:0; color:var(--text-strong); font-size:18px; font-weight:500; }
.story-description,.story-content-header small,.story-content-kicker { color:var(--text-muted); font-size:12px; }
.story-workspace { display:grid; grid-template-columns:minmax(240px,var(--story-sidebar-width,320px)) 2px minmax(0,1fr); gap:0; flex:1 1 auto; min-height:0; margin-top:0; overflow:hidden; }
.story-sidebar { min-width:0; overflow:auto; padding:12px 8px; }
.story-new-button { width:100%; justify-content:center; margin-bottom:8px; }
.story-sidebar-resize-handle { position:relative; z-index:20; align-self:stretch; width:2px; min-width:2px; height:100%; margin-inline-end:12px; border:0; background:transparent; cursor:col-resize; padding:0; touch-action:none; }
.story-sidebar-resize-handle::after { display:block; width:2px; height:100%; margin:0 auto; background:var(--line); content:""; opacity:.45; transition:background 120ms ease,opacity 120ms ease,box-shadow 120ms ease; }
.story-sidebar-resize-handle:hover::after,.story-sidebar-resize-handle:focus-visible::after,.story-workspace[data-resizing="true"] .story-sidebar-resize-handle::after { background:color-mix(in srgb,var(--line-strong) 72%,var(--brand-accent)); box-shadow:0 0 0 1px color-mix(in srgb,var(--line-strong) 42%,transparent); opacity:1; }
.story-sidebar-resize-handle:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-3px; }
.story-workspace[data-resizing="true"] { user-select:none; cursor:col-resize; }
.story-tree-children { margin:2px 0 10px 22px; padding-left:10px; border-left:1px solid var(--line); }
.story-tree-item { display:flex; align-items:center; width:100%; min-width:0; gap:8px; border:0; border-radius:6px; background:transparent; color:inherit; cursor:pointer; padding:8px; text-align:left; }
.story-tree-item:hover,.story-tree-item.active { background:var(--surface-active); }
.story-tree-item > span { display:grid; min-width:0; flex:1; gap:2px; }
.story-tree-item strong,.story-tree-item small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-tree-item strong { font-size:13px; font-weight:500; }
.story-tree-item small,.story-tree-heading,.story-tree-empty { color:var(--text-muted); font-size:12px; }
.story-tree-heading { padding:8px 8px 4px; }
.story-tree-empty { padding:8px; }
.story-content { display:flex; min-width:0; min-height:0; flex-direction:column; overflow:hidden; padding:0 20px; }
.story-content-header { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid var(--line); padding:16px 0; flex:0 0 auto; }
.story-creation-header { min-height:64px; padding:10px 0; }
.story-creation-header h2 { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:16px; }
.story-content-header > div:first-child { display:grid; min-width:0; gap:4px; }
.story-content-kicker { text-transform:uppercase; letter-spacing:.04em; }
.story-content-state { display:grid; flex:1; place-items:center; color:var(--text-muted); font-size:13px; padding:24px; }
.story-session-detail { flex:1; min-height:0; padding:20px 0; }
.story-timeline-item { max-width:860px; margin:0 auto 18px; padding:12px 14px; border:1px solid var(--line); border-radius:6px; background:var(--surface); }
.story-timeline-label { margin-bottom:6px; color:var(--text-muted); font-size:12px; font-weight:500; }
.story-timeline-item :deep(p:last-child) { margin-bottom:0; }
.story-timeline-activity { display:grid; gap:5px; color:var(--text-muted); font-size:12px; }
.story-timeline-activity code { max-height:180px; overflow:auto; white-space:pre-wrap; font:12px/1.5 var(--font-mono); }
.story-document-preview { flex:1; min-height:0; overflow:auto; margin:20px 0; padding:16px; background:var(--workspace-bg); border-radius:6px; white-space:pre-wrap; font:12px/1.6 var(--font-mono); }
.story-content-download { display:inline-flex; align-items:center; gap:6px; color:var(--text-muted); font-size:12px; text-decoration:none; }
.story-content-download:hover { color:var(--text-strong); }
.story-content-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.story-instance-select { width:220px; }
.story-session-creator { flex:1; min-height:0; }
.story-overview-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1px; margin:20px 0; border:1px solid var(--line); background:var(--line); }
.story-overview-grid > div { display:grid; gap:4px; padding:16px; background:var(--surface); }
.story-overview-grid strong { font-size:20px; font-weight:500; }
.story-overview-grid span { color:var(--text-muted); font-size:12px; }
.story-actions-section { margin:0; }
.story-actions-section h3 { font-size:14px; font-weight:500; }
.story-action { display:flex; align-items:center; gap:8px; width:100%; margin-top:8px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; cursor:pointer; padding:10px 12px; text-align:left; }
.story-action:hover { background:var(--surface-active); }
.story-empty { color:var(--text-muted); font-size:12px; padding:20px; text-align:center; }
.story-error { color:var(--status-danger); font-size:12px; }
.story-editor-fields { display:grid; gap:14px; }
.story-editor-fields label { display:grid; gap:6px; color:var(--text-muted); font-size:12px; }
.story-editor-dialog { max-width:460px; }
@media (max-width:800px) { .story-view { padding:16px; } .story-workspace { grid-template-columns:minmax(220px,38%) minmax(0,1fr); } .story-sidebar-resize-handle { display:none; } .story-content-header { padding:14px 0; } .story-session-detail { padding:14px 0; } }
@media (max-width:560px) { .story-view { padding:10px; } .story-workspace { grid-template-columns:1fr; } .story-sidebar { max-height:38%; border-right:0; border-bottom:1px solid var(--line); } .story-overview-grid { margin:14px 0; } .story-actions-section { margin:0; } }
</style>
