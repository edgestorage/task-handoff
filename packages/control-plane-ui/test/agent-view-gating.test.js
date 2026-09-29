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
const switcher = read("src/apps/control-plane/agent/AgentViewSwitcher.vue");
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
  assert.match(view, /@orchestration="openAgentOrchestrationInGraph\(agent\.key\)"/);
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
  assert.match(contextMenu, /agents\.detail\.editOrchestration/);
  // 「查看 Agent 详情」只属于画布节点菜单：列表行单击即可选中，所以列表不传这个入口。
  assert.doesNotMatch(view, /:view-detail=/);
  // 用对象而不是 boolean 表示「不传 = 不提供」：Vue 会把缺省的 boolean prop 强转成 false，那样列表里会多出一个灰项。
  assert.match(contextMenu, /viewDetail\?: \{ enabled: boolean \};/);
  assert.match(contextMenu, /<ContextMenuItem v-if="viewDetail" class="ai-session-context-menu-item" :disabled="!viewDetail\.enabled"/);
  assert.match(contextMenu, /class="ai-session-context-menu-item danger"/);
  assert.match(contextMenu, /agents\.detail\.delete/);
  assert.match(contextMenu, /defineEmits<\{\n  run: \[\];\n  edit: \[\];\n  viewDetail: \[\];\n  orchestration: \[\];\n  delete: \[\];\n\}>\(\);/);
  // 「编辑编排」只在列表行提供，可用性与编辑同源：节点在线且发布了编排能力；画布节点本身就在编排里，不重复给入口。
  assert.match(view, /:orchestration="\{ label: 'edit', enabled: agent\.nodeOnline && nodeOrchestrationsSupported\(agent\.nodeId\) \}"/);
  assert.match(view, /function nodeOrchestrationsSupported\(nodeId\?: string\) \{[\s\S]*?controlPlaneAgentCapabilities\(node\.capabilities\)\.orchestrations[\s\S]*?\}/);
  // 右键进入编排后落在该 Agent 的第一张编排上：入口组优先，组的顺序只在目录层定义一次。
  assert.match(view, /function openAgentOrchestrationInGraph\(agentKey: string\) \{[\s\S]*?selectedAgentKey\.value = agent\.key;[\s\S]*?graphOrchestrationKey\.value = agentFirstOrchestration\(visibleOrchestrations\.value, agent\)\?\.key \|\| "";[\s\S]*?viewMode\.value = "graph";[\s\S]*?\n\}/);
});

test("the agent graph keeps canvas clicks local and switches agents from the node menu", () => {
  // 单击节点只选中画布元素，不再切换当前 Agent：切 Agent 一律由节点右键菜单显式触发。
  assert.doesNotMatch(graph, /@node-click/);
  assert.doesNotMatch(graph, /emit\("select"/);
  assert.doesNotMatch(view, /@select="selectedAgentKey = \$event"/);
  // 节点菜单补齐「查看 Agent 详情」与「查看编排」，可用性与成员是否在线、是否仍存在对齐。
  assert.match(graph, /:view-detail="\{ enabled: !nodeProps\.data\.missing \}"/);
  assert.match(graph, /:orchestration="\{ label: 'view', enabled: !nodeProps\.data\.missing && nodeProps\.data\.online \}"/);
  assert.match(graph, /@view-detail="viewMemberDetail\(nodeProps\.data\.agentId\)"/);
  assert.match(graph, /@orchestration="viewMemberOrchestration\(nodeProps\.data\.agentId\)"/);
  assert.match(graph, /function viewMemberDetail\(agentId: string\) \{[\s\S]*?requestDetail\(agent\.key\);[\s\S]*?\n\}/);
  assert.match(graph, /function viewMemberOrchestration\(agentId: string\) \{[\s\S]*?emit\("show-orchestration", agent\.key\);[\s\S]*?\n\}/);
  // 离开画布会丢弃草稿，所以节点菜单切详情与头部切换器共用同一条确认，再带上目标 Agent。
  assert.match(graph, /@select-detail="requestDetail\(\)"/);
  assert.match(graph, /function requestDetail\(agentKey\?: string\) \{[\s\S]*?emit\("show-detail", agentKey\);[\s\S]*?\n\}/);
  assert.match(graph, /"show-detail": \[agentKey\?: string\]/);
  assert.match(graph, /"show-orchestration": \[agentKey: string\]/);
  assert.match(view, /@show-detail="showAgentDetail"/);
  assert.match(view, /@show-orchestration="openAgentOrchestrationInGraph"/);
  assert.match(view, /function showAgentDetail\(agentKey\?: string\) \{[\s\S]*?viewMode\.value = "detail";[\s\S]*?\n\}/);
});

test("the agent graph opens the same actions from a node right-click menu", () => {
  // 画布节点与列表行共用同一个操作菜单，操作事件只回传聚合 key，由视图解析回目录对象。
  assert.match(graph, /<template #node-agent="nodeProps">[\s\S]*?<ContextMenu>\n\s*<ContextMenuTrigger as-child>/);
  assert.match(graph, /<AgentContextMenu\n\s*:can-run="canRunMember\(nodeProps\.data\.agentId\)"\n\s*:editable="editable && !nodeProps\.data\.missing"\n\s*:deleting="deleting"\n\s*:view-detail="\{ enabled: !nodeProps\.data\.missing \}"\n\s*:orchestration="\{ label: 'view', enabled: !nodeProps\.data\.missing && nodeProps\.data\.online \}"/);
  assert.match(graph, /@run="runMember\(nodeProps\.data\.agentId\)"/);
  assert.match(graph, /@edit="editMember\(nodeProps\.data\.agentId\)"/);
  assert.match(graph, /@delete="deleteMember\(nodeProps\.data\.agentId\)"/);
  assert.match(graph, /import \{ agentManualRunAvailable, agentOrchestrationGroups, agentRunOrchestrations, orchestrationAgentCandidates, requestedOrchestrationKey \} from "\.\/agentCatalog";/);
  assert.match(graph, /import type \{ AgentOrchestrationRequest \} from "\.\/agentCatalog";/);
  assert.match(graph, /deleting: boolean;/);
  assert.match(view, /:deleting="deleting"[\s\S]*?:save="saveOrchestrationChange"[\s\S]*?@run="runAgentByKey"[\s\S]*?@edit="editAgentByKey"[\s\S]*?@delete="deleteAgentByKey"/);
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
  assert.match(graph, /import \{ Handle, MarkerType, Position, VueFlow, useVueFlow \} from "@vue-flow\/core";/);
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
  assert.match(view, /const viewMode = ref<"detail" \| "graph">\("detail"\)/);
});

test("the agent graph switcher groups orchestrations by entry and participating scope", () => {
  // 画布一次只投影一张权威编排；切换菜单一次列出两个作用域，入口组在前，参与组剔除入口编排避免重复。
  // 分组只在目录层定义一次：详情侧与画布都消费 agentOrchestrationGroups，不再各写一份分组逻辑。
  assert.match(catalog, /export function agentOrchestrationGroups\(orchestrations: AgentCatalogOrchestration\[\], agent: AgentCatalogAgent\): AgentOrchestrationGroup\[\] \{[\s\S]*?const entry = agentEntryOrchestrations\(orchestrations, agent\);[\s\S]*?const participating = agentParticipatingOrchestrations\(orchestrations, agent\)\.filter\(\(orchestration\) => !entryKeys\.has\(orchestration\.key\)\);[\s\S]*?\n\}/);
  assert.match(graph, /const orchestrationGroups = computed\(\(\) => \(focusAgent\.value \? agentOrchestrationGroups\(props\.orchestrations, focusAgent\.value\) : \[\]\)\);/);
  assert.match(view, /const switcherGroups = computed\(\(\) => \(selectedAgent\.value \? agentOrchestrationGroups\(visibleOrchestrations\.value, selectedAgent\.value\) : \[\]\)\);/);
  assert.match(graph, /const availableOrchestrations = computed\(\(\) => \(focusAgent\.value \? orchestrationGroups\.value\.flatMap\(\(group\) => group\.orchestrations\) : props\.orchestrations\)\);/);
  // 当前编排是「请求」的派生结果：详情页点参与组的编排也必须落在它自己，只有它不再可切换时才回落到第一张。
  assert.match(graph, /const requested = ref<AgentOrchestrationRequest>\(\{ agentKey: focusKey\.value, key: props\.orchestrationKey \?\? "" \}\);/);
  assert.match(graph, /const activeKey = computed\(\(\) => requestedOrchestrationKey\(availableOrchestrations\.value, requested\.value, focusKey\.value\)\);/);
  assert.match(graph, /function selectOrchestration\(key: string\) \{\n\s*requested\.value = \{ agentKey: focusKey\.value, key \};\n\}/);
  // 换 Agent 一律作废旧请求：列表切换后必须落在新 Agent 的第一张编排，而不是另一张「对新 Agent 也可切换」的旧编排。
  assert.match(graph, /watch\(focusKey, \(agentKey\) => \{\n\s*requested\.value = \{ agentKey, key: "" \};\n\s*\}\);/);
  assert.doesNotMatch(graph, /activeKey\.value = |const activeKey = ref/);
  // 内容选择器渲染分组菜单；画布把同一份分组、当前编排与草稿圆点传给它，详情侧复用同一组件。
  assert.match(graph, /<AgentViewSwitcher\s+mode="graph"\s+:active-key="activeKey"\s+:groups="orchestrationGroups"\s+:draft-counts="draftCounts"/);
  assert.match(view, /<AgentViewSwitcher\s+mode="detail"\s+:active-key="graphOrchestrationKey"\s+:groups="switcherGroups"/);
  assert.match(switcher, /<DropdownMenuRadioGroup :model-value="mode === 'graph' \? activeKey : ''" @update:model-value="selectOrchestration">/);
  assert.match(switcher, /<DropdownMenuLabel class="agent-view-switcher-label">[\s\S]*?agents\.graph\.scope\.entry[\s\S]*?agents\.graph\.scope\.participating[\s\S]*?<\/DropdownMenuLabel>/);
  // 视图可以从详情卡片跳进某张编排，画布内部切换也会同步回视图。
  assert.match(graph, /watch\(\(\) => props\.orchestrationKey, \(key\) => \{/);
  assert.match(graph, /if \(key !== props\.orchestrationKey\) emit\("orchestration-change", key\);/);
  assert.match(view, /@orchestration-change="graphOrchestrationKey = \$event"/);
  assert.match(view, /function openOrchestrationInGraph\(orchestration: AgentCatalogOrchestration\) \{/);
  assert.match(view, /graphOrchestrationKey\.value = orchestration\.key;\n\s*viewMode\.value = "graph";/);
  assert.match(view, /function openOrchestrationInGraphByKey\(key: string\) \{[\s\S]*?graphOrchestrationKey\.value = key;[\s\S]*?viewMode\.value = "graph";[\s\S]*?\n\}/);
  // 从上到下分层：调用深度决定行，层内顺序用重心扫描，横向位置做松弛对齐。
  assert.match(graph, /function buildLayers\(keys: string\[\], edges: LayerEdges\): string\[\]\[\]/);
  assert.match(graph, /const depth = new Map\(keys\.map\(\(key\) => \[key, 0\]\)\);/);
  assert.match(graph, /function orderLayers\(layers: string\[\]\[\], edges: LayerEdges\): string\[\]\[\]/);
  assert.match(graph, /function layeredColumns\(layers: string\[\]\[\], edges: LayerEdges\): Map<string, number>/);
  assert.match(graph, /y: CANVAS_ORIGIN \+ \(depth\.get\(member\.key\) \?\? 0\) \* rowStep,/);
  // 连线手柄改为上下方向，边从上往下走。
  assert.match(graph, /:position="Position\.Top"/);
  assert.match(graph, /:position="Position\.Bottom"/);
  // 初始缩放带 maxZoom 上限：整棵树先落进视口，小图仍保持可读字号。
  assert.match(graph, /const FIT_VIEW_MAX_ZOOM = 1\.1;/);
  assert.match(graph, /const \{ fitView, connectionEndHandle, onNodesInitialized, onMoveStart \} = useVueFlow\(\);/);
  // 浮层锚在画布内的节点上，平移缩放后立刻关掉，避免脱锚。
  assert.match(graph, /onMoveStart\(\(\) => \{\n  addPickerKey\.value = "";\n\}\);/);
  assert.match(graph, /void fitView\(\{ padding: FIT_VIEW_PADDING, maxZoom: FIT_VIEW_MAX_ZOOM, duration: 0 \}\);/);
  // 拖拽落在画布空白处时给出画布范围说明，不静默无响应。
  assert.match(graph, /rejectedMessage\.value = t\("agents\.graph\.rejected\.outOfScope"\);/);
});

test("the agent graph header keeps identity, save state and actions on one band", () => {
  // 头部只有一条控制带：编排切换、可编辑名称、默认标记与保存状态属于文档身份，操作按钮在右。
  assert.match(graph, /<header class="agent-graph-head">/);
  assert.match(graph, /<div class="agent-graph-identity">[\s\S]*<AgentViewSwitcher[\s\S]*class="agent-graph-name-field"[\s\S]*class="agent-graph-badge"[\s\S]*agent-graph-state/);
  assert.match(graph, /<div class="agent-graph-actions">[\s\S]*agents\.graph\.reset[\s\S]*agents\.graph\.save/);
  // 内容选择器把详情固定在顶部、编排列表设为可滚动、新建入口固定在底部，入口不随列表溢出。
  assert.match(switcher, /<DropdownMenuRadioItem :value="DETAIL_ITEM" class="agent-view-switcher-item">/);
  assert.match(switcher, /<DropdownMenuSeparator class="agent-view-switcher-separator" \/>/);
  assert.match(switcher, /class="agent-view-switcher-create" :disabled="!canCreate" @select="emit\('create'\)"/);
  assert.match(switcher, /\.agent-view-switcher-menu\.agent-view-switcher-menu\) \{[^}]*display:flex;[^}]*flex-direction:column;/);
  assert.match(switcher, /\.agent-view-switcher-list\) \{[^}]*overflow-y:auto;/);
  assert.doesNotMatch(graph, /agent-graph-toolbar|agent-graph-hint|agent-graph-meta/);
  // 画布手势说明常驻在帮助浮层里，不再占着画布上方铺一段说明文字。
  assert.match(graph, /<PopoverTrigger as-child>[\s\S]*agents\.graph\.help\.title/);
  for (const key of ["intro", "move", "connect", "removeEdge", "removeMember"]) {
    assert.match(graph, new RegExp(`agents\\.graph\\.help\\.${key}`), `the help popover must explain ${key}`);
  }
  // 删除编排是危险操作，收进更多操作菜单。
  assert.match(graph, /class="agent-graph-danger-item" :disabled="!editable \|\| deleting" @select="removeActiveOrchestration"/);
  // 名称与 Story 头部同一交互：hover 提示可编辑，点击后才换成输入框；Enter/失焦提交，Esc 丢弃草稿。
  assert.match(graph, /class="agent-graph-name-button"[\s\S]*?@click="beginNameEdit\(\$event\)"/);
  assert.match(graph, /class="agent-graph-name-input"[\s\S]*?@blur="endNameEdit"[\s\S]*?@keydown="handleNameEditKeydown"/);
  assert.match(graph, /function handleNameEditKeydown\(event: KeyboardEvent\) \{[\s\S]*?if \(event\.isComposing\) return;[\s\S]*?event\.key === "Enter"[\s\S]*?endNameEdit\(\)[\s\S]*?event\.key === "Escape"[\s\S]*?cancelNameEdit\(\)/);
  assert.match(graph, /function cancelNameEdit\(\) \{[\s\S]*?revertNameDraft\(\);[\s\S]*?\n\}/);
  assert.match(graph, /function revertNameDraft\(\) \{[\s\S]*?orchestrationName\.value = orchestration\.name;[\s\S]*?\n\}/);
  assert.match(graph, /\.agent-graph-name-button:hover \.agent-graph-name-button-label[^}]*background:var\(--surface-hover\);/);
  // ⌘/Ctrl + S 在画布内保存，交给同一份 save 实现；选择器标出仍有本地草稿的编排。
  assert.match(graph, /@keydown\.capture="handleShortcut"/);
  assert.match(graph, /function handleShortcut\(event: KeyboardEvent\) \{[\s\S]*?event\.key\.toLowerCase\(\) !== "s"[\s\S]*?void save\(\);[\s\S]*?\n\}/);
  assert.match(graph, /const draftCounts = computed\(\(\) => \{[\s\S]*?counts\[orchestration\.key\] = count;[\s\S]*?\n\}\);/);
  assert.match(switcher, /v-if="draftCount\(orchestration\.key\)" class="agent-view-switcher-pending"/);
  // 画布有未保存改动时先确认再离开，AgentView 收到事件才切回详情（节点菜单会带上目标 Agent）。
  assert.match(graph, /function requestDetail\(agentKey\?: string\) \{[\s\S]*?window\.confirm\(t\("agents\.graph\.discardOnSwitch", \{ count: dirtyCount\.value \}\)\)[\s\S]*?emit\("show-detail", agentKey\);[\s\S]*?\n\}/);
  assert.match(view, /@show-detail="showAgentDetail"/);
  // 菜单条目：名称占满剩余宽度，名称与「默认」标记、草稿圆点之间留出间距。
  assert.match(switcher, /\.agent-view-switcher-item\) \{[^}]*gap:8px;/);
  assert.match(switcher, /\.agent-view-switcher-name\) \{[^}]*flex:1 1 auto;/);
});

test("the agent detail header renames the agent inline", () => {
  // 列表模式的 Agent 名称与 Story 头部同一交互：hover 后点击进入编辑，提交写回 Node 权威定义。
  assert.match(view, /class="agent-title-name-button"[\s\S]*?@click="beginAgentNameEdit\(selectedAgent, \$event\)"/);
  assert.match(view, /class="agent-title-name-input"[\s\S]*?@blur="commitAgentNameEdit"[\s\S]*?@keydown="handleAgentNameEditKeydown"/);
  assert.match(view, /function handleAgentNameEditKeydown\(event: KeyboardEvent\) \{[\s\S]*?if \(event\.isComposing\) return;[\s\S]*?event\.key === "Enter"[\s\S]*?commitAgentNameEdit\(\)[\s\S]*?event\.key === "Escape"[\s\S]*?cancelAgentNameEdit\(\)/);
  assert.match(view, /await updateAgentDefinition\(agent\.id, agent\.nodeId, \{ expectedRevision: agent\.revision, name \}\);/);
  assert.match(view, /await invalidateControlPlaneDomains\(queryClient, \["agents"\]\);/);
  assert.match(view, /\.agent-title-name-button:hover \.agent-title-name-button-label[^}]*background:var\(--surface-hover\);/);
  assert.match(view, /\.agent-content-title h2\.agent-title-name-field \{[^}]*width:max-content;[^}]*max-width:100%;/);
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
  assert.match(graph, /markerEnd: MarkerType\.ArrowClosed,/);
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
  // 编排关系由编排图维护，编辑器里不再放一段没有可操作内容的说明区块。
  assert.doesNotMatch(editor, /agents\.editor\.orchestration/);
  assert.doesNotMatch(types, /storyId/);
  assert.match(types, /entryStoryLabels\?: string\[\]/);
  assert.match(view, /agents\.detail\.storyEntry/);
  assert.match(view, /const entryStoryLabels = computed/);
  assert.match(hook, /storyAgentEntriesQueryOptions\(story\.id, story\.ownerNodeId\)/);
  assert.match(catalog, /entryStoryLabels: entryStoryLabels\.get\(agentCatalogKey\(nodeId, agent\.id\)\) \?\? \[\]/);
});
