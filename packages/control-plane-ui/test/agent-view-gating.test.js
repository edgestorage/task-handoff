import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (relativePath) => fs.readFileSync(new URL(relativePath, root), "utf8");
const agentDirectory = new URL("src/apps/control-plane/agent/", root);

const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
const catalog = read("src/apps/control-plane/agent/agentCatalog.ts");
const hook = read("src/apps/control-plane/agent/useAgentCatalog.ts");
const queries = read("src/api/queries.ts");
const eventInvalidation = read("src/apps/control-plane/eventInvalidation.ts");
const view = read("src/apps/control-plane/agent/AgentView.vue");
const editor = read("src/apps/control-plane/agent/AgentEditor.vue");
const runDialog = read("src/apps/control-plane/agent/AgentRunDialog.vue");
const graph = read("src/apps/control-plane/agent/AgentGraph.vue");
const graphEdge = read("src/apps/control-plane/agent/AgentGraphEdge.vue");
const types = read("src/apps/control-plane/agent/agentCatalogTypes.ts");
const clientAgents = fs.readFileSync(new URL("../../control-plane-client/src/agents.ts", import.meta.url), "utf8");

function readAgentSources() {
  return fs.readdirSync(agentDirectory)
    .filter((name) => /\.(?:ts|vue)$/.test(name))
    .map((name) => ({ name, source: fs.readFileSync(new URL(name, agentDirectory), "utf8") }));
}

test("the agent workbench view is gated by the agentRuns feature flag", () => {
  assert.match(workbench, /type WorkbenchView = "instance" \| "board" \| "ai" \| "story" \| "agent";/);
  assert.match(workbench, /\.\.\.\(isFeatureEnabled\("agentRuns"\) \? \[\{ value: "agent" as const, label: t\("agents\.view"\), icon: Boxes \}\] : \[\]\)/);
  assert.match(workbench, /const agentMode = computed\(\(\) => workbenchView\.value === "agent"\);/);
  assert.match(workbench, /<AgentView\s+v-if="!standaloneMode && agentMode && !settingsMode"\s+:node-filter="nodeFilter"\s+\/>/);
  assert.match(workbench, /const agentCatalog = useAgentCatalog\(\{ enabled: agentMode \}\);/);
});

test("the agent catalog reads node-scoped queries instead of a local sample", () => {
  assert.equal(fs.existsSync(path.join(fileURLToPath(agentDirectory), "agentCatalogSample.json")), false);
  for (const { name, source } of readAgentSources()) {
    assert.doesNotMatch(source, /agentCatalogSample/, `${name} must not read the removed sample`);
  }
  assert.doesNotMatch(view, /from "\.\/agentCatalog"[\s\S]{0,80}agentCatalog[,}]/, "the view must not import a sample-backed constant");
  assert.match(view, /const \{ catalog,[^}]+ \} = useAgentCatalog\(\{/);
  assert.match(view, /catalog\.value\.agents\.filter\(\(agent\) => nodeIsVisible\(props\.nodeFilter, agent\.nodeId\)\)/);
});

test("agent view sources keep product text in the locale files", () => {
  for (const { name, source } of readAgentSources()) {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(withoutComments, /\p{Script=Han}/u, `${name} must not inline visible text`);
  }
});

test("the agent catalog follows each node answer and stays inert while the view is closed", () => {
  assert.match(hook, /controlPlaneAgentCapabilities\(node\.capabilities\)\.definitions/);
  assert.match(hook, /const activeNodeIds = computed\(\(\) => \(toValue\(options\.enabled \?\? true\) \? capableNodeIds\.value : \[\]\)\);/);
  assert.match(hook, /activeNodeIds\.value\.map\(\(nodeId\) => agentNodeQueryOptions\(nodeId\)\)/);
  assert.match(hook, /activeNodeIds\.value\.map\(\(nodeId\) => nodeLocalFoldersQueryOptions\(nodeId\)\)/);
  assert.match(hook, /useAgentRunsQuery\(runsEnabled\)/);
  assert.match(hook, /controlPlaneAgentCapabilities\(node\.capabilities\)\.runs/);
  assert.match(hook, /nodeQueryLoadState\(nodeId, index < 0 \? undefined : agentQueries\.value\[index\]\)/);
  assert.match(queries, /export function agentNodeQueryOptions\(nodeId: string, enabled: MaybeRefOrGetter<boolean> = true\) \{[\s\S]*queryKey: controlPlaneQueryKeys\.agents\(nodeId\)/);
  assert.doesNotMatch(hook, /listAgents\(\)/, "the hook must query per node, not through one aggregate request");
});

test("the agent view exposes progressive, unavailable, and offline read-only states", () => {
  assert.match(view, /const \{ catalog, nodes, loadingNodeIds, unavailableNodeIds, isPending, refetch \} = useAgentCatalog/);
  assert.match(view, /loadingNodeIds\.includes\(group\.nodeId\)/);
  assert.match(view, /unavailableNodeIds\.includes\(group\.nodeId\)/);
  assert.match(view, /!selectedAgent\.nodeOnline/);
  assert.match(types, /nodeOnline: boolean;/);
  assert.match(graph, /connectable: member\.online && !member\.missing/);
  assert.match(graph, /:removable="editable"/);
  assert.match(graph, /agents\.graph\.rejected\.offline/);
});

test("Agent capability and WebSocket payloads cross the typed client boundary", () => {
  assert.match(catalog, /controlPlaneAgentCapabilities/);
  assert.match(catalog, /controlPlaneSupportsAgentExecutionPolicy/);
  assert.match(clientAgents, /export function consumeControlPlaneAgentEvent/);
  assert.match(clientAgents, /sanitizeAgentDefinitionAggregateEvent/);
  assert.match(clientAgents, /sanitizeAgentRunAggregateEvent/);
});

test("agent definition changes converge through the agents query domain", () => {
  assert.match(eventInvalidation, /if \(topics\.has\("agents"\)\) domains\.push\("agents"\);/);
  assert.match(queries, /export function createAgentDefinition\(nodeId: string, input: AgentDefinitionCreateInput\)/);
  assert.match(queries, /export function updateAgentDefinition\(agentId: string, nodeId: string, input: AgentDefinitionUpdateInput\)/);
  assert.match(queries, /export function deleteAgentDefinition\(agentId: string, nodeId: string, options: \{ referencingOrchestrations\?: "keep" \| "delete" \} = \{\}\)/);
  assert.match(queries, /export function createAgentOrchestration\(nodeId: string, input: AgentOrchestrationCreateInput\)/);
  assert.match(queries, /export function updateAgentOrchestration\(orchestrationId: string, nodeId: string, input: AgentOrchestrationUpdateInput\)/);
  assert.match(queries, /export function deleteAgentOrchestration\(orchestrationId: string, nodeId: string\)/);
  assert.match(queries, /queryKey: controlPlaneQueryKeys\.agentOrchestrations\(nodeId\)/);
  assert.match(view, /await invalidateControlPlaneDomains\(queryClient, \["agents"\]\);/);
  assert.match(view, /await createAgentDefinition\(nodeId, createInputFromDraft\(draft\)\)/);
  assert.match(view, /await updateAgentDefinition\(draft\.id, nodeId, updateInputFromDraft\(draft\)\)/);
  assert.match(view, /await deleteAgentDefinition\(agent\.id, agent\.nodeId, \{/);
  assert.match(view, /\.\.\.\(deleteReferencingOrchestrations\.value \? \{ referencingOrchestrations: "delete" as const \} : \{\}\),/);
  assert.match(hook, /agentOrchestrationsQueryOptions\(/);
});

test("Agent details can launch a capability-gated manual run through the typed client", () => {
  assert.match(view, /:disabled="!canLaunchSelectedAgent"/);
  assert.match(view, /<AgentRunDialog/);
  assert.match(view, /await createManualAgentRun\(agent\.nodeId, \{/);
  assert.match(view, /clientRequestId: createBrowserUuid\(\)/);
  assert.match(view, /selectedRunKey\.value = agentCatalogKey\(agent\.nodeId, run\.runId\)/);
  assert.match(view, /await invalidateControlPlaneDomains\(queryClient, \["agents"\]\)/);
  assert.match(runDialog, /<Textarea/);
  assert.match(runDialog, /:maxlength="128000"/);
  assert.match(clientAgents, /async createManualRun\(nodeId: string, input: AgentRunManualCreateInput\)/);
});

test("the agent definition keeps its prompt as adapter-mapped appended instructions", () => {
  assert.match(types, /appendedPrompt: string;/);
  assert.match(types, /Codex adapter 以 `developer_instructions` 承载/);
  assert.doesNotMatch(types, /promptTemplate/);
  assert.match(editor, /v-model="draft\.appendedPrompt"/);
  assert.match(editor, /agents\.value\.appendedPromptNote/);
  assert.doesNotMatch(editor, /promptTemplate/);
  assert.match(view, /appendedPrompt: draft\.appendedPrompt,/);
});

test("the agent editor reuses the instance-scoped AI session selection logic", () => {
  assert.match(editor, /load: \(id, input\) => listNodeFolderTree\(id, input\)/);
  assert.match(editor, /selectableInstanceCwdFolders\(instance, \[/);
  assert.match(editor, /useNodeLocalFoldersQuery\(nodeId\)/);
  assert.match(editor, /aiSessionLaunchableAppsForInstance\(selectedInstance\.value, t\)/);
  assert.match(editor, /deriveAiSessionModelGroups\(\{/);
  assert.match(editor, /directoryAiSessionProviderCapability\(instance\.capabilities\?\.features, agent\)/);
});

test("the agent editor selects only folders the instance can resolve, including its workspace", () => {
  assert.match(editor, /const workspaceFolderValue = "__instance_workspace__";/);
  assert.match(editor, /const chooseFolderValue = "__choose_folder__";/);
  assert.match(editor, /const canRegisterFolder = computed\(\(\) => selectedInstance\.value\?\.source\.type === "local-folder"\)/);
  assert.match(editor, /createNodeLocalFolder\(nodeId\.value, \{ name: nodePathName\(path\), path \}\)/);
  // 「实例工作区」必须落到已登记的节点文件夹 id 上，未登记时不提供该选项。
  assert.match(editor, /return folderCandidates\.value\.find\(\(folder\) => findInstanceCwdFolderByPath\(\[folder\], sourcePath\)\);/);
  assert.match(editor, /draft\.value\.cwdFolderId = instanceWorkspaceFolder\.value\?\.id \|\| "";/);
  assert.doesNotMatch(editor, /listControlledInstanceConfigSyncFolders/);
});

test("the agent editor clears the folder selection when the target instance changes", () => {
  const handler = editor.slice(editor.indexOf("function selectInstance(instanceId: string)"), editor.indexOf("function selectAgent("));
  assert.match(handler, /draft\.value\.targetInstanceId = instanceId;/);
  assert.match(handler, /draft\.value\.cwdFolderId = "";/);
  assert.match(handler, /draft\.value\.cwdFolderPath = "";/);
  assert.match(handler, /folderBrowserOpen\.value = false;/);
  assert.match(handler, /applyDefaultFolder\(\);/);
});

test("the agent view wires create, edit and delete into the editor", () => {
  assert.match(view, /@click="openCreate"/);
  assert.match(view, /@click="openEdit\(selectedAgent\)"/);
  assert.match(view, /@click="deleteAgent\(selectedAgent\)"/);
  assert.match(view, /<AgentEditor\s/);
  assert.match(view, /:instances="instances"/);
  assert.match(view, /const instances = computed\(\(\) => board\.data\.value \|\| \[\]\)/);
  // 删除是破坏性操作：改用与其它产品页面一致的 AlertDialog，并在确认时询问是否一并删除相关编排。
  assert.match(view, /<AlertDialog :open="Boolean\(pendingDeleteAgent\)"/);
  assert.match(view, /t\("agents\.confirm\.deleteAgent", \{ name: pendingDeleteAgent\?\.name \|\| "" \}\)/);
  assert.match(view, /deleteReferencingOrchestrations/);
  assert.match(view, /await deleteAgentDefinition\(agent\.id, agent\.nodeId, \{/);
  assert.doesNotMatch(view, /window\.confirm/);
});

test("the agent list opens run, edit and delete from a right-click menu", () => {
  const contextMenu = read("src/apps/control-plane/agent/AgentContextMenu.vue");
  // 列表行包在与 Story 列表相同的 ContextMenu 组件里，右键同时把该行设为当前选中项。
  assert.match(view, /<ContextMenu v-for="agent in group\.agents" :key="agent\.key">/);
  assert.match(view, /<ContextMenuTrigger as-child>/);
  assert.match(view, /@contextmenu="selectedAgentKey = agent\.key"/);
  assert.match(view, /<AgentContextMenu\s/);
  assert.match(view, /@run="openManualRun\(agent\)"/);
  assert.match(view, /@edit="openEdit\(agent\)"/);
  assert.match(view, /@delete="deleteAgent\(agent\)"/);
  // 行内操作只按该 Agent 自己的目录数据判定，不受当前选中项影响；手动运行还要求该 Agent 属于一张可运行的编排。
  assert.match(view, /:can-run="agentManualRunAvailable\(agent, agentRunOrchestrations\(catalog\.orchestrations, agent\)\)"/);
  assert.match(view, /:editable="agent\.nodeOnline"/);
  assert.match(catalog, /export function agentManualRunAvailable\(agent\?: AgentCatalogAgent, runnableOrchestrations: AgentCatalogOrchestration\[\] = \[\]\) \{/);
  assert.match(catalog, /return Boolean\(agent\?\.nodeOnline && agent\.executable && agent\.runsSupported && agent\.manualRunsSupported\)\n\s*&& runnableOrchestrations\.length > 0;/);
  assert.match(view, /const canLaunchSelectedAgent = computed\(\(\) => agentManualRunAvailable\(selectedAgent\.value, manualRunOrchestrations\.value\)\);/);
  assert.match(view, /if \(!agentManualRunAvailable\(agent, agentRunOrchestrations\(catalog\.value\.orchestrations, agent\)\)\) return;/);
  // 菜单复用 Story 列表菜单的控件样式，删除保持危险项语义。
  assert.match(contextMenu, /<ContextMenuContent class="ai-session-context-menu">/);
  assert.match(contextMenu, /class="ai-session-context-menu-item"[\s\S]*agents\.detail\.run/);
  assert.match(contextMenu, /agents\.detail\.edit/);
  assert.match(contextMenu, /class="ai-session-context-menu-item danger"/);
  assert.match(contextMenu, /agents\.detail\.delete/);
  assert.match(contextMenu, /defineEmits<\{\n  run: \[\];\n  edit: \[\];\n  delete: \[\];\n\}>\(\);/);
});

test("the agent graph opens the same actions from a node right-click menu", () => {
  // 画布节点与列表行共用同一个操作菜单，操作事件只回传聚合 key，由视图解析回目录对象。
  assert.match(graph, /<template #node-agent="nodeProps">[\s\S]*?<ContextMenu>\n\s*<ContextMenuTrigger as-child>/);
  assert.match(graph, /<AgentContextMenu\n\s*:can-run="canRunMember\(nodeProps\.data\.agentId\)"\n\s*:editable="editable && !nodeProps\.data\.missing"\n\s*:deleting="deleting"/);
  assert.match(graph, /@run="runMember\(nodeProps\.data\.agentId\)"/);
  assert.match(graph, /@edit="editMember\(nodeProps\.data\.agentId\)"/);
  assert.match(graph, /@delete="deleteMember\(nodeProps\.data\.agentId\)"/);
  assert.match(graph, /import \{ agentEntryOrchestrations, agentManualRunAvailable, agentParticipatingOrchestrations, agentRunOrchestrations, orchestrationAgentCandidates \} from "\.\/agentCatalog";/);
  assert.match(graph, /deleting: boolean;/);
  assert.match(view, /:deleting="deleting"[\s\S]*?:save="saveOrchestrationChange"[\s\S]*?@select="selectedAgentKey = \$event"[\s\S]*?@run="runAgentByKey"[\s\S]*?@edit="editAgentByKey"[\s\S]*?@delete="deleteAgentByKey"/);
  assert.match(view, /function runAgentByKey\(key: string\) \{[\s\S]*?openManualRun\(agent\);[\s\S]*?\}/);
  assert.match(view, /function editAgentByKey\(key: string\) \{[\s\S]*?openEdit\(agent\);[\s\S]*?\}/);
  assert.match(view, /function deleteAgentByKey\(key: string\) \{[\s\S]*?void deleteAgent\(agent\);[\s\S]*?\}/);
});

test("the agent editor submits through the injected save callback and surfaces structured errors", () => {
  assert.match(editor, /save: \(draft: AgentEditorDraft\) => Promise<void>;/);
  assert.doesNotMatch(editor, /emit\("saved"/);
  assert.match(editor, /await props\.save\(\{ \.\.\.draft\.value \}\);/);
  assert.match(editor, /saveError\.value = translateApiError\(cause, t\);/);
  assert.match(editor, /:disabled="!canSubmit \|\| saving"/);
  assert.match(view, /:save="saveDraft"/);
  assert.match(view, /expectedRevision: draft\.revision,/);
});

test("the agent view localizes the authoritative block reason instead of showing server text", () => {
  assert.match(types, /blockedCode\?: AgentBlockedCode;/);
  assert.match(view, /"policy-unsupported": "agents\.blocked\.policyUnsupported",/);
  assert.match(view, /return agent\.blockedCode \? t\(blockedLabelKeys\[agent\.blockedCode\]\) : "";/);
});

test("the agent detail renders the saved execution policy instead of a fixed phase label", () => {
  assert.match(view, /{{ workspaceLabel\(selectedAgent\) }}/);
  assert.match(view, /{{ sandboxLabel\(selectedAgent\) }}/);
  assert.match(view, /{{ isolationLabel\(selectedAgent\) }}/);
  assert.match(view, /return t\(workspaceLabelKeys\[agent\.executionPolicy\.workspaceMaterializer\]\);/);
  assert.match(view, /return t\(sandboxLabelKeys\[agent\.executionPolicy\.processSandbox\]\);/);
  assert.match(view, /return t\(isolationLabelKeys\[agent\.executionPolicy\.processSandbox\]\);/);
});

test("the agent graph renders one authoritative orchestration with Vue Flow", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.ok(manifest.dependencies["@vue-flow/core"], "the graph canvas must come from Vue Flow");
  assert.match(graph, /import \{ Handle, Position, VueFlow, useVueFlow \} from "@vue-flow\/core";/);
  assert.match(graph, /import "@vue-flow\/core\/dist\/style\.css";/);
  assert.match(graph, /v-model:nodes="flowNodes"/);
  assert.match(graph, /v-model:edges="flowEdges"/);
  assert.match(graph, /@connect="connect"/);
  assert.match(graph, /@edge-click="onEdgeClick"/);
  assert.match(graph, /@edges-change="onEdgesChange"/);
  assert.match(graph, /data-agent-node="nodeProps\.id"/);
  assert.match(graph, /deletable: false/);
  assert.match(graph, /function connect\(connection: Connection\)/);
  assert.match(graph, /function removeEdge\(edge: Edge\)/);
  assert.match(graph, /agents\.graph\.rejected\.crossNodeMember/);
  assert.match(graph, /agents\.graph\.rejected\.self/);
  assert.match(graph, /agents\.graph\.rejected\.cycle/);
  assert.match(graph, /function reaches\(startAgentId: string, goalAgentId: string\)/);
  assert.match(graph, /if \(reaches\(targetAgent\.id, sourceAgent\.id\)\)/);
  assert.match(graph, /flowNodes\.value = layoutNodes\(memberViews\.value, activeEdgeKeys\.value\);/);
  assert.match(view, /<AgentGraph\s/);
  assert.match(view, /:agents="visibleAgents"/);
  assert.match(view, /const viewMode = ref<"list" \| "graph">\("list"\)/);
});

test("the agent graph scopes visibility by entry or participating orchestration", () => {
  // 画布一次只投影一张权威编排，作用域决定从哪个方向挑出候选：以该 Agent 为顶级节点，或所有参与的编排。
  assert.match(graph, /const scope = ref<"entry" \| "participating">\("entry"\);/);
  assert.match(graph, /const scopedOrchestrations = computed\(\(\) => \{/);
  assert.match(graph, /const primary = scope\.value === "entry" \? agentEntryOrchestrations\(props\.orchestrations, agent\) : agentParticipatingOrchestrations\(props\.orchestrations, agent\);/);
  assert.match(graph, /const fallback = scope\.value === "entry" \? agentParticipatingOrchestrations\(props\.orchestrations, agent\) : agentEntryOrchestrations\(props\.orchestrations, agent\);/);
  assert.match(graph, /<ControlPlaneSelectItem value="entry">/);
  assert.match(graph, /<ControlPlaneSelectItem value="participating">/);
  // 视图可以从详情卡片跳进某张编排，画布内部切换也会同步回视图。
  assert.match(graph, /watch\(\(\) => props\.orchestrationKey, \(key\) => \{/);
  assert.match(graph, /if \(key !== props\.orchestrationKey\) emit\("orchestration-change", key\);/);
  assert.match(view, /@orchestration-change="graphOrchestrationKey = \$event"/);
  assert.match(view, /function openOrchestrationInGraph\(orchestration: AgentCatalogOrchestration\) \{/);
  assert.match(view, /graphOrchestrationKey\.value = orchestration\.key;\n\s*viewMode\.value = "graph";/);
  // 从上到下分层：调用深度决定行，层内顺序用重心扫描，横向位置做松弛对齐。
  assert.match(graph, /function buildLayers\(keys: string\[\], edges: LayerEdges\): string\[\]\[\]/);
  assert.match(graph, /const depth = new Map\(keys\.map\(\(key\) => \[key, 0\]\)\);/);
  assert.match(graph, /function orderLayers\(layers: string\[\]\[\], edges: LayerEdges\): string\[\]\[\]/);
  assert.match(graph, /function layeredColumns\(layers: string\[\]\[\], edges: LayerEdges\): Map<string, number>/);
  assert.match(graph, /y: CANVAS_ORIGIN \+ \(depth\.get\(member\.key\) \?\? 0\) \* rowStep,/);
  // 连线手柄改为上下方向，边从上往下走。
  assert.match(graph, /:position="Position\.Top"/);
  assert.match(graph, /:position="Position\.Bottom"/);
  // 初始缩放小于默认视角：用带 maxZoom 上限的 fitView 适配视图。
  assert.match(graph, /const FIT_VIEW_MAX_ZOOM = 0\.85;/);
  assert.match(graph, /const \{ fitView, connectionEndHandle, onNodesInitialized, onMoveStart \} = useVueFlow\(\);/);
  // 浮层锚在画布内的节点上，平移缩放后立刻关掉，避免脱锚。
  assert.match(graph, /onMoveStart\(\(\) => \{\n  addPickerKey\.value = "";\n\}\);/);
  assert.match(graph, /void fitView\(\{ padding: FIT_VIEW_PADDING, maxZoom: FIT_VIEW_MAX_ZOOM, duration: 0 \}\);/);
  // 拖拽落在画布空白处时给出画布范围说明，不静默无响应。
  assert.match(graph, /rejectedMessage\.value = t\("agents\.graph\.rejected\.outOfScope"\);/);
});

test("the agent graph adds orchestration edges from the handle picker", () => {
  // 圆点悬停显示「+」：点击弹出同 Node 的 Agent 列表，为纯键盘与列表选择提供可达入口。
  assert.match(graph, /:open="addPickerKey === nodeProps\.id"/);
  assert.match(graph, /<PopoverTrigger as-child>/);
  assert.match(graph, /class="agent-graph-add"/);
  assert.match(graph, /<CommandInput v-if="addOptions\(nodeProps\.id\)\.length" class="agent-graph-add-search"/);
  assert.match(graph, /v-for="option in addOptions\(nodeProps\.id\)"/);
  assert.match(graph, /function addOptions\(sourceKey: string\): CallableOption\[\]/);
  // 已连接或会成环的候选只展示原因，不可选。
  assert.match(graph, /agents\.graph\.addState\.callable/);
  assert.match(graph, /agents\.graph\.addState\.cycle/);
  // 列表选择与拖拽连线共用同一条声明路径：同一套预校验，同一份本地增量。
  assert.match(graph, /function addRelation\(sourceKey: string, targetKey: string\)/);
  assert.match(graph, /connectDragSettled = true;\n  addRelation\(connection\.source, connection\.target\);/);
  assert.match(graph, /addRelation\(sourceKey, value\);/);
  // 连线即声明成员：新边两端的 Agent 不在权威成员里时随新关系一起进入画布。
  assert.match(graph, /function agentsForNewEdges\(orchestration: AgentCatalogOrchestration, agentIds: string\[\]\) \{/);
  assert.match(graph, /addedAgentIds: \[\.\.\.new Set\(\[\.\.\.edit\.addedAgentIds, \.\.\.addedAgentIds\]\)\],/);
  // 点击圆点没有位移，不算拖拽落空，不产生画布范围提示。
  assert.match(graph, /Math\.hypot\(event\.clientX - start\.x, event\.clientY - start\.y\) < DRAG_THRESHOLD/);
});

test("the agent graph removes relations from the edge midpoint control", () => {
  // 边走自定义类型，模板提供同名 edge slot：保留原路径与箭头，并在中点上叠加删除入口。
  assert.match(graph, /const EDGE_TYPE = "agent-callable";/);
  assert.match(graph, /type: EDGE_TYPE,/);
  assert.match(graph, /<template #edge-agent-callable="edgeProps">/);
  assert.match(graphEdge, /<BaseEdge/);
  assert.match(graphEdge, /getBezierPath\(\{/);
  assert.match(graphEdge, /:transform="`translate\(\$\{geometry\.labelX\},\$\{geometry\.labelY\}\)`"/);
  // 删除入口只在悬停或聚焦时显形，并且是键盘可达的真实按钮（Enter / Space）。
  assert.match(graphEdge, /\.vue-flow__edge:hover \.agent-graph-edge-remove,/);
  assert.match(graphEdge, /\.vue-flow__edge:focus-within \.agent-graph-edge-remove,/);
  assert.match(graphEdge, /role="button"/);
  assert.match(graphEdge, /tabindex="0"/);
  assert.match(graphEdge, /@keydown\.enter\.prevent="emit\('remove'\)"/);
  assert.match(graphEdge, /@keydown\.space\.prevent="emit\('remove'\)"/);
  // 键盘删除按边 id 找回边对象，和点击连线共用同一条删除路径；只读编排移除入口整体禁用。
  assert.match(graph, /function removeEdgeById\(id: string\)/);
  assert.match(graph, /const edge = flowEdges\.value\.find\(\(candidate\) => candidate\.id === id\);/);
  assert.match(graph, /:removable="editable"/);
  assert.match(graph, /@remove="removeEdgeById\(edgeProps\.id\)"/);
  // 分组带铺满整片画布，只做背景：既不能拦截指针，也要压在连线与卡片之下，
  // 否则带内的连线和中点删除按钮点不到，还会被半透明底色蒙住。
  // 分组背景铺满画布但只做背景：使用 Vue Flow 的 Background 层，不参与指针事件。
  assert.match(graph, /<Background variant="dots" :gap="22" :size="1\.6" \/>/);
});

test("the agent graph submits the whole orchestration with its read revision", () => {
  assert.match(graph, /save: \(change: AgentOrchestrationChange\) => Promise<void>;/);
  assert.match(graph, /expectedRevision: orchestration\.revision,/);
  assert.match(graph, /agentIds: effectiveAgentIds\(orchestration\),/);
  assert.match(graph, /edges: effectiveEdgeKeys\(orchestration\)\.map\(edgeFromKey\),/);
  // 本地增量按编排 key 存储：切换编排或作用域不会丢未保存的节点、边与名称。
  assert.match(graph, /const edits = reactive\(new Map<string, OrchestrationEdit>\(\)\);/);
  assert.match(graph, /function patchEdit\(orchestrationKey: string, patch: Partial<OrchestrationEdit>\) \{/);
  // 权威 revision 变化（保存成功或外部更新）后只丢弃对应编排的本地增量。
  assert.match(graph, /if \(previousRevisions\.get\(key\) === revision\) continue;\n\s*edits\.delete\(key\);/);
  assert.match(graph, /rejectedMessage\.value = translateApiError\(cause, t, t\("agents\.graph\.saveFailed"\)\);/);
  assert.match(view, /:save="saveOrchestrationChange"/);
  assert.match(view, /await updateAgentOrchestration\(change\.orchestrationId, change\.nodeId, \{/);
});

test("agent selection and graph identities compose nodeId with node-local ids", () => {
  assert.match(catalog, /export function agentCatalogKey\(nodeId: string, objectId: string\)/);
  assert.match(view, /const agentsByKey = computed/);
  assert.match(view, /selectedAgentKey\.value = agentCatalogKey\(nodeId, saved\.id\);/);
  assert.match(graph, /id: member\.key,/);
  assert.match(graph, /agentId: member\.agentId,/);
});

test("the agent detail exposes orchestration membership and creation", () => {
  // 每个 Agent 默认有一张可编辑的编排；详情卡片列出它参与的全部编排，点击即跳进画布对应编排。
  assert.match(view, /const agentOrchestrations = computed\(\(\) => \(selectedAgent\.value/);
  assert.match(view, /agentParticipatingOrchestrations\(catalog\.value\.orchestrations, selectedAgent\.value\)/);
  assert.match(view, /Number\(right\.isDefault\) - Number\(left\.isDefault\)/);
  assert.match(view, /class="agent-orchestration-chip"/);
  assert.match(view, /@click="openOrchestrationInGraph\(orchestration\)"/);
  assert.match(view, /t\("agents\.detail\.orchestrationMembers", \{ count: orchestration\.agentIds\.length \}\)/);
  assert.match(view, /t\("agents\.detail\.orchestrationDefault"\)/);
  // 新建编排的入口就是当前 Agent：初始图只有它自己。
  assert.match(view, /const created = await createAgentOrchestration\(agent\.nodeId, \{ name, agentIds: \[agent\.id\], edges: \[\] \}\);/);
  assert.match(view, /<Dialog v-model:open="orchestrationCreateOpen">/);
  assert.match(view, /v-model="newOrchestrationName"/);
  assert.doesNotMatch(view, /window\.confirm/);
});

test("the manual run dialog binds the Run to a chosen orchestration", () => {
  assert.match(runDialog, /orchestrations: Array<\{ id: string; name: string; isDefault: boolean \}>;/);
  assert.match(runDialog, /<ControlPlaneSelect v-model="orchestrationId" :disabled="orchestrations\.length <= 1"/);
  assert.match(runDialog, /agents\.manualRun\.orchestrationHint/);
  // 缺省选中该 Agent 的默认编排；提交时把编排 id 带回视图的启动实现。
  assert.match(runDialog, /return props\.orchestrations\.find\(\(orchestration\) => orchestration\.isDefault\)\?\.id \|\| props\.orchestrations\[0\]\?\.id \|\| "";/);
  assert.match(runDialog, /@submit\.prevent="submit"/);
  assert.match(view, /await createManualAgentRun\(agent\.nodeId, \{\n\s*clientRequestId: createBrowserUuid\(\),\n\s*orchestrationId,\n\s*entryAgentId: agent\.id,/);
  assert.match(view, /:orchestrations="manualRunOrchestrations"/);
  assert.match(view, /:submit="launchManualRun"/);
});

test("the agent editor leaves Story association to the Story settings", () => {
  assert.doesNotMatch(editor, /useStoriesQuery/);
  assert.doesNotMatch(editor, /agents\.editor\.story/);
  assert.doesNotMatch(types, /storyId/);
  assert.match(types, /entryStoryLabels\?: string\[\]/);
  assert.match(view, /agents\.detail\.storyEntry/);
  assert.match(view, /const entryStoryLabels = computed/);
  assert.match(hook, /storyAgentEntriesQueryOptions\(story\.id, story\.ownerNodeId\)/);
  assert.match(catalog, /entryStoryLabels: entryStoryLabels\.get\(agentCatalogKey\(nodeId, agent\.id\)\) \?\? \[\]/);
});
