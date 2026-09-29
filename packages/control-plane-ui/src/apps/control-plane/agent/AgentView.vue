<template>
  <section class="agent-view" :aria-label="t('agents.view')">
    <div
      ref="paneEl"
      class="agent-workspace"
      :class="{ 'agent-workspace-collapsed': paneCollapsed, 'agent-workspace-overlay-open': paneOverlayOpen, 'agent-workspace-animating': paneLayoutAnimating }"
      :data-resizing="paneResizing ? 'true' : undefined"
      :style="{ '--agent-sidebar-width': `${paneWidth}px`, '--agent-sidebar-layout-width': paneLayoutWidth }"
    >
      <aside
        class="agent-sidebar"
        :aria-hidden="paneCollapsed && !paneOverlayOpen ? 'true' : undefined"
        :aria-label="t('agents.region')"
        @pointerenter="openOverlay"
        @pointerleave="scheduleOverlayClose"
      >
        <div class="agent-sidebar-actions">
          <button type="button" class="agent-list-item agent-new-button" @click="openCreate">
            <Plus :size="15" />
            <span class="agent-list-item-copy"><strong>{{ t("agents.list.create") }}</strong></span>
          </button>
          <Input v-model="filter" class="agent-sidebar-filter" :placeholder="t('agents.list.filterPlaceholder')" />
          <div class="agent-sidebar-section">
            <span class="agent-sidebar-section-label">{{ t("agents.list.title") }}</span>
          </div>
        </div>
        <ScrollArea type="hover" :horizontal="false" class="agent-sidebar-scroll">
          <div class="agent-sidebar-scroll-inner">
            <div v-for="group in groupedAgents" :key="group.nodeId" class="agent-list-group">
              <div class="agent-list-group-head">
                <span class="agent-list-group-label">{{ group.nodeLabel }}</span>
                <span v-if="loadingNodeIds.includes(group.nodeId)" class="agent-node-load" role="status">{{ t("agents.list.loadingNode") }}</span>
                <span v-else-if="unavailableNodeIds.includes(group.nodeId)" class="agent-node-load" data-state="warning">{{ t("agents.list.unavailableNode") }}</span>
              </div>
              <ContextMenu v-for="agent in group.agents" :key="agent.key">
                <ContextMenuTrigger as-child>
                  <button
                    type="button"
                    class="agent-list-item"
                    :class="{ active: agent.key === selectedAgentKey }"
                    :aria-pressed="agent.key === selectedAgentKey"
                    @contextmenu="selectedAgentKey = agent.key"
                    @click="selectedAgentKey = agent.key"
                  >
                    <span class="agent-list-item-copy">
                      <strong>{{ agent.name }}</strong>
                      <small>{{ agent.instanceLabel }} · {{ agent.executable ? t("agents.availability.executable") : t("agents.availability.blocked") }}</small>
                    </span>
                  </button>
                </ContextMenuTrigger>
                <AgentContextMenu
                  :can-run="agentManualRunAvailable(agent, agentRunOrchestrations(catalog.orchestrations, agent))"
                  :editable="agent.nodeOnline"
                  :deleting="deleting"
                  :orchestration="{ label: 'edit', enabled: agent.nodeOnline && nodeOrchestrationsSupported(agent.nodeId) }"
                  @run="openManualRun(agent)"
                  @edit="openEdit(agent)"
                  @orchestration="openAgentOrchestrationInGraph(agent.key)"
                  @delete="deleteAgent(agent)"
                />
              </ContextMenu>
            </div>
            <div v-if="!groupedAgents.length" class="agent-list-empty">
              <span v-if="isPending">{{ t("agents.list.loading") }}</span>
              <template v-else-if="unavailableNodeIds.length">
                <span>{{ t("agents.list.unavailable") }}</span>
                <Button variant="ghost" size="sm" @click="refetch"><RefreshCw :size="14" />{{ t("agents.list.retry") }}</Button>
              </template>
              <span v-else-if="!catalog.nodes.length">{{ t("agents.list.unsupported") }}</span>
              <span v-else>{{ filter.trim() ? t("agents.list.empty") : t("agents.list.noAgents") }}</span>
            </div>
          </div>
        </ScrollArea>
      </aside>
      <button
        type="button"
        class="agent-sidebar-resize-handle"
        :aria-label="t('agents.resizeList')"
        :title="t('agents.resizeList')"
        @pointerdown.stop.prevent="startResize"
        @pointerenter="openOverlay"
        @pointerleave="scheduleOverlayClose"
        @focus="openOverlay"
        @blur="scheduleOverlayClose"
        @click.stop="toggleCollapsed"
        @dragstart.prevent
      />

      <main class="agent-content">
        <AgentGraph
          v-if="viewMode === 'graph'"
          class="agent-content-graph"
          :agents="visibleAgents"
          :nodes="catalog.nodes"
          :orchestrations="visibleOrchestrations"
          :selected-agent-key="selectedAgentKey"
          :orchestration-key="graphOrchestrationKey"
          :deleting="deleting"
          :save="saveOrchestrationChange"
          @run="runAgentByKey"
          @edit="editAgentByKey"
          @delete="deleteAgentByKey"
          @remove="removeOrchestrationByKey"
          @create="openCreateOrchestration"
          @show-detail="showAgentDetail"
          @show-orchestration="openAgentOrchestrationInGraph"
          @orchestration-change="graphOrchestrationKey = $event"
        />
        <p v-else-if="!selectedAgent" class="agent-content-state">{{ t("agents.detail.empty") }}</p>
        <ScrollArea v-else type="auto" :horizontal="false" class="agent-detail-scroll">
          <div class="agent-detail-scroll-inner">
            <div class="agent-detail-head">
              <header class="agent-content-header">
                <div class="agent-content-title">
                  <AgentViewSwitcher
                    mode="detail"
                    :active-key="graphOrchestrationKey"
                    :groups="switcherGroups"
                    :can-create="selectedAgent.nodeOnline && orchestrationsSupported"
                    @select-orchestration="openOrchestrationInGraphByKey"
                    @create="openCreateOrchestration"
                  />
                  <h2
                    class="agent-title-name-field"
                    :class="{ editing: editingAgentName }"
                    :style="editingAgentName && agentNameEditWidth ? { '--agent-title-name-edit-width': `${agentNameEditWidth}px` } : undefined"
                  >
                    <input
                      v-if="editingAgentName"
                      ref="agentNameInput"
                      v-model="agentNameDraft"
                      class="agent-title-name-input"
                      :disabled="savingAgentName"
                      :aria-label="t('agents.detail.editName', { name: selectedAgent.name })"
                      @blur="commitAgentNameEdit"
                      @keydown="handleAgentNameEditKeydown"
                    />
                    <button
                      v-else
                      type="button"
                      class="agent-title-name-button"
                      :disabled="!selectedAgent.nodeOnline"
                      :aria-label="t('agents.detail.editName', { name: selectedAgent.name })"
                      :title="t('agents.detail.editNameTitle')"
                      @click="beginAgentNameEdit(selectedAgent, $event)"
                    >
                      <span class="agent-title-name-button-label">{{ selectedAgent.name }}</span>
                    </button>
                  </h2>
                  <small>{{ selectedAgent.instanceLabel }}</small>
                </div>
                <div class="agent-content-actions">
                  <Button
                    size="sm"
                    :disabled="!canLaunchSelectedAgent"
                    :title="manualRunUnavailableLabel"
                    @click="openManualRun(selectedAgent)"
                  >
                    <Play :size="14" />
                    {{ t("agents.detail.run") }}
                  </Button>
                  <Button variant="outline" size="sm" :disabled="!selectedAgent.nodeOnline" @click="openEdit(selectedAgent)">
                    <Pencil :size="14" />
                    {{ t("agents.detail.edit") }}
                  </Button>
                  <Button variant="outline" size="sm" :disabled="deleting || !selectedAgent.nodeOnline" @click="deleteAgent(selectedAgent)">
                    <Trash2 :size="14" />
                    {{ t("agents.detail.delete") }}
                  </Button>
                </div>
              </header>
              <div class="agent-detail-runtime">
                <AiAgentIcon v-if="providerBrand" :agent="providerBrand" :size="14" />
                <span class="agent-detail-runtime-item">{{ selectedAgent.provider }}</span>
                <span class="agent-detail-runtime-separator" aria-hidden="true">·</span>
                <span class="agent-detail-runtime-item">{{ selectedAgent.model }}</span>
              </div>
              <p v-if="selectedAgent.description" class="agent-detail-description">{{ selectedAgent.description }}</p>
              <p v-if="blockedLabel(selectedAgent)" class="agent-detail-blocked" role="alert">{{ blockedLabel(selectedAgent) }}</p>
            </div>

            <section class="agent-card">
              <div class="agent-card-header"><div class="agent-card-heading"><h3>{{ t("agents.detail.target") }}</h3></div></div>
              <div class="agent-card-body">
                <dl class="agent-field-list">
                  <div class="agent-field"><dt>{{ t("agents.field.node") }}</dt><dd>{{ selectedAgent.nodeLabel }}</dd></div>
                  <div class="agent-field"><dt>{{ t("agents.field.instance") }}</dt><dd>{{ selectedAgent.instanceLabel }}</dd></div>
                  <div class="agent-field"><dt>{{ t("agents.field.folder") }}</dt><dd class="agent-mono">{{ selectedAgent.folderPath }}</dd></div>
                  <div class="agent-field"><dt>{{ t("agents.field.permission") }}</dt><dd class="agent-mono">{{ selectedAgent.permissionMode }}</dd></div>
                  <div class="agent-field"><dt>{{ t("agents.field.reasoning") }}</dt><dd>{{ selectedAgent.reasoning }}</dd></div>
                </dl>
              </div>
            </section>

            <section class="agent-card">
              <div class="agent-card-header"><div class="agent-card-heading"><h3>{{ t("agents.detail.execution") }}</h3></div></div>
              <div class="agent-card-body">
                <dl class="agent-field-list">
                  <div class="agent-field"><dt>{{ t("agents.field.workspace") }}</dt><dd>{{ workspaceLabel(selectedAgent) }}</dd></div>
                  <div class="agent-field"><dt>{{ t("agents.field.executionMode") }}</dt><dd>{{ sandboxLabel(selectedAgent) }}</dd></div>
                  <div class="agent-field"><dt>{{ t("agents.field.isolation") }}</dt><dd>{{ isolationLabel(selectedAgent) }}</dd></div>
                </dl>
                <p class="agent-note">{{ t("agents.value.overlayNote") }}</p>
                <p class="agent-note">{{ t("agents.value.isolationNote") }}</p>
              </div>
            </section>

            <section class="agent-card">
              <div class="agent-card-header"><div class="agent-card-heading"><h3>{{ t("agents.detail.appendedPrompt") }}</h3></div></div>
              <div class="agent-card-body">
                <p v-if="selectedAgent.appendedPrompt" class="agent-note">{{ selectedAgent.appendedPrompt }}</p>
                <p v-else class="agent-note">{{ t("agents.detail.appendedPromptEmpty") }}</p>
                <p class="agent-note">{{ t("agents.value.appendedPromptNote") }}</p>
              </div>
            </section>

            <section class="agent-card">
              <div class="agent-card-header">
                <div class="agent-card-heading"><h3>{{ t("agents.detail.orchestration") }}</h3><span>{{ agentOrchestrations.length }}</span></div>
                <Button variant="outline" size="sm" :disabled="!selectedAgent.nodeOnline || !orchestrationsSupported" @click="openCreateOrchestration">
                  <Plus :size="14" />
                  {{ t("agents.detail.orchestrationCreate") }}
                </Button>
              </div>
              <div class="agent-card-body">
                <div v-if="agentOrchestrations.length" class="agent-chip-row">
                  <button
                    v-for="orchestration in agentOrchestrations"
                    :key="orchestration.key"
                    type="button"
                    class="agent-orchestration-chip"
                    @click="openOrchestrationInGraph(orchestration)"
                  >
                    <span>{{ orchestration.name }}</span>
                    <Badge v-if="orchestration.isDefault" variant="outline" class="agent-chip">{{ t("agents.detail.orchestrationDefault") }}</Badge>
                    <small>{{ t("agents.detail.orchestrationMembers", { count: orchestration.agentIds.length }) }}</small>
                  </button>
                </div>
                <p v-else class="agent-note">{{ t("agents.detail.orchestrationEmpty") }}</p>
                <p class="agent-note">{{ t("agents.detail.orchestrationHint") }}</p>
              </div>
            </section>

            <section class="agent-card">
              <div class="agent-card-header">
                <div class="agent-card-heading"><h3>{{ t("agents.detail.storyEntry") }}</h3><span>{{ entryStoryLabels.length }}</span></div>
              </div>
              <div class="agent-card-body">
                <div v-if="entryStoryLabels.length" class="agent-chip-row">
                  <Badge v-for="story in entryStoryLabels" :key="story" variant="outline" class="agent-chip">{{ story }}</Badge>
                </div>
                <p v-else class="agent-note">{{ t("agents.detail.storyEntryEmpty") }}</p>
                <p class="agent-note">{{ t("agents.detail.storyEntryHint") }}</p>
              </div>
            </section>

            <section class="agent-card">
              <div class="agent-card-header">
                <div class="agent-card-heading"><h3>{{ t("agents.detail.runs") }}</h3><span>{{ runs.length }}</span></div>
              </div>
              <div v-if="runs.length" class="agent-run-list">
                <button
                  v-for="run in runs"
                  :key="run.key"
                  type="button"
                  class="agent-run-item"
                  :class="{ active: run.key === selectedRun?.key }"
                  @click="selectedRunKey = run.key"
                >
                  <span class="agent-run-copy">
                    <strong class="agent-mono">{{ run.runId }}</strong>
                    <small>{{ run.startedLabel }} · {{ run.durationLabel }}</small>
                  </span>
                  <Badge variant="outline" class="agent-run-status" :class="`agent-run-status-${run.status}`">
                    {{ t(`agents.run.status.${run.status}`) }}
                  </Badge>
                </button>
              </div>
              <div v-else class="agent-card-body"><p class="agent-note">{{ t("agents.detail.runsEmpty") }}</p></div>

              <div v-if="selectedRun" class="agent-run-detail">
                <div class="agent-run-detail-head">
                  <p class="agent-note">
                    {{ selectedRun.initiatorKind === "control-plane"
                      ? t("agents.run.initiatorManual")
                      : t("agents.run.initiator", { session: selectedRun.initiatorSessionLabel }) }}
                  </p>
                  <Button v-if="canCancelSelectedRun" variant="outline" size="sm" :disabled="cancellingRun" @click="cancelSelectedRun">
                    <X :size="14" />{{ t("agents.run.cancel") }}
                  </Button>
                </div>
                <p v-if="selectedRun.resultDeliveryStatus" class="agent-note">
                  {{ t(`agents.run.delivery.${selectedRun.resultDeliveryStatus}`) }}
                  <span v-if="selectedRun.resultDeliveryError"> · {{ selectedRun.resultDeliveryError }}</span>
                </p>
                <p v-if="selectedRun.workspaceDestroyed" class="agent-note">{{ t("agents.run.workspaceDestroyed") }}</p>
                <p v-if="selectedRun.sharedExpiresLabel" class="agent-note">
                  {{ t("agents.run.sharedRetained", { time: selectedRun.sharedExpiresLabel }) }}
                </p>
                <p v-if="selectedRun.sharedState && selectedRun.sharedUsageBytes !== undefined && selectedRun.sharedQuotaBytes !== undefined" class="agent-note">
                  {{ t("agents.run.sharedUsage", { usage: formatBytes(selectedRun.sharedUsageBytes), quota: formatBytes(selectedRun.sharedQuotaBytes) }) }}
                  · {{ t(`agents.run.sharedState.${selectedRun.sharedState}`) }}
                </p>
                <ul class="agent-member-tree">
                  <li v-for="row in memberRows" :key="row.member.memberId" class="agent-member" :class="{ 'agent-member-child': row.depth > 0 }" :style="memberTreeStyle(row.depth)">
                    <span class="agent-member-name">{{ row.member.agentLabel }}</span>
                    <Badge variant="outline" class="agent-run-status" :class="`agent-run-status-${row.member.status}`">
                      {{ t(`agents.run.status.${row.member.status}`) }}
                    </Badge>
                    <small class="agent-member-meta">{{ row.relationship }} · {{ row.member.instanceLabel }} · {{ row.member.durationLabel }}</small>
                    <p class="agent-member-result">{{ row.member.resultSummary }}</p>
                  </li>
                </ul>
              </div>
            </section>
          </div>
        </ScrollArea>
      </main>
    </div>

    <Dialog v-model:open="orchestrationCreateOpen">
      <DialogContent class="agent-dialog">
        <DialogHeader>
          <DialogTitle>{{ t("agents.orchestration.createTitle") }}</DialogTitle>
          <DialogDescription>{{ t("agents.orchestration.createDescription", { name: selectedAgent?.name || "" }) }}</DialogDescription>
        </DialogHeader>
        <label class="agent-dialog-field">
          <span>{{ t("agents.orchestration.name") }}</span>
          <Input v-model="newOrchestrationName" :placeholder="t('agents.orchestration.namePlaceholder')" />
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" @click="orchestrationCreateOpen = false">{{ t("common.actions.cancel") }}</Button>
          <Button type="button" :disabled="!newOrchestrationName.trim() || creatingOrchestration" @click="confirmCreateOrchestration">
            {{ creatingOrchestration ? t("agents.orchestration.creating") : t("agents.orchestration.create") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="Boolean(pendingDeleteAgent)" @update:open="(open: boolean) => !open && (pendingDeleteAgent = undefined)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t("agents.confirm.deleteTitle") }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t("agents.confirm.deleteAgent", { name: pendingDeleteAgent?.name || "" }) }}</AlertDialogDescription>
        </AlertDialogHeader>
        <label class="agent-dialog-check">
          <Checkbox
            :model-value="deleteReferencingOrchestrations"
            @update:model-value="(value: boolean | 'indeterminate') => (deleteReferencingOrchestrations = value === true)"
          />
          <span>
            <strong>{{ t("agents.confirm.deleteOrchestrations") }}</strong>
            <small>{{ t("agents.confirm.deleteOrchestrationsHint") }}</small>
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deleting">{{ t("common.actions.cancel") }}</AlertDialogCancel>
          <Button variant="destructive" size="sm" :disabled="deleting" @click="confirmDeleteAgent">
            {{ deleting ? t("agents.confirm.deleting") : t("common.actions.delete") }}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog :open="Boolean(pendingDeleteOrchestration)" @update:open="(open: boolean) => !open && (pendingDeleteOrchestration = undefined)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t("agents.confirm.deleteTitle") }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t("agents.orchestration.confirmDelete", { name: pendingDeleteOrchestration?.name || "" }) }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deleting">{{ t("common.actions.cancel") }}</AlertDialogCancel>
          <Button variant="destructive" size="sm" :disabled="deleting" @click="confirmDeleteOrchestration">
            {{ deleting ? t("agents.confirm.deleting") : t("common.actions.delete") }}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AgentEditor
      v-model:open="editorOpen"
      :agent="editingAgent"
      :agents="catalog.agents"
      :instances="instances"
      :save="saveDraft"
    />
    <AgentRunDialog
      v-model:open="manualRunOpen"
      :agent-name="manualRunAgent?.name || ''"
      :orchestrations="manualRunOrchestrations"
      :submitting="launchingRun"
      :submit="launchManualRun"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import type { AgentDefinitionCreateInput, AgentDefinitionUpdateInput, AgentProcessSandbox, AgentWorkspaceMaterializer } from "@task-handoff/protocol/agent-definitions";
import { Pencil, Play, Plus, RefreshCw, Trash2, X } from "@lucide/vue";
import AiAgentIcon from "@/components/AiAgentIcon.vue";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  cancelAgentRun,
  createAgentDefinition,
  createAgentOrchestration,
  createManualAgentRun,
  deleteAgentDefinition,
  deleteAgentOrchestration,
  updateAgentDefinition,
  updateAgentOrchestration,
  useInstanceBoardQuery,
} from "@/api/queries";
import { allNodesVisible, controlPlaneAgentCapabilities, nodeIsVisible, type NodeVisibilityFilter } from "@task-handoff/control-plane-client";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { useResizablePane } from "../shared/useResizablePane";
import AgentEditor from "./AgentEditor.vue";
import AgentContextMenu from "./AgentContextMenu.vue";
import AgentRunDialog from "./AgentRunDialog.vue";
import AgentGraph, { type AgentOrchestrationChange } from "./AgentGraph.vue";
import AgentViewSwitcher from "./AgentViewSwitcher.vue";
import { agentCatalogGroups, agentCatalogKey, agentCatalogMemberRows, agentFirstOrchestration, agentManualRunAvailable, agentOrchestrationGroups, agentParticipatingOrchestrations, agentRunOrchestrations } from "./agentCatalog";
import type { AgentBlockedCode, AgentCatalogAgent, AgentCatalogOrchestration, AgentEditorDraft } from "./agentCatalogTypes";
import { useAgentCatalog } from "./useAgentCatalog";
import { aiSessionLaunchableAppsForInstance } from "../useInstanceSessions";
import { translateApiError } from "@/i18n/apiError";
import { invalidateControlPlaneDomains } from "@/api/queryInvalidation";
import { createBrowserUuid } from "../../../lib/random-id";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  nodeFilter?: NodeVisibilityFilter;
}>(), {
  nodeFilter: allNodesVisible,
});

// 列表栏的拖拽/折叠交互与 Story 视图共用同一份实现，键位各自独立。
const {
  paneEl, paneWidth, paneCollapsed, paneLayoutWidth, paneResizing, paneOverlayOpen,
  paneLayoutAnimating, startResize, toggleCollapsed, openOverlay, scheduleOverlayClose,
} = useResizablePane({
  widthStorageKey: "task-handoff.control-plane.agents.sidebar-width",
  collapseStorageKey: "task-handoff.control-plane.agents.sidebar-collapse-mode",
  defaultWidth: 300,
  minWidth: 240,
  maxWidth: 520,
});

const queryClient = useQueryClient();
const filter = ref("");
const selectedAgentKey = ref("");
const selectedRunKey = ref("");
const viewMode = ref<"detail" | "graph">("detail");
const editorOpen = ref(false);
const editingAgent = ref<AgentCatalogAgent>();
// 列表模式头部改名与 Story 头部同一交互：默认是 hover 可点的标签，点击后才换成输入框。
const editingAgentName = ref(false);
const agentNameDraft = ref("");
const agentNameEditWidth = ref(0);
const agentNameInput = ref<HTMLInputElement>();
const savingAgentName = ref(false);
const board = useInstanceBoardQuery();
const instances = computed(() => board.data.value || []);

// 目录是视图的唯一数据入口：定义来自各 Node 的权威查询，provider 展示名在投影边界注入。
const { catalog, nodes, loadingNodeIds, unavailableNodeIds, isPending, refetch } = useAgentCatalog({
  providerLabel: (instance, providerId) => (
    instance ? aiSessionLaunchableAppsForInstance(instance, t).find((app) => app.id === providerId)?.label || providerId : providerId
  ),
});

// 定义随各 Node 响应逐步出现；选中的定义消失（被删除或切出节点作用域）时回落到第一个可见定义。
watch([catalog, () => props.nodeFilter], ([next]) => {
  const keys = next.agents.filter((agent) => nodeIsVisible(props.nodeFilter, agent.nodeId)).map((agent) => agent.key);
  if (selectedAgentKey.value && keys.includes(selectedAgentKey.value)) return;
  selectedAgentKey.value = keys[0] || "";
}, { immediate: true });

const agentsByKey = computed(() => new Map(catalog.value.agents.map((agent) => [agent.key, agent])));

// 顶部导航的节点作用域先过滤节点，本地关键字再过滤 Agent；列表与关系图共用这个可见集合。
const visibleAgents = computed(() => catalog.value.agents.filter((agent) => nodeIsVisible(props.nodeFilter, agent.nodeId)));

const filteredAgents = computed(() => {
  const keyword = filter.value.trim().toLocaleLowerCase();
  if (!keyword) return visibleAgents.value;
  return visibleAgents.value.filter((agent) => `${agent.name} ${agent.description} ${agent.instanceLabel}`.toLocaleLowerCase().includes(keyword));
});

const groupedAgents = computed(() => agentCatalogGroups({ ...catalog.value, agents: filteredAgents.value }));

const selectedAgent = computed(() => agentsByKey.value.get(selectedAgentKey.value));
/** 只有已知 app 有品牌图标；未知 provider 只呈现文字标签，不猜图标。 */
const providerBrand = computed<"codex" | "claude" | "opencode" | undefined>(() => {
  const providerId = selectedAgent.value?.providerId;
  return providerId === "codex" || providerId === "claude" || providerId === "opencode" ? providerId : undefined;
});
/** 编排能力由 Node 的 capability document 决定：详情头部、内容选择器与列表右键菜单共用同一份判定。 */
function nodeOrchestrationsSupported(nodeId?: string) {
  return nodes.value.some((node) => node.id === nodeId && controlPlaneAgentCapabilities(node.capabilities).orchestrations);
}
const orchestrationsSupported = computed(() => nodeOrchestrationsSupported(selectedAgent.value?.nodeId));
/** 该 Agent 参与的全部编排；画布与详情卡片都消费同一份派生列表。 */
const agentOrchestrations = computed(() => (selectedAgent.value
  ? [...agentParticipatingOrchestrations(catalog.value.orchestrations, selectedAgent.value)]
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name))
  : []));
const visibleOrchestrations = computed(() => catalog.value.orchestrations.filter((orchestration) => nodeIsVisible(props.nodeFilter, orchestration.nodeId)));
/** 内容选择器与画布共用目录层的「入口 / 参与」分组，顺序只在目录层定义一次。 */
const switcherGroups = computed(() => (selectedAgent.value ? agentOrchestrationGroups(visibleOrchestrations.value, selectedAgent.value) : []));
const entryStoryLabels = computed(() => selectedAgent.value?.entryStoryLabels ?? []);

const runs = computed(() => (selectedAgent.value
  ? catalog.value.runs.filter((run) => run.nodeId === selectedAgent.value?.nodeId && run.members.some((member) => member.agentId === selectedAgent.value?.id))
  : []));
const selectedRun = computed(() => runs.value.find((run) => run.key === selectedRunKey.value) ?? runs.value[0]);
const memberRows = computed(() => agentCatalogMemberRows(selectedRun.value?.members ?? []).map((row) => ({
  ...row,
  relationship: row.member.parentMemberId
    ? `${t("agents.run.parent")}: ${row.parent?.agentLabel ?? row.member.parentMemberId}`
    : t("agents.run.root"),
})));
const canCancelSelectedRun = computed(() => Boolean(selectedRun.value && !["completed", "failed", "cancelled"].includes(selectedRun.value.status)));
const cancellingRun = ref(false);
const manualRunOpen = ref(false);
const manualRunAgent = ref<AgentCatalogAgent>();
const launchingRun = ref(false);
function manualRunUnavailableLabelFor(agent?: AgentCatalogAgent) {
  if (!agent || agentManualRunAvailable(agent, agentRunOrchestrations(catalog.value.orchestrations, agent))) return "";
  if (!agent.manualRunsSupported) return t("agents.manualRun.unsupported");
  if (!agentRunOrchestrations(catalog.value.orchestrations, agent).length) return t("agents.manualRun.noOrchestration");
  return blockedLabel(agent) || t("agents.manualRun.unavailable");
}

const canLaunchSelectedAgent = computed(() => agentManualRunAvailable(selectedAgent.value, manualRunOrchestrations.value));
const manualRunUnavailableLabel = computed(() => manualRunUnavailableLabelFor(selectedAgent.value));
const manualRunOrchestrations = computed(() => (manualRunAgent.value
  ? agentRunOrchestrations(catalog.value.orchestrations, manualRunAgent.value)
  : []));

function openManualRun(agent: AgentCatalogAgent) {
  if (!agentManualRunAvailable(agent, agentRunOrchestrations(catalog.value.orchestrations, agent))) return;
  manualRunAgent.value = agent;
  manualRunOpen.value = true;
}

// 画布节点只回传聚合 key：这里回到同一份目录解析对象，再走与列表右键完全相同的操作实现。
function runAgentByKey(key: string) {
  const agent = agentsByKey.value.get(key);
  if (agent) openManualRun(agent);
}

function editAgentByKey(key: string) {
  const agent = agentsByKey.value.get(key);
  if (agent) openEdit(agent);
}

function deleteAgentByKey(key: string) {
  const agent = agentsByKey.value.get(key);
  if (agent) void deleteAgent(agent);
}

async function launchManualRun(prompt: string, orchestrationId: string) {
  const agent = manualRunAgent.value;
  if (!agent || launchingRun.value) return;
  launchingRun.value = true;
  try {
    const run = await createManualAgentRun(agent.nodeId, {
      clientRequestId: createBrowserUuid(),
      orchestrationId,
      entryAgentId: agent.id,
      input: { prompt },
    });
    await invalidateControlPlaneDomains(queryClient, ["agents"]);
    selectedAgentKey.value = agent.key;
    selectedRunKey.value = agentCatalogKey(agent.nodeId, run.runId);
    manualRunOpen.value = false;
    showControlPlaneToast(t("agents.manualRun.started"), "success");
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t, t("agents.manualRun.startFailed")));
  } finally {
    launchingRun.value = false;
  }
}

async function cancelSelectedRun() {
  const run = selectedRun.value;
  if (!run || cancellingRun.value) return;
  cancellingRun.value = true;
  try {
    await cancelAgentRun(run.runId, run.nodeId, run.revision);
    await invalidateControlPlaneDomains(queryClient, ["agents"]);
    showControlPlaneToast(t("agents.run.cancelledToast"), "success");
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t, t("agents.run.cancelFailed")));
  } finally {
    cancellingRun.value = false;
  }
}
function memberTreeStyle(depth: number) {
  return { "--agent-member-depth": String(depth) };
}
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function openCreate() {
  editingAgent.value = undefined;
  editorOpen.value = true;
}

function openEdit(agent: AgentCatalogAgent) {
  editingAgent.value = agent;
  editorOpen.value = true;
}

/** 点击名称进入编辑：输入框先与标签同宽，内容更长时再增宽，避免头部跳动。 */
async function beginAgentNameEdit(agent: AgentCatalogAgent, event?: MouseEvent) {
  if (!agent.nodeOnline || savingAgentName.value) return;
  agentNameEditWidth.value = Math.ceil((event?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect().width || 0);
  agentNameDraft.value = agent.name;
  editingAgentName.value = true;
  await nextTick();
  const input = agentNameInput.value;
  if (input) {
    const inputContentWidth = input.scrollWidth + input.offsetWidth - input.clientWidth;
    agentNameEditWidth.value = Math.max(agentNameEditWidth.value, Math.ceil(inputContentWidth));
  }
  agentNameInput.value?.focus();
  agentNameInput.value?.select();
}

function cancelAgentNameEdit() {
  editingAgentName.value = false;
  agentNameDraft.value = "";
  agentNameEditWidth.value = 0;
}

function handleAgentNameEditKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    void commitAgentNameEdit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelAgentNameEdit();
  }
}

/** 改名是补丁式权威写入：只提交名称与新 revision，其余字段由 Node 保持；失败时重读收敛。 */
async function commitAgentNameEdit() {
  const agent = selectedAgent.value;
  if (!agent || !editingAgentName.value || savingAgentName.value) return;
  const name = agentNameDraft.value.trim();
  if (!name || name === agent.name) {
    cancelAgentNameEdit();
    return;
  }
  savingAgentName.value = true;
  try {
    await updateAgentDefinition(agent.id, agent.nodeId, { expectedRevision: agent.revision, name });
    await invalidateControlPlaneDomains(queryClient, ["agents"]);
    showControlPlaneToast(t("agents.toast.updated", { name }), "success");
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t, t("agents.errors.updateFailed")));
    await refetch();
  } finally {
    savingAgentName.value = false;
    cancelAgentNameEdit();
  }
}

const blockedLabelKeys: Record<AgentBlockedCode, string> = {
  "definitions-unsupported": "agents.blocked.definitionsUnsupported",
  "node-offline": "agents.blocked.nodeOffline",
  "instance-missing": "agents.blocked.instanceMissing",
  "instance-offline": "agents.blocked.instanceOffline",
  "local-runtime": "agents.blocked.localRuntime",
  "missing-reference": "agents.blocked.missingReference",
  "policy-unsupported": "agents.blocked.policyUnsupported",
};

function blockedLabel(agent: AgentCatalogAgent) {
  return agent.blockedCode ? t(blockedLabelKeys[agent.blockedCode]) : "";
}

// 运行方式按定义保存的权威策略展示，不按本地假设回填固定文案。
const workspaceLabelKeys: Record<AgentWorkspaceMaterializer, string> = {
  "overlay-copy-on-write": "agents.value.workspaceOverlay",
  worktree: "agents.value.workspaceWorktree",
};
const sandboxLabelKeys: Record<AgentProcessSandbox, string> = {
  instance: "agents.value.sandboxInstance",
  container: "agents.value.sandboxContainer",
  "local-runtime": "agents.value.sandboxLocalRuntime",
};
const isolationLabelKeys: Record<AgentProcessSandbox, string> = {
  instance: "agents.value.isolationInstance",
  container: "agents.value.isolationContainer",
  "local-runtime": "agents.value.isolationLocalRuntime",
};

function workspaceLabel(agent: AgentCatalogAgent) {
  return t(workspaceLabelKeys[agent.executionPolicy.workspaceMaterializer]);
}

function sandboxLabel(agent: AgentCatalogAgent) {
  return t(sandboxLabelKeys[agent.executionPolicy.processSandbox]);
}

function isolationLabel(agent: AgentCatalogAgent) {
  return t(isolationLabelKeys[agent.executionPolicy.processSandbox]);
}

/** 可选预设留空表示未设置：创建时省略字段，更新时显式传 null 清空。 */
function createInputFromDraft(draft: AgentEditorDraft): AgentDefinitionCreateInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    appendedPrompt: draft.appendedPrompt,
    targetInstanceId: draft.targetInstanceId,
    cwdFolderId: draft.cwdFolderId,
    providerId: draft.providerId,
    ...(draft.modelEntityId ? { modelEntityId: draft.modelEntityId } : {}),
    ...(draft.modelName ? { modelName: draft.modelName } : {}),
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    ...(draft.permissionMode ? { permissionMode: draft.permissionMode } : {}),
  };
}

function updateInputFromDraft(draft: AgentEditorDraft): AgentDefinitionUpdateInput {
  const input = createInputFromDraft(draft);
  return {
    expectedRevision: draft.revision,
    name: input.name,
    description: input.description,
    appendedPrompt: input.appendedPrompt,
    targetInstanceId: input.targetInstanceId,
    cwdFolderId: input.cwdFolderId,
    providerId: input.providerId,
    modelEntityId: input.modelEntityId ?? null,
    modelName: input.modelName ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    permissionMode: input.permissionMode ?? null,
  };
}

// 写操作的权威结果由 Node 事件与重读收敛；这里只提交最小输入，不在本地维护第二份定义。
async function saveDraft(draft: AgentEditorDraft) {
  const editing = Boolean(draft.id);
  const nodeId = editing
    ? editingAgent.value?.nodeId
    : instances.value.find((instance) => instance.id === draft.targetInstanceId)?.nodeId;
  if (!nodeId) throw Object.assign(new Error(t("agents.errors.targetNodeUnknown")), { code: "AGENT_DEFINITION_TARGET_INSTANCE_UNKNOWN" });
  const saved = editing
    ? await updateAgentDefinition(draft.id, nodeId, updateInputFromDraft(draft))
    : await createAgentDefinition(nodeId, createInputFromDraft(draft));
  await invalidateControlPlaneDomains(queryClient, ["agents"]);
  selectedAgentKey.value = agentCatalogKey(nodeId, saved.id);
  showControlPlaneToast(t(editing ? "agents.toast.updated" : "agents.toast.created", { name: saved.name }), "success");
}

/**
 * 关系图保存整张编排：服务端负责成员有效性、环与默认编排的入口约束，客户端只提交
 * 读到的 revision 与完整图形，失败时保留本地增量并把结构化错误交给调用方展示。
 */
async function saveOrchestrationChange(change: AgentOrchestrationChange) {
  await updateAgentOrchestration(change.orchestrationId, change.nodeId, {
    expectedRevision: change.expectedRevision,
    name: change.name,
    agentIds: change.agentIds,
    edges: change.edges,
  });
  await invalidateControlPlaneDomains(queryClient, ["agents"]);
}

/** 新建编排的入口就是当前 Agent：初始图只有它自己，之后可以在它前面加成员改变顶级节点。 */
async function createOrchestration(name: string) {
  const agent = selectedAgent.value;
  if (!agent) return undefined;
  const created = await createAgentOrchestration(agent.nodeId, { name, agentIds: [agent.id], edges: [] });
  await invalidateControlPlaneDomains(queryClient, ["agents"]);
  return created;
}

const graphOrchestrationKey = ref("");
const orchestrationCreateOpen = ref(false);
const newOrchestrationName = ref("");
const creatingOrchestration = ref(false);

function openCreateOrchestration() {
  if (!selectedAgent.value) return;
  newOrchestrationName.value = t("agents.orchestration.newName", { name: selectedAgent.value.name });
  orchestrationCreateOpen.value = true;
}

async function confirmCreateOrchestration() {
  const name = newOrchestrationName.value.trim();
  if (!name || creatingOrchestration.value) return;
  creatingOrchestration.value = true;
  try {
    const created = await createOrchestration(name);
    if (created && selectedAgent.value) graphOrchestrationKey.value = agentCatalogKey(selectedAgent.value.nodeId, created.id);
    orchestrationCreateOpen.value = false;
    showControlPlaneToast(t("agents.orchestration.created", { name }), "success");
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t, t("agents.orchestration.createFailed")));
  } finally {
    creatingOrchestration.value = false;
  }
}

function openOrchestrationInGraph(orchestration: AgentCatalogOrchestration) {
  graphOrchestrationKey.value = orchestration.key;
  viewMode.value = "graph";
}

/** 列表右键的「编辑编排」与画布节点右键的「查看编排」共用：切到该 Agent 的第一张编排。 */
function openAgentOrchestrationInGraph(agentKey: string) {
  const agent = agentsByKey.value.get(agentKey);
  if (!agent) return;
  selectedAgentKey.value = agent.key;
  graphOrchestrationKey.value = agentFirstOrchestration(visibleOrchestrations.value, agent)?.key || "";
  viewMode.value = "graph";
}

/** 回详情视图；画布节点菜单会带上目标 Agent，头部切换器不带 key，只切视图。 */
function showAgentDetail(agentKey?: string) {
  if (agentKey && agentsByKey.value.has(agentKey)) selectedAgentKey.value = agentKey;
  viewMode.value = "detail";
}

/** 内容选择器只给出编排 key；画布挂载后会把它解析成当前编排，key 无效时自然回落到第一张。 */
function openOrchestrationInGraphByKey(key: string) {
  graphOrchestrationKey.value = key;
  viewMode.value = "graph";
}

function removeOrchestrationByKey(key: string) {
  const orchestration = catalog.value.orchestrations.find((candidate) => candidate.key === key);
  if (!orchestration || orchestration.isDefault) return;
  pendingDeleteOrchestration.value = orchestration;
}

async function confirmDeleteOrchestration() {
  const orchestration = pendingDeleteOrchestration.value;
  if (!orchestration || deleting.value) return;
  deleting.value = true;
  try {
    await deleteAgentOrchestration(orchestration.id, orchestration.nodeId);
    await invalidateControlPlaneDomains(queryClient, ["agents"]);
    pendingDeleteOrchestration.value = undefined;
    showControlPlaneToast(t("agents.orchestration.deleted", { name: orchestration.name }), "success");
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t, t("agents.orchestration.deleteFailed")));
  } finally {
    deleting.value = false;
  }
}

const deleting = ref(false);
const pendingDeleteAgent = ref<AgentCatalogAgent>();
const pendingDeleteOrchestration = ref<AgentCatalogOrchestration>();
const deleteReferencingOrchestrations = ref(false);

function requestDeleteAgent(agent: AgentCatalogAgent) {
  if (deleting.value) return;
  pendingDeleteAgent.value = agent;
  deleteReferencingOrchestrations.value = false;
}

async function deleteAgent(agent: AgentCatalogAgent) {
  requestDeleteAgent(agent);
}

async function confirmDeleteAgent() {
  const agent = pendingDeleteAgent.value;
  if (!agent || deleting.value) return;
  deleting.value = true;
  try {
    await deleteAgentDefinition(agent.id, agent.nodeId, {
      ...(deleteReferencingOrchestrations.value ? { referencingOrchestrations: "delete" as const } : {}),
    });
    await invalidateControlPlaneDomains(queryClient, ["agents"]);
    pendingDeleteAgent.value = undefined;
    showControlPlaneToast(t("agents.toast.deleted", { name: agent.name }), "success");
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t, t("agents.errors.deleteFailed")));
  } finally {
    deleting.value = false;
  }
}
</script>

<style scoped>
.agent-view { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; background:var(--workspace-bg); padding:12px 0; color:var(--text); }
.agent-workspace { position:relative; display:grid; grid-template-columns:var(--agent-sidebar-layout-width,minmax(240px,var(--agent-sidebar-width,300px))) 2px minmax(0,1fr); gap:0; flex:1 1 auto; min-height:0; overflow:hidden; transition:none; }
.agent-workspace-animating { transition:grid-template-columns 180ms cubic-bezier(.2,0,0,1); }
.agent-sidebar { display:grid; min-width:0; min-height:0; grid-template-rows:auto minmax(0,1fr); }
.agent-sidebar-actions { padding:0 10px; }
.agent-sidebar-filter { height:30px; margin-top:6px; }
.agent-sidebar-section { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0 4px 8px; }
.agent-sidebar-section-label { color:var(--text-muted); font-size:12px; font-weight:500; line-height:1; }
.agent-sidebar-scroll { min-width:0; min-height:0; }
.agent-sidebar-scroll-inner { min-width:0; padding:0 10px 12px; }
.agent-sidebar-scroll :deep([data-task-handoff-scroll-viewport] > div) { width:100%; min-width:0 !important; }
.agent-sidebar-resize-handle { position:relative; z-index:20; align-self:stretch; width:2px; min-width:2px; height:100%; margin-inline-end:12px; border:0; background:transparent; cursor:col-resize; padding:0; touch-action:none; }
.agent-sidebar-resize-handle::after { display:block; width:2px; height:100%; margin:0 auto; background:var(--line); content:""; opacity:.45; transition:background 120ms ease,opacity 120ms ease,box-shadow 120ms ease; }
.agent-sidebar-resize-handle:hover::after,.agent-sidebar-resize-handle:focus-visible::after,.agent-workspace[data-resizing="true"] .agent-sidebar-resize-handle::after { background:color-mix(in srgb,var(--line-strong) 72%,var(--brand-accent)); box-shadow:0 0 0 1px color-mix(in srgb,var(--line-strong) 42%,transparent); opacity:1; }
.agent-sidebar-resize-handle:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-3px; }
.agent-workspace-collapsed { grid-template-columns:var(--agent-sidebar-layout-width) 0px minmax(0,1fr); }
.agent-workspace-collapsed .agent-sidebar { position:absolute; z-index:30; inset:0 auto 0 11px; width:min(var(--agent-sidebar-width,300px),calc(100% - 11px)); border-right:1px solid var(--line); background:var(--workspace-bg); box-shadow:12px 0 32px rgb(0 0 0 / 20%); opacity:0; pointer-events:none; transform:translateX(-4px); visibility:hidden; transition:opacity 140ms ease,transform 180ms cubic-bezier(.2,0,0,1),visibility 0s linear 180ms; }
.agent-workspace-collapsed.agent-workspace-overlay-open .agent-sidebar { opacity:1; pointer-events:auto; transform:translateX(0); visibility:visible; transition-delay:0s; }
.agent-workspace-collapsed .agent-sidebar-resize-handle { position:absolute; z-index:31; inset:0 auto 0 0; width:11px; min-width:11px; height:100%; margin:0; }
.agent-workspace-collapsed .agent-sidebar-resize-handle::after { position:absolute; top:0; bottom:0; left:8px; width:2px; height:auto; margin:0; }
.agent-list-group { display:grid; gap:2px; min-width:0; }
.agent-list-group-head { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; padding:10px 8px 4px; }
.agent-list-group-label { min-width:0; color:var(--text-muted); font-size:12px; font-weight:500; line-height:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-node-load { flex:none; color:var(--text-muted); font-size:12px; font-weight:400; }
.agent-node-load[data-state="warning"] { color:var(--status-warning); }
.agent-list-item { display:flex; align-items:center; gap:8px; width:100%; min-width:0; border:0; border-radius:6px; background:transparent; color:inherit; cursor:pointer; padding:8px; text-align:left; }
.agent-list-item:hover { background:var(--sidebar-row-hover-bg,var(--surface-active)); }
.agent-list-item.active,.agent-list-item.active:hover { background:var(--sidebar-row-selected-bg,var(--surface-active)); }
.agent-list-item:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-2px; }
.agent-list-item-copy { display:grid; gap:2px; min-width:0; flex:1; line-height:1.5; }
.agent-list-item-copy strong { color:var(--text-strong); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-list-item-copy small { color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-new-button .agent-list-item-copy strong { line-height:1.3; }
.agent-list-empty { display:grid; justify-items:start; gap:4px; padding:8px; color:var(--text-muted); font-size:12px; }
.agent-content { display:flex; min-width:0; min-height:0; flex-direction:column; overflow:hidden; padding:0 20px; }
.agent-content-state { display:grid; flex:1; place-items:center; color:var(--text-muted); font-size:13px; padding:24px; }
.agent-content-graph { flex:1 1 auto; min-height:0; }
.agent-detail-scroll { flex:1; min-height:0; margin-right:-16px; }
.agent-detail-scroll :deep([data-task-handoff-scroll-viewport]) { width:calc(100% - 16px); }
.agent-detail-scroll :deep([data-task-handoff-scroll-viewport] > div) { width:100%; min-width:0 !important; }
.agent-detail-scroll-inner { display:grid; gap:12px; width:min(100%,1080px); min-width:0; margin:0 auto; padding:0 0 32px; }
.agent-detail-head { position:sticky; top:0; z-index:3; display:grid; gap:10px; min-width:0; padding-bottom:10px; background:var(--workspace-bg); }
.agent-content-header { display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); padding:0 0 12px; flex:0 0 auto; }
.agent-content-title { display:flex; flex:1 1 auto; align-items:baseline; gap:10px; min-width:0; }
.agent-content-title .agent-view-switcher { align-self:center; }
.agent-content-title h2 { margin:0; min-width:0; color:var(--text-strong); font-size:18px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 名称与 Story 头部同一交互：默认是 hover 有反馈的标签，点击后才换成同宽的输入框。 */
.agent-content-title h2.agent-title-name-field { display:grid; flex:0 1 auto; width:max-content; max-width:100%; overflow:visible; }
.agent-title-name-button,.agent-title-name-input { box-sizing:border-box; grid-area:1 / 1; min-width:0; margin:0; font:inherit; font-size:inherit; font-weight:inherit; letter-spacing:0; line-height:1.3; white-space:nowrap; }
.agent-title-name-field.editing { width:min(var(--agent-title-name-edit-width,720px),100%); }
.agent-title-name-button { display:block; width:fit-content; max-width:100%; border:0; padding:0; background:transparent; color:inherit; cursor:text; text-align:left; }
.agent-title-name-button-label { display:block; box-sizing:border-box; max-width:100%; overflow:hidden; border:1px solid transparent; border-radius:7px; color:inherit; font:inherit; padding:2px 6px 3px; text-overflow:ellipsis; }
.agent-title-name-button:hover .agent-title-name-button-label,.agent-title-name-button:focus-visible .agent-title-name-button-label { border-color:var(--line); background:var(--surface-hover); box-shadow:inset 0 1px 0 var(--workspace-grid); }
.agent-title-name-button:focus-visible { outline:none; }
.agent-title-name-button:disabled { cursor:default; color:var(--text-muted); }
.agent-title-name-input { width:100%; border:1px solid var(--brand-accent); border-radius:7px; background:var(--surface-inset); color:inherit; padding:2px 6px 3px; outline:none; box-shadow:0 0 0 3px var(--brand-accent-soft),inset 0 1px 0 var(--workspace-grid); }
.agent-title-name-input:disabled { cursor:progress; opacity:.72; }
.agent-content-title small { color:var(--text-muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.agent-content-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.agent-detail-runtime { display:flex; align-items:center; gap:7px; min-width:0; color:var(--text-muted); font-size:12px; font-weight:400; line-height:20px; }
.agent-detail-runtime-item { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-detail-runtime-separator { flex:0 0 auto; color:var(--line-strong); }
.agent-detail-description { margin:0; color:var(--text-muted); font-size:12px; line-height:1.5; }
.agent-detail-blocked { margin:0; border:1px solid var(--line-strong); border-radius:8px; padding:7px 10px; color:var(--text-strong); font-size:12px; }
.agent-card { overflow:hidden; border:1px solid var(--line); border-radius:8px; background:var(--surface-raised); }
.agent-card-header { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:38px; border-bottom:1px solid var(--line); padding:0 12px; }
.agent-card-heading { display:flex; align-items:baseline; gap:7px; min-width:0; }
.agent-card-heading h3 { margin:0; color:var(--text-strong); font-size:13px; font-weight:500; }
.agent-card-heading span { color:var(--text-muted); font-size:12px; }
.agent-card-body { display:grid; gap:8px; padding:12px; }
.agent-field-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:6px 12px; margin:0; }
.agent-field { display:flex; gap:8px; min-width:0; }
.agent-field dt { flex:none; min-width:64px; color:var(--text-muted); font-size:12px; }
.agent-field dd { margin:0; min-width:0; color:var(--text); font-size:12px; overflow-wrap:anywhere; }
.agent-mono { font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace); }
.agent-note { margin:0; color:var(--text-muted); font-size:12px; line-height:1.5; }
.agent-chip-row { display:flex; flex-wrap:wrap; gap:6px; }
.agent-chip { font-size:12px; font-weight:400; }
.agent-orchestration-chip { display:flex; align-items:center; gap:8px; min-width:0; border:1px solid var(--line); border-radius:999px; background:transparent; color:var(--text); cursor:pointer; font-size:12px; padding:4px 10px; }
.agent-orchestration-chip:hover { border-color:var(--line-strong); background:var(--surface-active); }
.agent-orchestration-chip:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
.agent-orchestration-chip > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-orchestration-chip small { color:var(--text-muted); font-size:12px; white-space:nowrap; }
.agent-dialog { width:min(440px,calc(100vw - 24px)); }
.agent-dialog-field { display:grid; gap:6px; color:var(--text-strong); font-size:12px; }
.agent-dialog-check { display:flex; align-items:flex-start; gap:7px; color:var(--text-strong); font-size:12px; }
.agent-dialog-check > span { display:grid; gap:2px; min-width:0; }
.agent-dialog-check strong { font-size:12px; font-weight:400; }
.agent-dialog-check small { color:var(--text-muted); font-size:12px; line-height:1.5; }
.agent-run-list { display:grid; }
.agent-run-item { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; border:0; border-top:1px solid var(--line); background:transparent; color:inherit; cursor:pointer; padding:10px 12px; text-align:left; }
.agent-run-item:hover,.agent-run-item.active { background:var(--surface-active); }
.agent-run-item:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-2px; }
.agent-run-copy { display:grid; gap:3px; min-width:0; }
.agent-run-copy strong { color:var(--text-strong); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-run-copy small { color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-run-status { font-size:12px; }
.agent-run-status-completed { color:var(--text-muted); }
.agent-run-status-running { color:var(--text-strong); }
.agent-run-status-failed { color:var(--text-strong); border-color:var(--line-strong); }
.agent-run-status-cancelled,.agent-run-status-queued,.agent-run-status-preparing { color:var(--text-muted); }
.agent-run-detail { display:grid; gap:8px; border-top:1px solid var(--line); padding:12px; }
.agent-run-detail-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.agent-member-tree { display:grid; gap:2px; margin:0; padding:0; list-style:none; }
.agent-member { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:2px 10px; border-radius:6px; padding:6px 8px; }
.agent-member:hover { background:var(--surface-active); }
.agent-member-child { margin-left:min(calc(var(--agent-member-depth) * 16px),96px); border-left:1px solid var(--line); border-radius:0 6px 6px 0; padding-left:10px; }
.agent-member-name { color:var(--text-strong); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-member-meta { grid-column:1; color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-member-result { grid-column:1 / -1; margin:0; color:var(--text-muted); font-size:12px; line-height:1.5; }
@media (max-width:800px) {
  .agent-view { padding:16px 0; }
  .agent-workspace { grid-template-columns:minmax(220px,38%) minmax(0,1fr); }
  .agent-sidebar-resize-handle { display:none; }
  .agent-content-header { flex-wrap:wrap; padding:0 0 14px; }
}
@media (max-width:560px) {
  .agent-view { padding:10px 0; }
  .agent-workspace { grid-template-columns:1fr; }
  .agent-sidebar { max-height:38%; border-right:0; border-bottom:1px solid var(--line); }
  .agent-member-child { margin-left:min(calc(var(--agent-member-depth) * 12px),48px); }
}
@media (prefers-reduced-motion: reduce) {
  .agent-workspace-animating,.agent-workspace-collapsed .agent-sidebar { transition:none; }
}
</style>
