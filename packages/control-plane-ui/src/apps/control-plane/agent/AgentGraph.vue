<template>
  <section class="agent-graph" :aria-label="t('agents.viewMode.graph')">
    <div class="agent-graph-toolbar">
      <p class="agent-graph-hint">{{ t("agents.graph.hint") }}</p>
      <div class="agent-graph-scope">
        <ControlPlaneSelect v-model="scope" class="agent-graph-scope-select" :aria-label="t('agents.graph.scopeLabel')">
          <ControlPlaneSelectItem value="entry">{{ t("agents.graph.scope.entry") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="participating">{{ t("agents.graph.scope.participating") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect
          :model-value="activeOrchestration?.key || ''"
          class="agent-graph-orchestration-select"
          :disabled="!scopedOrchestrations.length"
          :placeholder="t('agents.graph.orchestrationEmpty')"
          :aria-label="t('agents.graph.orchestrationLabel')"
          @update:model-value="selectOrchestration"
        >
          <ControlPlaneSelectItem v-for="orchestration in scopedOrchestrations" :key="orchestration.key" :value="orchestration.key">
            {{ orchestrationLabel(orchestration) }}
          </ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </div>
      <div class="agent-graph-actions">
        <span class="agent-graph-state" :data-dirty="dirtyCount ? 'true' : undefined">
          {{ dirtyCount ? t("agents.graph.dirty", { count: dirtyCount }) : t("agents.graph.clean") }}
        </span>
        <Button variant="outline" size="sm" :disabled="!focusAgent?.nodeOnline" @click="$emit('create')">
          <Plus :size="14" />
          <span>{{ t("agents.graph.createOrchestration") }}</span>
        </Button>
        <Button v-if="activeOrchestration && !activeOrchestration.isDefault" variant="outline" size="sm" :disabled="!editable || deleting" @click="$emit('remove', activeOrchestration.key)">
          <Trash2 :size="14" />
          <span>{{ t("agents.graph.deleteOrchestration") }}</span>
        </Button>
        <Button variant="outline" size="sm" :disabled="!dirtyCount" @click="reset">
          <RotateCcw :size="14" />
          <span>{{ t("agents.graph.reset") }}</span>
        </Button>
        <Button size="sm" :disabled="!dirtyCount || saving || !editable" @click="save">
          <Save :size="14" />
          <span>{{ saving ? t("agents.graph.saving") : t("agents.graph.save") }}</span>
        </Button>
      </div>
    </div>
    <div v-if="activeOrchestration" class="agent-graph-meta">
      <Input
        v-model="orchestrationName"
        class="agent-graph-name"
        :disabled="!editable"
        :aria-label="t('agents.graph.orchestrationName')"
        :placeholder="t('agents.graph.orchestrationNamePlaceholder')"
      />
      <Badge v-if="activeOrchestration.isDefault" variant="outline" class="agent-graph-badge">{{ t("agents.graph.defaultBadge") }}</Badge>
      <span v-if="activeOrchestration.missingAgentIds.length" class="agent-graph-state" data-dirty="true">
        {{ t("agents.graph.missingMembers", { count: activeOrchestration.missingAgentIds.length }) }}
      </span>
    </div>
    <p v-if="rejectedMessage" class="agent-graph-rejected" role="alert">{{ rejectedMessage }}</p>
    <p v-if="!agents.length" class="agent-graph-empty">{{ t("agents.graph.empty") }}</p>
    <p v-else-if="!activeOrchestration" class="agent-graph-empty">{{ t("agents.graph.orchestrationMissing") }}</p>
    <div v-else class="agent-graph-stage">
      <VueFlow
        v-model:nodes="flowNodes"
        v-model:edges="flowEdges"
        class="agent-graph-canvas"
        :min-zoom="0.3"
        :max-zoom="1.6"
        :node-drag-threshold="DRAG_THRESHOLD"
        :delete-key-code="DELETE_KEY_CODES"
        default-marker-color="currentColor"
        @connect="connect"
        @connect-start="onConnectStart"
        @connect-end="onConnectEnd"
        @edges-change="onEdgesChange"
        @node-click="onNodeClick"
        @edge-click="onEdgeClick"
      >
        <Background variant="dots" :gap="22" :size="1.6" />
        <Controls position="bottom-right" :show-interactive="false" />
        <template #node-agent="nodeProps">
          <ContextMenu>
            <ContextMenuTrigger as-child>
              <div
                class="agent-graph-node"
                :class="{ 'is-selected': nodeProps.id === focusKey, 'is-blocked': !nodeProps.data.executable }"
                :data-agent-node="nodeProps.id"
              >
                <span class="agent-graph-node-name">{{ nodeProps.data.name }}</span>
                <span class="agent-graph-node-meta">{{ nodeProps.data.meta }}</span>
                <button
                  v-if="editable && nodeProps.data.removable"
                  type="button"
                  class="agent-graph-remove-node"
                  :aria-label="t('agents.graph.removeMember', { name: nodeProps.data.name })"
                  :title="t('agents.graph.removeMember', { name: nodeProps.data.name })"
                  @click.stop="removeMember(nodeProps.data.agentId)"
                >
                  <X :size="11" aria-hidden="true" />
                </button>
                <Handle
                  v-if="!nodeProps.data.missing"
                  type="target"
                  :position="Position.Top"
                  class="agent-graph-handle agent-graph-handle-in"
                  :aria-label="t('agents.graph.linkTo', { name: nodeProps.data.name })"
                />
                <Handle
                  v-if="!nodeProps.data.missing"
                  type="source"
                  :position="Position.Bottom"
                  class="agent-graph-handle agent-graph-handle-out"
                  :aria-label="t('agents.graph.linkFrom', { name: nodeProps.data.name })"
                >
                  <Popover
                    v-if="nodeProps.data.online"
                    :open="addPickerKey === nodeProps.id"
                    @update:open="(open: boolean) => setAddPicker(nodeProps.id, open)"
                  >
                    <PopoverTrigger as-child>
                      <button
                        type="button"
                        class="agent-graph-add"
                        :aria-label="t('agents.graph.addCallable', { name: nodeProps.data.name })"
                        @click.stop
                      >
                        <Plus :size="11" aria-hidden="true" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent class="agent-graph-add-popover p-0" :side-offset="8" :collision-padding="12">
                      <Command @update:model-value="(value: unknown) => chooseCallable(nodeProps.id, value)">
                        <CommandInput v-if="addOptions(nodeProps.id).length" class="agent-graph-add-search" :placeholder="t('agents.graph.addSearch')" />
                        <ScrollArea class="agent-graph-add-scroll" :horizontal="false">
                          <CommandList class="agent-graph-add-list" :scrollable="false">
                            <CommandEmpty class="agent-graph-add-empty">{{ t("agents.graph.addNoMatch") }}</CommandEmpty>
                            <CommandGroup v-if="addOptions(nodeProps.id).length">
                              <CommandItem
                                v-for="option in addOptions(nodeProps.id)"
                                :key="option.key"
                                :value="option.key"
                                :disabled="option.disabled"
                                class="agent-graph-add-option"
                              >
                                <span class="agent-graph-add-option-name">{{ option.name }}</span>
                                <span v-if="option.state" class="agent-graph-add-option-state">{{ option.state }}</span>
                              </CommandItem>
                            </CommandGroup>
                            <p v-else class="agent-graph-add-empty">{{ t("agents.graph.addEmpty") }}</p>
                          </CommandList>
                        </ScrollArea>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </Handle>
              </div>
            </ContextMenuTrigger>
            <AgentContextMenu
              :can-run="canRunMember(nodeProps.data.agentId)"
              :editable="editable && !nodeProps.data.missing"
              :deleting="deleting"
              @run="runMember(nodeProps.data.agentId)"
              @edit="editMember(nodeProps.data.agentId)"
              @delete="deleteMember(nodeProps.data.agentId)"
            />
          </ContextMenu>
        </template>
        <template #edge-agent-callable="edgeProps">
          <AgentGraphEdge
            :id="edgeProps.id"
            :source-x="edgeProps.sourceX"
            :source-y="edgeProps.sourceY"
            :target-x="edgeProps.targetX"
            :target-y="edgeProps.targetY"
            :source-position="edgeProps.sourcePosition"
            :target-position="edgeProps.targetPosition"
            :marker-start="edgeProps.markerStart"
            :marker-end="edgeProps.markerEnd"
            :interaction-width="edgeProps.interactionWidth"
            :removable="editable"
            :remove-label="t('agents.graph.removeEdge', { from: nameOfFlowKey(edgeProps.source), to: nameOfFlowKey(edgeProps.target) })"
            @remove="removeEdgeById(edgeProps.id)"
          />
        </template>
      </VueFlow>
    </div>
  </section>
</template>

<script setup lang="ts">
// 画布用 @vue-flow/core（MIT，Vue 3 版 React Flow）承载缩放平移、节点拖拽与连线手柄。画布一次只投影一张
// 权威编排：成员节点、入口（入度为 0 的顶级节点）与调用边都来自 Node Agent；本地只保存这张编排的未保存
// 增量，保存时整张提交并带 revision 做乐观并发控制。画布的展示范围只决定看哪张编排，不裁剪编辑内容。
import { computed, reactive, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, RotateCcw, Save, Trash2, X } from "@lucide/vue";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { Handle, Position, VueFlow, useVueFlow } from "@vue-flow/core";
import type { Connection, Edge, EdgeChange, EdgeMouseEvent, Node, NodeMouseEvent } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/controls/dist/style.css";
import type { AgentOrchestrationEdge } from "@task-handoff/protocol/agent-orchestrations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { translateApiError } from "@/i18n/apiError";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import AgentContextMenu from "./AgentContextMenu.vue";
import AgentGraphEdge from "./AgentGraphEdge.vue";
import { agentEntryOrchestrations, agentManualRunAvailable, agentParticipatingOrchestrations, agentRunOrchestrations, orchestrationAgentCandidates } from "./agentCatalog";
import type { AgentCatalogAgent, AgentCatalogNode, AgentCatalogOrchestration } from "./agentCatalogTypes";

/** 关系图一次保存提交的整张编排内容（节点集合与边整体替换，带读到的 revision）。 */
export type AgentOrchestrationChange = {
  nodeId: string;
  orchestrationId: string;
  name: string;
  expectedRevision: string;
  agentIds: string[];
  edges: AgentOrchestrationEdge[];
};

/**
 * 某张编排的本地未保存增量。以「权威内容 + 增量」投影，与画布当前选中的编排无关，
 * 切换编排不会丢改动；权威 revision 变化（保存成功或外部更新）时对应增量被丢弃。
 */
type OrchestrationEdit = {
  name?: string;
  addedAgentIds: string[];
  removedAgentIds: string[];
  addedEdges: string[];
  removedEdges: string[];
};

type AgentNodeData = { agentId: string; name: string; meta: string; executable: boolean; online: boolean; missing: boolean; removable: boolean };
/** 分层布局用的有向邻接表，键都是画布节点 id。 */
type LayerEdges = { parents: Map<string, string[]>; children: Map<string, string[]> };
/** 圆点「+」列表里的候选 Agent：已连接或会成环的候选只展示原因，不可选。 */
type CallableOption = { key: string; name: string; disabled: boolean; state: string };

const DRAG_THRESHOLD = 4;
const NODE_WIDTH = 200;
const NODE_HEIGHT = 58;
const SIBLING_GAP = 40;
const LAYER_GAP = 88;
const CANVAS_ORIGIN = 48;
const FIT_VIEW_PADDING = 0.18;
/** 初始视角的缩放上限：小图也保持较小的初始缩放，先看清整棵树再看细节。 */
const FIT_VIEW_MAX_ZOOM = 0.85;
const LAYOUT_RELAXATION_PASSES = 24;
const EDGE_SEPARATOR = "\u001f";
/** 自定义边类型：模板里对应 #edge-agent-callable，用来在边中点叠加删除入口。 */
const EDGE_TYPE = "agent-callable";
const DELETE_KEY_CODES = ["Delete", "Backspace"];
const MISSING_NODE_PREFIX = "missing:";

const props = defineProps<{
  agents: AgentCatalogAgent[];
  nodes: AgentCatalogNode[];
  orchestrations: AgentCatalogOrchestration[];
  selectedAgentKey: string;
  /** 视图指定的当前编排（例如从详情卡片跳转）；画布内部切换会同步回来。 */
  orchestrationKey?: string;
  /** 上层正在删除某个 Agent：节点卡片菜单的删除入口同步禁用，避免重复提交。 */
  deleting: boolean;
  /** 提交实现由视图注入：画布只负责把权威编排投影成图并算出整张编排的差异，不自己维护图状态。 */
  save: (change: AgentOrchestrationChange) => Promise<void>;
}>();

const emit = defineEmits<{
  select: [agentKey: string];
  run: [agentKey: string];
  edit: [agentKey: string];
  delete: [agentKey: string];
  remove: [orchestrationKey: string];
  create: [];
  "orchestration-change": [orchestrationKey: string];
}>();

const { t, locale } = useI18n();
// 用 store 的 fitView 控制初始与切换选中 Agent 后的适配视图：fitViewOnInit 不能带参数，
// 这里用 capped maxZoom 让初始缩放明显小于默认视角。
const { fitView, connectionEndHandle, onNodesInitialized, onMoveStart } = useVueFlow();

// 画布节点与边整体替换，不需要深度响应式：deep ref 会对 Vue Flow 的递归泛型做 UnwrapRef，
// 在当前 TypeScript 下直接触发 TS2589，因此这两个状态用 shallowRef。
const flowNodes = shallowRef<Node[]>([]);
const flowEdges = shallowRef<Edge[]>([]);
const rejectedMessage = ref("");
const scope = ref<"entry" | "participating">("entry");
const activeKey = ref("");
const orchestrationName = ref("");
// 拖拽连线是否落在了画布内的 Agent 上：落在空白处时给出画布范围的说明，不静默无响应。
let connectDragSettled = false;
// 连线起点：按下后没有位移的抬手是点击（打开「+」列表），不能当成拖拽落空。
let connectStartPoint: { x: number; y: number } | null = null;
// 当前打开「+」列表的 Agent：同一时刻只允许一个，切换选中或平移画布都会关掉它。
const addPickerKey = ref("");

const focusKey = computed(() => (agentByKey(props.selectedAgentKey) ? props.selectedAgentKey : props.agents[0]?.key || ""));
const focusAgent = computed(() => agentByKey(focusKey.value));

/** 参与/顶级两个作用域都为空时退回到另一个作用域，保证选中 Agent 时画布不会无故为空。 */
const scopedOrchestrations = computed(() => {
  const agent = focusAgent.value;
  if (!agent) return props.orchestrations;
  const primary = scope.value === "entry" ? agentEntryOrchestrations(props.orchestrations, agent) : agentParticipatingOrchestrations(props.orchestrations, agent);
  const fallback = scope.value === "entry" ? agentParticipatingOrchestrations(props.orchestrations, agent) : agentEntryOrchestrations(props.orchestrations, agent);
  return primary.length ? primary : fallback;
});

const activeOrchestration = computed(() => {
  const scoped = scopedOrchestrations.value;
  return scoped.find((orchestration) => orchestration.key === activeKey.value) || scoped[0];
});

const editable = computed(() => activeOrchestration.value?.editable === true);

// 本地增量按编排 key 存储：切换编排或作用域不会丢未保存的节点、边与名称。
const edits = reactive(new Map<string, OrchestrationEdit>());
const authorityScopes = computed(() => props.orchestrations.map((orchestration) => `${orchestration.key}${EDGE_SEPARATOR}${orchestration.revision}`).join("\n"));

function emptyEdit(): OrchestrationEdit {
  return { addedAgentIds: [], removedAgentIds: [], addedEdges: [], removedEdges: [] };
}

function editFor(orchestrationKey: string): OrchestrationEdit | undefined {
  const edit = edits.get(orchestrationKey);
  if (!edit || !hasEdit(edit)) return undefined;
  return edit;
}

function hasEdit(edit: OrchestrationEdit) {
  return edit.name !== undefined
    || edit.addedAgentIds.length > 0
    || edit.removedAgentIds.length > 0
    || edit.addedEdges.length > 0
    || edit.removedEdges.length > 0;
}

function patchEdit(orchestrationKey: string, patch: Partial<OrchestrationEdit>) {
  const current = edits.get(orchestrationKey) ?? emptyEdit();
  const next = { ...current, ...patch };
  if (hasEdit(next)) edits.set(orchestrationKey, next);
  else edits.delete(orchestrationKey);
}

function edgeKey(fromAgentId: string, toAgentId: string) {
  return `${fromAgentId}${EDGE_SEPARATOR}${toAgentId}`;
}

function edgeFromKey(key: string): AgentOrchestrationEdge {
  const [fromAgentId, toAgentId] = key.split(EDGE_SEPARATOR);
  return { fromAgentId, toAgentId };
}

function effectiveName(orchestration: AgentCatalogOrchestration) {
  return editFor(orchestration.key)?.name ?? orchestration.name;
}

function effectiveAgentIds(orchestration: AgentCatalogOrchestration) {
  const edit = editFor(orchestration.key);
  const removed = new Set(edit?.removedAgentIds ?? []);
  return [...orchestration.agentIds.filter((agentId) => !removed.has(agentId)), ...(edit?.addedAgentIds ?? [])];
}

function effectiveEdgeKeys(orchestration: AgentCatalogOrchestration) {
  const edit = editFor(orchestration.key);
  const members = new Set(effectiveAgentIds(orchestration));
  const removed = new Set(edit?.removedEdges ?? []);
  const keys = new Set([
    ...orchestration.edges.map((edge) => edgeKey(edge.fromAgentId, edge.toAgentId)).filter((key) => !removed.has(key)),
    ...(edit?.addedEdges ?? []),
  ]);
  return [...keys].filter((key) => {
    const edge = edgeFromKey(key);
    return members.has(edge.fromAgentId) && members.has(edge.toAgentId);
  }).sort();
}

/** 画布节点 id：可解析的成员用目录 key，已删除定义的悬挂成员用占位节点 id，保证仍可移除。 */
function flowKeyByAgentId(orchestration: AgentCatalogOrchestration) {
  const keys = new Map<string, string>();
  for (const agentId of effectiveAgentIds(orchestration)) {
    const agent = agentByCatalogId(orchestration.nodeId, agentId);
    keys.set(agentId, agent ? agent.key : `${MISSING_NODE_PREFIX}${agentId}`);
  }
  return keys;
}

function agentByCatalogId(nodeId: string, agentId: string) {
  return props.agents.find((agent) => agent.nodeId === nodeId && agent.id === agentId);
}

function agentByKey(key: string) {
  return props.agents.find((agent) => agent.key === key);
}

/** 画布节点菜单的运行/编辑/删除都回到同一份目录对象，入口判定与列表行共用同一函数。 */
function canRunMember(agentId: string) {
  const orchestration = activeOrchestration.value;
  const agent = orchestration ? agentByCatalogId(orchestration.nodeId, agentId) : undefined;
  return Boolean(agent) && agentManualRunAvailable(agent, agentRunOrchestrations(props.orchestrations, agent!));
}

function runMember(agentId: string) {
  const orchestration = activeOrchestration.value;
  const agent = orchestration ? agentByCatalogId(orchestration.nodeId, agentId) : undefined;
  if (agent) emit("run", agent.key);
}

function editMember(agentId: string) {
  const orchestration = activeOrchestration.value;
  const agent = orchestration ? agentByCatalogId(orchestration.nodeId, agentId) : undefined;
  if (agent) emit("edit", agent.key);
}

function deleteMember(agentId: string) {
  const orchestration = activeOrchestration.value;
  const agent = orchestration ? agentByCatalogId(orchestration.nodeId, agentId) : undefined;
  if (agent) emit("delete", agent.key);
}

function orchestrationLabel(orchestration: AgentCatalogOrchestration) {
  return orchestration.isDefault ? t("agents.graph.orchestrationDefaultLabel", { name: orchestration.name }) : orchestration.name;
}

const dirtyCount = computed(() => {
  const orchestration = activeOrchestration.value;
  if (!orchestration) return 0;
  const idsBefore = new Set(orchestration.agentIds);
  const idsAfter = new Set(effectiveAgentIds(orchestration));
  const edgesBefore = new Set(orchestration.edges.map((edge) => edgeKey(edge.fromAgentId, edge.toAgentId)));
  const edgesAfter = new Set(effectiveEdgeKeys(orchestration));
  let count = 0;
  for (const id of idsAfter) if (!idsBefore.has(id)) count += 1;
  for (const id of idsBefore) if (!idsAfter.has(id)) count += 1;
  for (const key of edgesAfter) if (!edgesBefore.has(key)) count += 1;
  for (const key of edgesBefore) if (!edgesAfter.has(key)) count += 1;
  if (effectiveName(orchestration) !== orchestration.name) count += 1;
  return count;
});

/** 画布节点：权威成员 + 本地增量，悬挂成员保留占位卡片以便清理。 */
const memberViews = computed(() => {
  const orchestration = activeOrchestration.value;
  if (!orchestration) return [];
  const keys = flowKeyByAgentId(orchestration);
  return [...keys.entries()].map(([agentId, key]) => {
    const agent = agentByCatalogId(orchestration.nodeId, agentId);
    return {
      agentId,
      key,
      name: agent?.name ?? agentId,
      meta: agent ? agent.instanceLabel : t("agents.graph.missingAgent"),
      executable: agent?.executable === true,
      online: agent?.nodeOnline === true,
      missing: !agent,
      removable: agentId !== orchestration.ownerAgentId,
    };
  });
});

const activeEdgeKeys = computed(() => (activeOrchestration.value ? effectiveEdgeKeys(activeOrchestration.value) : []));

// 画布只在投影内容真的变化时重建：目录因为实例状态等无关事件重算时，不能丢掉用户手动摆放的节点位置。
const layoutKey = computed(() => {
  const orchestration = activeOrchestration.value;
  if (!orchestration) return "";
  return [
    orchestration.key,
    orchestration.revision,
    scope.value,
    ...memberViews.value.map((member) => `${member.key}${EDGE_SEPARATOR}${member.name}${EDGE_SEPARATOR}${member.meta}${EDGE_SEPARATOR}${member.executable ? 1 : 0}${EDGE_SEPARATOR}${member.removable ? 1 : 0}`),
    ...activeEdgeKeys.value,
  ].join("\n");
});

const projectionKey = computed(() => `${activeOrchestration.value?.key || ""}\n${activeEdgeKeys.value.join("\n")}`);

watch(layoutKey, () => {
  flowNodes.value = layoutNodes(memberViews.value, activeEdgeKeys.value);
  // 布局重建后节点位置整体变化，已打开的「+」列表会脱锚，直接关掉。
  addPickerKey.value = "";
}, { immediate: true });

watch(projectionKey, () => {
  flowEdges.value = activeEdgeKeys.value.map((key) => {
    const edge = edgeFromKey(key);
    return createEdge(edge.fromAgentId, edge.toAgentId);
  });
}, { immediate: true });

// 权威 revision 变化（保存成功或外部更新）后丢弃对应编排的本地增量，其余编排的未保存改动保留。
watch(authorityScopes, (next, previous) => {
  const previousRevisions = new Map((previous || "").split("\n").filter(Boolean).map((line) => line.split(EDGE_SEPARATOR) as [string, string]));
  for (const line of next.split("\n").filter(Boolean)) {
    const [key, revision] = line.split(EDGE_SEPARATOR);
    if (previousRevisions.get(key) === revision) continue;
    edits.delete(key);
  }
}, { immediate: true });

// 选中 Agent 或权威列表变化后收敛当前编排：保留仍然可见的选中项，否则回到作用域内的第一张。
watch([() => props.selectedAgentKey, scopedOrchestrations, () => props.orchestrations], () => {
  const scoped = scopedOrchestrations.value;
  if (scoped.some((orchestration) => orchestration.key === activeKey.value)) return;
  activeKey.value = scoped[0]?.key || "";
}, { immediate: true });

// 视图指定编排（详情卡片跳转）时同步到画布；画布内部切换通过事件回传给视图。
watch(() => props.orchestrationKey, (key) => {
  if (!key || key === activeKey.value) return;
  if (props.orchestrations.some((orchestration) => orchestration.key === key)) activeKey.value = key;
});

watch(activeKey, (key) => {
  if (key !== props.orchestrationKey) emit("orchestration-change", key);
});

// 编排切换后把名称草稿重置到该编排的当前投影，本地重命名不会串到另一张编排。
watch(activeKey, () => {
  orchestrationName.value = activeOrchestration.value ? effectiveName(activeOrchestration.value) : "";
}, { immediate: true });

watch(orchestrationName, (value) => {
  const orchestration = activeOrchestration.value;
  if (!orchestration || !editable.value) return;
  if (value === orchestration.name) {
    const edit = edits.get(orchestration.key);
    if (edit?.name !== undefined) patchEdit(orchestration.key, { name: undefined });
    return;
  }
  patchEdit(orchestration.key, { name: value });
});

// 边由对象字面量创建，切换语言时单独刷新它们的无障碍名称，避免为此重建整张图、丢掉未保存的改动。
watch(locale, () => {
  flowEdges.value = flowEdges.value.map((edge) => ({ ...edge, ariaLabel: edgeAriaLabel(edge.source, edge.target) }));
});

// 节点测量完成后适配视图：初次进入和切换选中 Agent 时都按 capped maxZoom 缩小视角。
onNodesInitialized(() => {
  void fitView({ padding: FIT_VIEW_PADDING, maxZoom: FIT_VIEW_MAX_ZOOM, duration: 0 });
});

// 浮层锚在画布内的节点上，平移缩放后位置会脱锚，直接关掉「+」列表。
onMoveStart(() => {
  addPickerKey.value = "";
});

/** 按调用关系分层：入度为 0 的根在第一层，其余节点取父节点深度的最大值加一，得到从上到下的树形层次。 */
function buildLayers(keys: string[], edges: LayerEdges): string[][] {
  const depth = new Map(keys.map((key) => [key, 0]));
  const indegree = new Map(keys.map((key) => [key, (edges.parents.get(key) || []).length]));
  const pending = keys.filter((key) => indegree.get(key) === 0);
  const settled = new Set<string>();
  while (pending.length) {
    const key = pending.shift() as string;
    settled.add(key);
    for (const child of edges.children.get(key) || []) {
      depth.set(child, Math.max(depth.get(child) ?? 0, (depth.get(key) ?? 0) + 1));
      indegree.set(child, (indegree.get(child) ?? 1) - 1);
      if (indegree.get(child) === 0) pending.push(child);
    }
  }
  // 调用关系由 node-agent 保证无环；遗留的环状数据只影响自身落层，不阻断布局。
  const leftover = keys.filter((key) => !settled.has(key));
  if (leftover.length) {
    const last = Math.max(0, ...keys.filter((key) => settled.has(key)).map((key) => depth.get(key) ?? 0)) + 1;
    for (const key of leftover) depth.set(key, last);
  }
  const grouped = new Map<number, string[]>();
  for (const key of keys) {
    const index = depth.get(key) ?? 0;
    grouped.set(index, [...(grouped.get(index) || []), key]);
  }
  return [...grouped.keys()].sort((left, right) => left - right).map((index) => grouped.get(index) as string[]);
}

function buildLayerEdges(keys: string[], flowEdges: Edge[]): LayerEdges {
  const parents = new Map(keys.map((key) => [key, [] as string[]]));
  const children = new Map(keys.map((key) => [key, [] as string[]]));
  for (const edge of flowEdges) {
    if (!children.has(edge.source) || !parents.has(edge.target)) continue;
    children.get(edge.source)!.push(edge.target);
    parents.get(edge.target)!.push(edge.source);
  }
  return { parents, children };
}

/** 层内顺序用父/子位置的重心做几轮扫描减少交叉，稳定兜底是目录顺序。 */
function orderLayers(layers: string[][], edges: LayerEdges): string[][] {
  const position = new Map<string, number>();
  layers.forEach((layer) => layer.forEach((key, index) => position.set(key, index)));
  const sweep = (layer: string[], neighborsOf: (key: string) => string[]) => {
    const barycenter = new Map(layer.map((key) => {
      const positions = neighborsOf(key).map((neighbor) => position.get(neighbor)).filter((index): index is number => index !== undefined);
      const current = position.get(key) ?? 0;
      return [key, positions.length ? positions.reduce((total, index) => total + index, 0) / positions.length : current] as const;
    }));
    const next = [...layer].sort((left, right) => (barycenter.get(left) ?? 0) - (barycenter.get(right) ?? 0));
    next.forEach((key, index) => position.set(key, index));
    return next;
  };
  for (let pass = 0; pass < 3; pass += 1) {
    for (let depth = 1; depth < layers.length; depth += 1) layers[depth] = sweep(layers[depth], (key) => edges.parents.get(key) || []);
    for (let depth = layers.length - 2; depth >= 0; depth -= 1) layers[depth] = sweep(layers[depth], (key) => edges.children.get(key) || []);
  }
  return layers;
}

/** 分层确定后做几轮松弛：节点向相邻层节点的平均位置靠拢，按层消除重叠后再把整层重心对齐，
 *  父节点因此稳定地落在子节点上方中央，得到从上到下的树形排布。 */
function layeredColumns(layers: string[][], edges: LayerEdges): Map<string, number> {
  const step = NODE_WIDTH + SIBLING_GAP;
  const columns = new Map<string, number>();
  layers.forEach((layer) => layer.forEach((key, index) => columns.set(key, index * step)));
  for (let pass = 0; pass < LAYOUT_RELAXATION_PASSES; pass += 1) {
    const desired = new Map<string, number>();
    for (const layer of layers) {
      for (const key of layer) {
        const neighbors = [...(edges.parents.get(key) || []), ...(edges.children.get(key) || [])].map((neighbor) => columns.get(neighbor) ?? 0);
        desired.set(key, neighbors.length ? neighbors.reduce((total, value) => total + value, 0) / neighbors.length : columns.get(key) ?? 0);
      }
    }
    for (const layer of layers) {
      if (!layer.length) continue;
      const wanted = layer.map((key) => (columns.get(key) ?? 0) + ((desired.get(key) ?? 0) - (columns.get(key) ?? 0)) * 0.5);
      const packed: number[] = [];
      wanted.forEach((value, index) => packed.push(index ? Math.max(value, packed[index - 1] + step) : value));
      const shift = average(wanted) - average(packed);
      layer.forEach((key, index) => columns.set(key, packed[index] + shift));
    }
  }
  const min = Math.min(...columns.values());
  for (const [key, value] of columns) columns.set(key, value - min);
  return columns;
}

function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function layoutNodes(members: Array<{ agentId: string; key: string; name: string; meta: string; executable: boolean; online: boolean; missing: boolean; removable: boolean }>, edgeKeys: string[]): Node[] {
  if (!members.length) return [];
  const keys = members.map((member) => member.key);
  const keyByAgentId = new Map(members.map((member) => [member.agentId, member.key]));
  const flowEdgeList: Edge[] = edgeKeys.flatMap((key) => {
    const edge = edgeFromKey(key);
    const source = keyByAgentId.get(edge.fromAgentId);
    const target = keyByAgentId.get(edge.toAgentId);
    return source && target ? [{ id: key, source, target }] : [];
  });
  const edges = buildLayerEdges(keys, flowEdgeList);
  const layers = orderLayers(buildLayers(keys, edges), edges);
  const columns = layeredColumns(layers, edges);
  const depth = new Map<string, number>();
  layers.forEach((layer, index) => layer.forEach((key) => depth.set(key, index)));
  const rowStep = NODE_HEIGHT + LAYER_GAP;
  return members.map((member) => ({
    id: member.key,
    type: "agent",
    position: {
      x: CANVAS_ORIGIN + (columns.get(member.key) ?? 0),
      y: CANVAS_ORIGIN + (depth.get(member.key) ?? 0) * rowStep,
    },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    deletable: false,
    ariaLabel: member.name,
    connectable: member.online && !member.missing,
    data: {
      agentId: member.agentId,
      name: member.name,
      meta: member.meta,
      executable: member.executable,
      online: member.online,
      missing: member.missing,
      removable: member.removable,
    } satisfies AgentNodeData,
  }));
}

function createEdge(fromAgentId: string, toAgentId: string): Edge {
  const orchestration = activeOrchestration.value;
  const keyByAgentId = orchestration ? flowKeyByAgentId(orchestration) : new Map<string, string>();
  const source = keyByAgentId.get(fromAgentId) || `${MISSING_NODE_PREFIX}${fromAgentId}`;
  const target = keyByAgentId.get(toAgentId) || `${MISSING_NODE_PREFIX}${toAgentId}`;
  return {
    id: edgeKey(fromAgentId, toAgentId),
    source,
    target,
    type: EDGE_TYPE,
    deletable: false,
    ariaLabel: edgeAriaLabel(source, target),
  };
}

function edgeAriaLabel(sourceKey: string, targetKey: string) {
  return t("agents.graph.edge", { from: nameOfFlowKey(sourceKey), to: nameOfFlowKey(targetKey) });
}

function nameOfFlowKey(flowKey: string) {
  const orchestration = activeOrchestration.value;
  if (orchestration) {
    for (const [agentId, key] of flowKeyByAgentId(orchestration)) {
      if (key === flowKey) return agentByCatalogId(orchestration.nodeId, agentId)?.name || agentId;
    }
  }
  return agentByKey(flowKey)?.name || flowKey;
}

function selectOrchestration(value: unknown) {
  if (typeof value !== "string") return;
  activeKey.value = value;
}

function isEdgeEffective(fromAgentId: string, toAgentId: string) {
  return activeEdgeKeys.value.includes(edgeKey(fromAgentId, toAgentId));
}

function applyLocalAddition(fromAgentId: string, toAgentId: string) {
  const orchestration = activeOrchestration.value;
  if (!orchestration) return;
  const key = orchestration.key;
  const edit = edits.get(key) ?? emptyEdit();
  const removedEdges = edit.removedEdges.filter((pair) => pair !== edgeKey(fromAgentId, toAgentId));
  const addedAgentIds = agentsForNewEdges(orchestration, [fromAgentId, toAgentId]);
  const addedEdges = [...new Set([...edit.addedEdges, edgeKey(fromAgentId, toAgentId)])];
  patchEdit(key, {
    addedEdges,
    removedEdges,
    addedAgentIds: [...new Set([...edit.addedAgentIds, ...addedAgentIds])],
    removedAgentIds: edit.removedAgentIds.filter((agentId) => !addedAgentIds.includes(agentId)),
  });
}

/** 新边两端的 Agent 若不在权威成员里，就同时加入成员：连线即声明成员关系。 */
function agentsForNewEdges(orchestration: AgentCatalogOrchestration, agentIds: string[]) {
  const members = new Set(effectiveAgentIds(orchestration));
  return agentIds.filter((agentId) => !members.has(agentId));
}

function applyLocalRemoval(fromAgentId: string, toAgentId: string) {
  const orchestration = activeOrchestration.value;
  if (!orchestration) return;
  const key = orchestration.key;
  const edit = edits.get(key) ?? emptyEdit();
  const pair = edgeKey(fromAgentId, toAgentId);
  const addedEdges = edit.addedEdges.filter((candidate) => candidate !== pair);
  const addedExisted = edit.addedEdges.includes(pair);
  patchEdit(key, {
    addedEdges,
    removedEdges: addedExisted || !orchestration.edges.some((edge) => edge.fromAgentId === fromAgentId && edge.toAgentId === toAgentId)
      ? edit.removedEdges.filter((candidate) => candidate !== pair)
      : [...new Set([...edit.removedEdges, pair])],
  });
}

/** 拖拽连线与「+」列表共用同一条声明路径：先做自引用、离线、重复与成环预校验，只把有效关系落到本地增量。 */
function addRelation(sourceKey: string, targetKey: string) {
  const orchestration = activeOrchestration.value;
  if (!orchestration || !editable.value) return;
  const sourceAgent = agentByKey(sourceKey);
  const targetAgent = agentByKey(targetKey);
  if (!sourceAgent || !targetAgent) return;
  if (sourceAgent.id === targetAgent.id) {
    rejectedMessage.value = t("agents.graph.rejected.self");
    return;
  }
  if (sourceAgent.nodeId !== orchestration.nodeId) {
    rejectedMessage.value = t("agents.graph.rejected.crossNodeMember");
    return;
  }
  if (!sourceAgent.nodeOnline || !targetAgent.nodeOnline) {
    rejectedMessage.value = t("agents.graph.rejected.offline");
    return;
  }
  if (isEdgeEffective(sourceAgent.id, targetAgent.id)) {
    rejectedMessage.value = t("agents.graph.rejected.duplicate");
    return;
  }
  if (reaches(targetAgent.id, sourceAgent.id)) {
    rejectedMessage.value = t("agents.graph.rejected.cycle");
    return;
  }
  rejectedMessage.value = "";
  applyLocalAddition(sourceAgent.id, targetAgent.id);
}

function connect(connection: Connection) {
  connectDragSettled = true;
  addRelation(connection.source, connection.target);
}

/** 「+」列表的候选：同一 Node 内的其它 Agent；已连接或会成环的候选只展示原因。 */
function addOptions(sourceKey: string): CallableOption[] {
  const orchestration = activeOrchestration.value;
  const source = agentByKey(sourceKey);
  if (!orchestration || !source) return [];
  return orchestrationAgentCandidates(props.agents, orchestration.nodeId).flatMap<CallableOption>((agent) => {
    if (agent.id === source.id) return [];
    if (isEdgeEffective(source.id, agent.id)) {
      const state = orchestration.agentIds.includes(agent.id) ? "agents.graph.addState.callable" : "agents.graph.addState.member";
      return [{ key: agent.key, name: agent.name, disabled: true, state: t(state) }];
    }
    if (reaches(agent.id, source.id)) {
      return [{ key: agent.key, name: agent.name, disabled: true, state: t("agents.graph.addState.cycle") }];
    }
    return [{ key: agent.key, name: agent.name, disabled: false, state: "" }];
  });
}

function setAddPicker(key: string, open: boolean) {
  if (open) addPickerKey.value = key;
  else if (addPickerKey.value === key) addPickerKey.value = "";
}

function chooseCallable(sourceKey: string, value: unknown) {
  addPickerKey.value = "";
  if (typeof value !== "string") return;
  addRelation(sourceKey, value);
}

function onConnectStart(payload: { event?: MouseEvent }) {
  connectDragSettled = false;
  connectStartPoint = payload.event ? { x: payload.event.clientX, y: payload.event.clientY } : null;
}

function onConnectEnd(event?: MouseEvent) {
  const start = connectStartPoint;
  connectStartPoint = null;
  // 只有落在空白画布上才提示画布范围；落在手柄上但连接无效时由 connect 单独给出原因。
  if (connectDragSettled || connectionEndHandle.value) return;
  // 没有位移的按下抬起是点击圆点（打开「+」列表），不是拖拽落空。
  if (!start || !event || Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return;
  rejectedMessage.value = t("agents.graph.rejected.outOfScope");
}

/** 可达性只看当前编排层，不跨编排；占位成员没有出边。 */
function reaches(startAgentId: string, goalAgentId: string) {
  const orchestration = activeOrchestration.value;
  if (!orchestration) return false;
  const keyByAgentId = flowKeyByAgentId(orchestration);
  const adjacency = new Map<string, string[]>();
  for (const key of activeEdgeKeys.value) {
    const edge = edgeFromKey(key);
    const source = keyByAgentId.get(edge.fromAgentId);
    const target = keyByAgentId.get(edge.toAgentId);
    if (!source || !target) continue;
    adjacency.set(source, [...(adjacency.get(source) || []), target]);
  }
  const startKey = keyByAgentId.get(startAgentId);
  const goalKey = keyByAgentId.get(goalAgentId);
  if (!startKey || !goalKey) return false;
  const seen = new Set<string>();
  const stack = [startKey];
  while (stack.length) {
    const current = stack.pop() as string;
    if (current === goalKey) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(adjacency.get(current) || []));
  }
  return false;
}

function onNodeClick(event: NodeMouseEvent) {
  if (event.node.type !== "agent") return;
  const orchestration = activeOrchestration.value;
  const agent = orchestration ? agentByCatalogId(orchestration.nodeId, (event.node.data as AgentNodeData).agentId) : undefined;
  if (agent) emit("select", agent.key);
}

function onEdgeClick(event: EdgeMouseEvent) {
  removeEdge(event.edge);
}

/** 边中点的删除按钮走键盘时用 id 找回边对象，和点击连线复用同一条删除路径。 */
function removeEdgeById(id: string) {
  const edge = flowEdges.value.find((candidate) => candidate.id === id);
  if (edge) removeEdge(edge);
}

function removeEdge(edge: Edge) {
  const orchestration = activeOrchestration.value;
  if (!orchestration || !editable.value) return;
  rejectedMessage.value = "";
  const [fromAgentId, toAgentId] = edge.id.split(EDGE_SEPARATOR);
  applyLocalRemoval(fromAgentId, toAgentId);
}

// Vue Flow 的 Delete/Backspace 走内部删除：把删除结果同步进本地增量，保持同一份编辑状态。
// 只读边（deletable: false）不会出现在删除变更里，编辑门控仍由 removeEdge 兜底。
function onEdgesChange(changes: EdgeChange[]) {
  const removals = changes.filter((change) => change.type === "remove");
  if (!removals.length) return;
  for (const change of removals) {
    const [fromAgentId, toAgentId] = change.id.split(EDGE_SEPARATOR);
    applyLocalRemoval(fromAgentId, toAgentId);
  }
  rejectedMessage.value = "";
}

/** 成员移除：默认编排必须保留所属 Agent，其余成员连同相关边一起移除。 */
function removeMember(agentId: string) {
  const orchestration = activeOrchestration.value;
  if (!orchestration || !editable.value) return;
  if (agentId === orchestration.ownerAgentId) {
    rejectedMessage.value = t("agents.graph.rejected.defaultOwner");
    return;
  }
  rejectedMessage.value = "";
  const edit = edits.get(orchestration.key) ?? emptyEdit();
  const removedEdges = [
    ...edit.removedEdges,
    ...orchestration.edges.filter((edge) => edge.fromAgentId === agentId || edge.toAgentId === agentId).map((edge) => edgeKey(edge.fromAgentId, edge.toAgentId)),
    ...edit.addedEdges.filter((key) => {
      const edge = edgeFromKey(key);
      return edge.fromAgentId === agentId || edge.toAgentId === agentId;
    }),
  ];
  patchEdit(orchestration.key, {
    removedAgentIds: [...new Set([...edit.removedAgentIds, agentId])],
    addedAgentIds: edit.addedAgentIds.filter((id) => id !== agentId),
    addedEdges: edit.addedEdges.filter((key) => {
      const edge = edgeFromKey(key);
      return edge.fromAgentId !== agentId && edge.toAgentId !== agentId;
    }),
    removedEdges: [...new Set(removedEdges)],
  });
}

function reset() {
  rejectedMessage.value = "";
  const orchestration = activeOrchestration.value;
  if (!orchestration) return;
  edits.delete(orchestration.key);
  orchestrationName.value = orchestration.name;
  flowNodes.value = layoutNodes(memberViews.value, activeEdgeKeys.value);
}

const saving = ref(false);

async function save() {
  const orchestration = activeOrchestration.value;
  if (!orchestration || saving.value) return;
  saving.value = true;
  rejectedMessage.value = "";
  try {
    await props.save({
      nodeId: orchestration.nodeId,
      orchestrationId: orchestration.id,
      name: effectiveName(orchestration).trim(),
      expectedRevision: orchestration.revision,
      agentIds: effectiveAgentIds(orchestration),
      edges: effectiveEdgeKeys(orchestration).map(edgeFromKey),
    });
  } catch (cause) {
    rejectedMessage.value = translateApiError(cause, t, t("agents.graph.saveFailed"));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.agent-graph { display:flex; flex-direction:column; gap:12px; min-height:0; height:100%; padding:0 0 16px; }
.agent-graph-toolbar { flex:none; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; border-bottom:1px solid var(--line); padding-bottom:12px; }
.agent-graph-hint { margin:0; max-width:72ch; color:var(--text-muted); font-size:12px; }
.agent-graph-scope { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.agent-graph-scope-select { width:170px; }
.agent-graph-orchestration-select { width:220px; }
.agent-graph-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.agent-graph-state { color:var(--text-muted); font-size:12px; }
.agent-graph-state[data-dirty="true"] { color:var(--text-strong); }
.agent-graph-meta { flex:none; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.agent-graph-name { width:min(320px,100%); height:30px; font-size:13px; }
.agent-graph-badge { font-size:12px; font-weight:400; }
.agent-graph-rejected { flex:none; margin:0; border:1px solid var(--line-strong); border-radius:8px; padding:7px 10px; color:var(--text-strong); font-size:12px; }
.agent-graph-empty { display:flex; flex:none; align-items:center; min-height:64px; margin:0; border:1px solid var(--line); border-radius:8px; background:var(--surface-raised); color:var(--text-muted); font-size:12px; padding:12px; }
.agent-graph-stage { position:relative; flex:1 1 auto; min-height:0; border:1px solid var(--line); border-radius:8px; background:var(--surface-raised); overflow:hidden; }
.agent-graph-canvas :deep(.vue-flow__background circle) { fill:var(--line); }
/* 箭头标记用 currentColor 着色，标记定义与边是同层兄弟节点，因此把颜色放在共同祖先上。 */
.agent-graph-canvas :deep(.vue-flow__transformationpane) { color:var(--line-strong); }
.agent-graph-canvas :deep(.vue-flow__edge-path) { stroke:var(--line-strong); stroke-width:1.6; }
.agent-graph-canvas :deep(.vue-flow__edge:hover .vue-flow__edge-path),
.agent-graph-canvas :deep(.vue-flow__edge.selected .vue-flow__edge-path),
.agent-graph-canvas :deep(.vue-flow__edge:focus .vue-flow__edge-path),
.agent-graph-canvas :deep(.vue-flow__edge:focus-visible .vue-flow__edge-path) { stroke:var(--brand-accent); }
.agent-graph-canvas :deep(.vue-flow__connection-path) { stroke:var(--brand-accent); stroke-width:1.6; stroke-dasharray:5 4; }
.agent-graph-canvas :deep(.vue-flow__handle) { width:14px; height:14px; border:1px solid var(--line-strong); border-radius:999px; background:var(--surface); }
.agent-graph-canvas :deep(.vue-flow__handle:hover) { border-color:var(--brand-accent); background:var(--surface-hover); }
/* 圆点本身仍是拖拽起点，悬停卡片时在圆点内浮出「+」：点击从列表选择，按住拖动仍可连线。 */
.agent-graph-add { position:absolute; inset:-4px; display:grid; grid:1fr/1fr; place-items:center; border:0; border-radius:999px; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; opacity:0; pointer-events:none; transition:opacity 120ms ease,color 120ms ease; }
.agent-graph-node:hover .agent-graph-add,.agent-graph-node:focus-within .agent-graph-add,.agent-graph-add[data-state="open"] { opacity:1; pointer-events:auto; }
.agent-graph-add:hover { color:var(--brand-accent); }
.agent-graph-add:focus-visible { color:var(--brand-accent); outline:2px solid var(--focus-ring); outline-offset:1px; }
@media (hover: none) { .agent-graph-add { opacity:1; pointer-events:auto; } }
.agent-graph-remove-node { position:absolute; top:-6px; left:-6px; display:grid; width:18px; height:18px; place-items:center; border:1px solid var(--line-strong); border-radius:999px; background:var(--surface); color:var(--text-muted); cursor:pointer; padding:0; opacity:0; pointer-events:none; transition:opacity 120ms ease,color 120ms ease; }
.agent-graph-node:hover .agent-graph-remove-node,.agent-graph-node:focus-within .agent-graph-remove-node { opacity:1; pointer-events:auto; }
.agent-graph-remove-node:hover { color:var(--danger,var(--text-strong)); }
.agent-graph-remove-node:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
@media (hover: none) { .agent-graph-remove-node { opacity:1; pointer-events:auto; } }
.agent-graph-canvas :deep(.vue-flow__controls) { box-shadow:none; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.agent-graph-canvas :deep(.vue-flow__controls-button) { width:22px; height:22px; background:var(--surface); border-bottom:1px solid var(--line); color:var(--text-muted); }
.agent-graph-canvas :deep(.vue-flow__controls-button:last-child) { border-bottom:0; }
.agent-graph-canvas :deep(.vue-flow__controls-button:hover) { background:var(--surface-hover); }
.agent-graph-canvas :deep(.vue-flow__controls-button svg) { max-width:11px; max-height:11px; fill:currentColor; }
.agent-graph-node { position:relative; display:grid; align-content:center; gap:2px; box-sizing:border-box; height:100%; border:1px solid var(--line); border-radius:9px; background:var(--surface); padding:6px 16px; }
.agent-graph-canvas :deep(.vue-flow__node.selected .agent-graph-node) { border-color:var(--brand-accent); }
.agent-graph-node.is-selected { border-color:var(--brand-accent); }
.agent-graph-node.is-blocked { border-style:dashed; }
.agent-graph-node-name { color:var(--text-strong); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-graph-node-meta { color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-graph-dialog { width:min(440px,calc(100vw - 24px)); }
.agent-graph-dialog-field { display:grid; gap:6px; color:var(--text-strong); font-size:12px; }
/* 列表挂在 body 上（reka-ui portal），样式只能用全局选择器：尺寸服从 available 变量，只有列表内部滚动。 */
:global(.agent-graph-add-popover) { width:min(280px,var(--reka-popover-content-available-width)); max-height:min(320px,var(--reka-popover-content-available-height)); overflow:hidden; border-color:var(--line-strong); background:var(--surface); color:var(--text-strong); }
:global(.agent-graph-add-popover .agent-graph-add-search) { height:34px; padding-top:0; padding-bottom:0; font-size:13px; }
:global(.agent-graph-add-scroll) { height:min(260px,calc(var(--reka-popover-content-available-height) - 35px)); }
:global(.agent-graph-add-list .agent-graph-add-option) { width:100%; min-width:0; cursor:pointer; font-size:13px; }
:global(.agent-graph-add-empty) { margin:0; padding:14px 12px; color:var(--text-muted); font-size:12px; text-align:center; }
:global(.agent-graph-add-option-name) { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
:global(.agent-graph-add-option-state) { flex:0 0 auto; margin-left:auto; color:var(--text-muted); font-size:12px; font-weight:400; white-space:nowrap; }
:global(.agent-graph-add-list .agent-graph-add-option:hover),:global(.agent-graph-add-list .agent-graph-add-option:focus-visible),:global(.agent-graph-add-list .agent-graph-add-option[data-highlighted]) { background:var(--surface-active); color:var(--text-strong); outline:none; }
@media (max-width: 900px) {
  .agent-graph-toolbar { flex-direction:column; align-items:stretch; }
  .agent-graph-scope { flex-direction:column; align-items:stretch; }
  .agent-graph-scope-select,.agent-graph-orchestration-select { width:100%; }
}
</style>
