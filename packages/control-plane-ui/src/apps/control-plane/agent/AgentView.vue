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
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-sm" class="agent-view-mode-button" :aria-label="t('agents.listOptions')" :title="t('agents.listOptions')"><MoreHorizontal :size="16" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" :side-offset="6">
                <DropdownMenuLabel>{{ t("agents.viewMode.label") }}</DropdownMenuLabel>
                <DropdownMenuRadioGroup :model-value="viewMode" @update:model-value="setViewMode">
                  <DropdownMenuRadioItem value="list">{{ t("agents.viewMode.list") }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="graph">{{ t("agents.viewMode.graph") }}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
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
              <button
                v-for="agent in group.agents"
                :key="agent.key"
                type="button"
                class="agent-list-item"
                :class="{ active: agent.key === selectedAgentKey }"
                :aria-pressed="agent.key === selectedAgentKey"
                @click="selectedAgentKey = agent.key"
              >
                <span class="agent-list-item-copy">
                  <strong>{{ agent.name }}</strong>
                  <small>{{ agent.instanceLabel }} · {{ agent.executable ? t("agents.availability.executable") : t("agents.availability.blocked") }}</small>
                </span>
              </button>
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
          :selected-agent-key="selectedAgentKey"
          :save="saveCallableChanges"
          @select="selectedAgentKey = $event"
        />
        <p v-else-if="!selectedAgent" class="agent-content-state">{{ t("agents.detail.empty") }}</p>
        <ScrollArea v-else type="auto" :horizontal="false" class="agent-detail-scroll">
          <div class="agent-detail-scroll-inner">
            <div class="agent-detail-head">
              <header class="agent-content-header">
                <div class="agent-content-title">
                  <h2>{{ selectedAgent.name }}</h2>
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
              <div class="agent-detail-meta">
                <Badge variant="secondary">{{ selectedAgent.provider }}</Badge>
                <Badge variant="outline">{{ selectedAgent.model }}</Badge>
                <Badge variant="outline">{{ t("agents.value.isolationInstance") }}</Badge>
              </div>
              <p class="agent-detail-description">{{ selectedAgent.description }}</p>
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
                <div class="agent-card-heading"><h3>{{ t("agents.detail.callable") }}</h3><span>{{ callableAgents.length }}</span></div>
              </div>
              <div class="agent-card-body">
                <div v-if="callableAgents.length" class="agent-chip-row">
                  <Badge v-for="agent in callableAgents" :key="agent.id" variant="outline" class="agent-chip">{{ agent.name }} · {{ agent.instanceLabel }}</Badge>
                </div>
                <p v-else class="agent-note">{{ t("agents.detail.callableEmpty") }}</p>
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
      :submitting="launchingRun"
      :submit="launchManualRun"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import type { AgentDefinitionCreateInput, AgentDefinitionUpdateInput, AgentProcessSandbox, AgentWorkspaceMaterializer } from "@task-handoff/protocol/agent-definitions";
import { MoreHorizontal, Pencil, Play, Plus, RefreshCw, Trash2, X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cancelAgentRun, createAgentDefinition, createManualAgentRun, deleteAgentDefinition, updateAgentDefinition, useInstanceBoardQuery } from "@/api/queries";
import { allNodesVisible, nodeIsVisible, type NodeVisibilityFilter } from "@task-handoff/control-plane-client";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { useResizablePane } from "../shared/useResizablePane";
import AgentEditor from "./AgentEditor.vue";
import AgentRunDialog from "./AgentRunDialog.vue";
import AgentGraph, { type AgentCallableChange } from "./AgentGraph.vue";
import { agentCatalogGroups, agentCatalogKey, agentCatalogMemberRows } from "./agentCatalog";
import type { AgentBlockedCode, AgentCatalogAgent, AgentEditorDraft } from "./agentCatalogTypes";
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
const viewMode = ref<"list" | "graph">("list");
const editorOpen = ref(false);
const editingAgent = ref<AgentCatalogAgent>();
const board = useInstanceBoardQuery();
const instances = computed(() => board.data.value || []);

// 目录是视图的唯一数据入口：定义来自各 Node 的权威查询，provider 展示名在投影边界注入。
const { catalog, loadingNodeIds, unavailableNodeIds, isPending, refetch } = useAgentCatalog({
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
const callableAgents = computed(() => (selectedAgent.value?.callableAgentIds ?? []).flatMap((id) => {
  const agent = selectedAgent.value ? agentsByKey.value.get(agentCatalogKey(selectedAgent.value.nodeId, id)) : undefined;
  return agent ? [agent] : [];
}));
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
const canLaunchSelectedAgent = computed(() => Boolean(
  selectedAgent.value?.nodeOnline
  && selectedAgent.value.executable
  && selectedAgent.value.runsSupported
  && selectedAgent.value.manualRunsSupported
));
const manualRunUnavailableLabel = computed(() => {
  const agent = selectedAgent.value;
  if (!agent || canLaunchSelectedAgent.value) return "";
  if (!agent.manualRunsSupported) return t("agents.manualRun.unsupported");
  return blockedLabel(agent) || t("agents.manualRun.unavailable");
});

function openManualRun(agent: AgentCatalogAgent) {
  if (!canLaunchSelectedAgent.value) return;
  manualRunAgent.value = agent;
  manualRunOpen.value = true;
}

async function launchManualRun(prompt: string) {
  const agent = manualRunAgent.value;
  if (!agent || launchingRun.value) return;
  launchingRun.value = true;
  try {
    const run = await createManualAgentRun(agent.nodeId, {
      clientRequestId: createBrowserUuid(),
      agentId: agent.id,
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

// Keep the pane bound to a real mode: a single-value radio group must not leave the pane unset.
function setViewMode(value: unknown) {
  if (value === "list" || value === "graph") viewMode.value = value;
}

function openEdit(agent: AgentCatalogAgent) {
  editingAgent.value = agent;
  editorOpen.value = true;
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
    callableAgentIds: draft.callableAgentIds,
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
    callableAgentIds: input.callableAgentIds,
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
 * 关系图的一次保存按 Agent 逐个提交权威可调用集合：服务端负责环、自引用与引用有效性，
 * 失败也先把界面收敛回权威集合，只把结构化错误交给调用方展示。
 */
async function saveCallableChanges(changes: AgentCallableChange[]) {
  const failures: unknown[] = [];
  for (const change of changes) {
    const agent = agentsByKey.value.get(agentCatalogKey(change.nodeId, change.agentId));
    if (!agent) continue;
    try {
      await updateAgentDefinition(agent.id, agent.nodeId, {
        expectedRevision: agent.revision,
        callableAgentIds: change.callableAgentIds,
      });
    } catch (cause) {
      failures.push(cause);
    }
  }
  await invalidateControlPlaneDomains(queryClient, ["agents"]);
  if (failures.length) throw failures[0];
}

const deleting = ref(false);

async function deleteAgent(agent: AgentCatalogAgent) {
  if (deleting.value || !window.confirm(t("agents.confirm.deleteAgent", { name: agent.name }))) return;
  deleting.value = true;
  try {
    await deleteAgentDefinition(agent.id, agent.nodeId);
    await invalidateControlPlaneDomains(queryClient, ["agents"]);
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
.agent-view-mode-button { width:26px; height:26px; color:var(--text-muted); }
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
.agent-list-item-copy { display:grid; gap:2px; min-width:0; flex:1; }
.agent-list-item-copy strong { color:var(--text-strong); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-list-item-copy small { color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-new-button { padding-block:11px; }
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
.agent-content-title h2 { margin:0; min-width:0; color:var(--text-strong); font-size:18px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-content-title small { color:var(--text-muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.agent-content-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.agent-detail-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
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
