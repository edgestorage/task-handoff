<template>
  <section class="agent-graph" :aria-label="t('agents.viewMode.graph')">
    <div class="agent-graph-toolbar">
      <p class="agent-graph-hint">{{ t("agents.graph.hint") }}</p>
      <div class="agent-graph-actions">
        <span class="agent-graph-state" :data-dirty="dirtyCount ? 'true' : undefined">
          {{ dirtyCount ? t("agents.graph.dirty", { count: dirtyCount }) : t("agents.graph.clean") }}
        </span>
        <Button variant="outline" size="sm" :disabled="!dirtyCount" @click="reset">
          <RotateCcw :size="14" />
          <span>{{ t("agents.graph.reset") }}</span>
        </Button>
        <Button size="sm" :disabled="!dirtyCount || saving" @click="save">
          <Save :size="14" />
          <span>{{ saving ? t("agents.graph.saving") : t("agents.graph.save") }}</span>
        </Button>
      </div>
    </div>
    <p v-if="rejectedMessage" class="agent-graph-rejected" role="alert">{{ rejectedMessage }}</p>
    <p v-if="!agents.length" class="agent-graph-empty">{{ t("agents.graph.empty") }}</p>
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
        :fit-view-on-init="true"
        @connect="connect"
        @node-click="onNodeClick"
        @edge-click="onEdgeClick"
      >
        <Background variant="dots" :gap="22" :size="1.6" />
        <Controls position="bottom-right" :show-interactive="false" />
        <template #node-agent="nodeProps">
          <div
            class="agent-graph-node"
            :class="{ 'is-muted': isMuted(nodeProps.id), 'is-blocked': !nodeProps.data.executable }"
            :data-agent-node="nodeProps.id"
          >
            <span class="agent-graph-node-name">{{ nodeProps.data.name }}</span>
            <span class="agent-graph-node-meta">{{ nodeProps.data.instanceLabel }}</span>
            <Handle
              type="target"
              :position="Position.Left"
              class="agent-graph-handle agent-graph-handle-in"
              :aria-label="t('agents.graph.linkTo', { name: nodeProps.data.name })"
            />
            <Handle
              type="source"
              :position="Position.Right"
              class="agent-graph-handle agent-graph-handle-out"
              :aria-label="t('agents.graph.linkFrom', { name: nodeProps.data.name })"
            />
          </div>
        </template>
        <template #node-agent-group="groupProps">
          <div class="agent-graph-band">
            <span class="agent-graph-band-label">{{ groupProps.data.label }}</span>
          </div>
        </template>
      </VueFlow>
    </div>
  </section>
</template>

<script setup lang="ts">
// 画布用 @vue-flow/core（MIT，Vue 3 版 React Flow）承载缩放平移、节点拖拽与连线手柄；这里只负责把权威
// 可调用集合投影成节点与边，并在提交前复用同一套校验给出结构化拒绝文案，不自己维护图状态。
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RotateCcw, Save } from "@lucide/vue";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { Handle, MarkerType, Position, VueFlow } from "@vue-flow/core";
import type { Connection, Edge, EdgeMouseEvent, Node, NodeMouseEvent } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/controls/dist/style.css";
import { Button } from "@/components/ui/button";
import { translateApiError } from "@/i18n/apiError";
import type { AgentCatalogAgent, AgentCatalogNode } from "./agentCatalogTypes";

/** 一次保存里某个 Agent 的权威可调用集合（含未变更的引用，服务端据此整体替换）。 */
export type AgentCallableChange = { nodeId: string; agentId: string; callableAgentIds: string[] };

type AgentNodeData = { name: string; instanceLabel: string; executable: boolean; online: boolean };
type BandNodeData = { label: string };

const DRAG_THRESHOLD = 4;
const NODE_WIDTH = 200;
const NODE_HEIGHT = 58;
const COLUMN_GAP = 320;
const ROW_GAP = 88;
const BAND_PAD = 22;
const BAND_TOP = 26;
const CARD_TOP = 76;
const BAND_BOTTOM = 22;
const BAND_PREFIX = "agent-node-band:";
const PAIR_SEPARATOR = "\u001f";
const DELETE_KEY_CODES = ["Delete", "Backspace"];

const props = defineProps<{
  agents: AgentCatalogAgent[];
  nodes: AgentCatalogNode[];
  selectedAgentKey: string;
  /** 提交实现由视图注入：画布只负责把权威集合投影成边并算出差异，不自己维护图状态。 */
  save: (changes: AgentCallableChange[]) => Promise<void>;
}>();

const emit = defineEmits<{
  select: [agentId: string];
}>();

const { t, locale } = useI18n();
// 画布节点与边整体替换，不需要深度响应式：deep ref 会对 Vue Flow 的递归泛型做 UnwrapRef，
// 在当前 TypeScript 下直接触发 TS2589，因此这两个状态用 shallowRef。
const flowNodes = shallowRef<Node[]>([]);
const flowEdges = shallowRef<Edge[]>([]);
const rejectedMessage = ref("");

const baselinePairs = computed(() => props.agents.flatMap((agent) => (agent.callableAgentIds || [])
  .flatMap((targetId) => {
    const target = props.agents.find((candidate) => candidate.nodeId === agent.nodeId && candidate.id === targetId);
    return target ? [pairKey(agent.key, target.key)] : [];
  })));

// 提交集合只包含本视图可见的关系；已保存但不在当前投影里的引用原样保留，
// 避免在本地把看不到的引用静默清空。
function callableIdsFromEdges(sourceKey: string) {
  const source = agentByKey(sourceKey);
  if (!source) return [];
  const visible = new Set(props.agents.filter((agent) => agent.nodeId === source.nodeId).map((agent) => agent.id));
  const retained = source.callableAgentIds.filter((targetId) => !visible.has(targetId));
  return [...retained, ...flowEdges.value
    .filter((edge) => edge.source === sourceKey)
    .flatMap((edge) => {
      const target = agentByKey(edge.target);
      return target ? [target.id] : [];
    })];
}

function sameIds(left: string[], right: string[]) {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((id, index) => id === sortedRight[index]);
}

const pendingChanges = computed<AgentCallableChange[]>(() => props.agents.flatMap((agent) => {
  const next = callableIdsFromEdges(agent.key);
  return sameIds(agent.callableAgentIds, next) ? [] : [{ nodeId: agent.nodeId, agentId: agent.id, callableAgentIds: next }];
}));

const dirtyCount = computed(() => pendingChanges.value.reduce((total, change) => {
  const before = new Set(agentByKey(agentKey(change.nodeId, change.agentId))?.callableAgentIds || []);
  const after = new Set(change.callableAgentIds);
  return total + [...after].filter((id) => !before.has(id)).length + [...before].filter((id) => !after.has(id)).length;
}, 0));

// 画布只在投影内容真的变化时重建：目录因为实例状态等无关事件重算时，
// 不能丢掉用户手动摆放的节点位置，也不能把未保存的连线静默退回权威集合。
const layoutKey = computed(() => [
  ...props.agents.map((agent) => `${agent.key}${PAIR_SEPARATOR}${agent.name}${PAIR_SEPARATOR}${agent.instanceLabel}${PAIR_SEPARATOR}${agent.executable ? 1 : 0}`),
  ...props.nodes.map((node) => `node${PAIR_SEPARATOR}${node.id}${PAIR_SEPARATOR}${node.label}`),
].join("\n"));

const authorityKey = computed(() => baselinePairs.value.join("\n"));

watch(layoutKey, () => {
  flowNodes.value = layoutNodes(props.agents, props.nodes);
}, { immediate: true });

watch(authorityKey, () => {
  flowEdges.value = baselineEdges();
}, { immediate: true });

// 边由对象字面量创建，切换语言时单独刷新它们的无障碍名称，避免为此重建整张图、丢掉未保存的改动。
watch(locale, () => {
  flowEdges.value = flowEdges.value.map((edge) => ({ ...edge, ariaLabel: edgeAriaLabel(edge.source, edge.target) }));
});

function pairKey(source: string, target: string) {
  return `${source}${PAIR_SEPARATOR}${target}`;
}

function bandNodeId(nodeId: string) {
  return `${BAND_PREFIX}${nodeId}`;
}

function agentKey(nodeId: string, agentId: string) {
  return props.agents.find((agent) => agent.nodeId === nodeId && agent.id === agentId)?.key || "";
}

function agentByKey(key: string) {
  return props.agents.find((agent) => agent.key === key);
}

function nameOf(key: string) {
  return agentByKey(key)?.name || key;
}

// 列只由 Agent 实际所属的节点派生，标签再到目录快照里查：既不会出现没有 Agent 的空列，
// 也不会因为某个 Agent 的 nodeId 不在节点列表里而落回坐标原点、和其它节点重叠。
function layoutNodes(agents: AgentCatalogAgent[], nodes: AgentCatalogNode[]): Node[] {
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const nodeIds = agents.reduce<string[]>((ids, agent) => (ids.includes(agent.nodeId) ? ids : [...ids, agent.nodeId]), []);
  return nodeIds.flatMap((nodeId, columnIndex) => {
    const columnAgents = agents.filter((agent) => agent.nodeId === nodeId);
    const x = 40 + columnIndex * COLUMN_GAP;
    const band: Node<BandNodeData> = {
      id: bandNodeId(nodeId),
      type: "agent-group",
      position: { x: x - BAND_PAD, y: BAND_TOP },
      width: NODE_WIDTH + BAND_PAD * 2,
      height: CARD_TOP - BAND_TOP + (columnAgents.length - 1) * ROW_GAP + NODE_HEIGHT + BAND_BOTTOM,
      draggable: false,
      selectable: false,
      deletable: false,
      connectable: false,
      focusable: false,
      data: { label: labels.get(nodeId) || nodeId },
    };
    const cards: Node<AgentNodeData>[] = columnAgents.map((agent, rowIndex) => ({
      id: agent.key,
      type: "agent",
      position: { x, y: CARD_TOP + rowIndex * ROW_GAP },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      deletable: false,
      ariaLabel: agent.name,
      connectable: agent.nodeOnline,
      data: { name: agent.name, instanceLabel: agent.instanceLabel, executable: agent.executable, online: agent.nodeOnline },
    }));
    return [band, ...cards];
  });
}

function baselineEdges(): Edge[] {
  return baselinePairs.value.map((key) => {
    const [source, target] = key.split(PAIR_SEPARATOR);
    return createEdge(source, target);
  });
}

function createEdge(source: string, target: string): Edge {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
    type: "default",
    deletable: agentByKey(source)?.nodeOnline === true,
    markerEnd: MarkerType.ArrowClosed,
    ariaLabel: edgeAriaLabel(source, target),
  };
}

function edgeAriaLabel(source: string, target: string) {
  return t("agents.graph.removeEdge", { from: nameOf(source), to: nameOf(target) });
}

function connect(connection: Connection) {
  const source = connection.source;
  const target = connection.target;
  if (source === target) {
    rejectedMessage.value = t("agents.graph.rejected.self");
    return;
  }
  const sourceAgent = agentByKey(source);
  const targetAgent = agentByKey(target);
  if (!sourceAgent?.nodeOnline || !targetAgent?.nodeOnline) {
    rejectedMessage.value = t("agents.graph.rejected.offline");
    return;
  }
  if (!sourceAgent || !targetAgent || sourceAgent.nodeId !== targetAgent.nodeId) {
    rejectedMessage.value = t("agents.graph.rejected.crossNode");
    return;
  }
  if (flowEdges.value.some((edge) => edge.source === source && edge.target === target)) {
    rejectedMessage.value = t("agents.graph.rejected.duplicate");
    return;
  }
  if (reaches(target, source)) {
    rejectedMessage.value = t("agents.graph.rejected.cycle");
    return;
  }
  rejectedMessage.value = "";
  flowEdges.value = [...flowEdges.value, createEdge(source, target)];
}

function reaches(start: string, goal: string) {
  const adjacency = new Map<string, string[]>();
  for (const edge of flowEdges.value as Edge[]) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) || []), edge.target]);
  }
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop() as string;
    if (current === goal) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(adjacency.get(current) || []));
  }
  return false;
}

function onNodeClick(event: NodeMouseEvent) {
  if (event.node.type !== "agent") return;
  emit("select", event.node.id);
}

function onEdgeClick(event: EdgeMouseEvent) {
  removeEdge(event.edge);
}

function removeEdge(edge: Edge) {
  if (!agentByKey(edge.source)?.nodeOnline) {
    rejectedMessage.value = t("agents.graph.rejected.offline");
    return;
  }
  rejectedMessage.value = "";
  flowEdges.value = flowEdges.value.filter((candidate) => candidate.id !== edge.id);
}

function isMuted(agentId: string) {
  const selected = props.selectedAgentKey;
  if (!selected || selected === agentId) return false;
  return !flowEdges.value.some((edge) => (edge.source === selected && edge.target === agentId) || (edge.target === selected && edge.source === agentId));
}

function reset() {
  rejectedMessage.value = "";
  flowNodes.value = layoutNodes(props.agents, props.nodes);
  flowEdges.value = baselineEdges();
}

const saving = ref(false);

async function save() {
  const changes = pendingChanges.value;
  if (!changes.length || saving.value) return;
  saving.value = true;
  rejectedMessage.value = "";
  try {
    await props.save(changes);
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
.agent-graph-hint { margin:0; max-width:62ch; color:var(--text-muted); font-size:12px; }
.agent-graph-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.agent-graph-state { color:var(--text-muted); font-size:12px; }
.agent-graph-state[data-dirty="true"] { color:var(--text-strong); }
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
.agent-graph-canvas :deep(.vue-flow__controls) { box-shadow:none; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.agent-graph-canvas :deep(.vue-flow__controls-button) { width:22px; height:22px; background:var(--surface); border-bottom:1px solid var(--line); color:var(--text-muted); }
.agent-graph-canvas :deep(.vue-flow__controls-button:last-child) { border-bottom:0; }
.agent-graph-canvas :deep(.vue-flow__controls-button:hover) { background:var(--surface-hover); }
.agent-graph-canvas :deep(.vue-flow__controls-button svg) { max-width:11px; max-height:11px; fill:currentColor; }
.agent-graph-node { display:grid; align-content:center; gap:2px; box-sizing:border-box; height:100%; border:1px solid var(--line); border-radius:9px; background:var(--surface); padding:6px 16px; }
.agent-graph-canvas :deep(.vue-flow__node.selected .agent-graph-node) { border-color:var(--brand-accent); }
.agent-graph-node.is-muted { opacity:.72; }
.agent-graph-node.is-blocked { border-style:dashed; }
.agent-graph-node-name { color:var(--text-strong); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-graph-node-meta { color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-graph-band { height:100%; border:1px dashed var(--line); border-radius:12px; background:color-mix(in srgb, var(--surface-inset) 55%, transparent); }
.agent-graph-band-label { position:absolute; top:0; left:16px; transform:translateY(-50%); background:var(--surface); padding:0 6px; color:var(--text-muted); font-size:12px; }
@media (max-width: 900px) {
  .agent-graph-toolbar { flex-direction:column; align-items:stretch; }
}
</style>
