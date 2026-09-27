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
  assert.match(view, /const \{ catalog, loadingNodeIds, unavailableNodeIds, isPending, refetch \} = useAgentCatalog/);
  assert.match(view, /loadingNodeIds\.includes\(group\.nodeId\)/);
  assert.match(view, /unavailableNodeIds\.includes\(group\.nodeId\)/);
  assert.match(view, /!selectedAgent\.nodeOnline/);
  assert.match(types, /nodeOnline: boolean;/);
  assert.match(graph, /connectable: agent\.nodeOnline/);
  assert.match(graph, /deletable: agentByKey\(source\)\?\.nodeOnline === true/);
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
  assert.match(queries, /export function deleteAgentDefinition\(agentId: string, nodeId: string\)/);
  assert.match(view, /await invalidateControlPlaneDomains\(queryClient, \["agents"\]\);/);
  assert.match(view, /await createAgentDefinition\(nodeId, createInputFromDraft\(draft\)\)/);
  assert.match(view, /await updateAgentDefinition\(agent\.id, agent\.nodeId, \{/);
  assert.match(view, /await deleteAgentDefinition\(agent\.id, agent\.nodeId\)/);
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
  const handler = editor.slice(editor.indexOf("function selectInstance(instanceId: string)"), editor.indexOf("function selectProvider("));
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
  assert.match(view, /window\.confirm\(t\("agents\.confirm\.deleteAgent", \{ name: agent\.name \}\)\)/);
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

test("the agent graph renders the callable relation canvas with Vue Flow", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.ok(manifest.dependencies["@vue-flow/core"], "the graph canvas must come from Vue Flow");
  assert.match(graph, /import \{ Handle, MarkerType, Position, VueFlow \} from "@vue-flow\/core";/);
  assert.match(graph, /import "@vue-flow\/core\/dist\/style\.css";/);
  assert.match(graph, /v-model:nodes="flowNodes"/);
  assert.match(graph, /v-model:edges="flowEdges"/);
  assert.match(graph, /@connect="connect"/);
  assert.match(graph, /@edge-click="onEdgeClick"/);
  assert.match(graph, /data-agent-node="nodeProps\.id"/);
  assert.match(graph, /deletable: false/);
  assert.match(graph, /function connect\(connection: Connection\)/);
  assert.match(graph, /function removeEdge\(edge: Edge\)/);
  assert.match(graph, /agents\.graph\.rejected\.crossNode/);
  assert.match(graph, /agents\.graph\.rejected\.self/);
  assert.match(graph, /agents\.graph\.rejected\.cycle/);
  assert.match(graph, /function reaches\(start: string, goal: string\)/);
  assert.match(graph, /if \(reaches\(target, source\)\)/);
  assert.match(graph, /labels\.get\(nodeId\) \|\| nodeId/);
  assert.match(view, /<AgentGraph\s/);
  assert.match(view, /:agents="visibleAgents"/);
  assert.match(view, /const viewMode = ref<"list" \| "graph">\("list"\)/);
});

test("the agent graph submits only the callable sets that actually changed", () => {
  assert.match(graph, /save: \(changes: AgentCallableChange\[\]\) => Promise<void>;/);
  assert.match(graph, /const pendingChanges = computed<AgentCallableChange\[\]>\(\(\) => props\.agents\.flatMap\(\(agent\) => \{/);
  // 不可见的已保存引用必须原样保留，不能被本地投影静默清空。
  assert.match(graph, /const retained = source\.callableAgentIds\.filter\(\(targetId\) => !visible\.has\(targetId\)\);/);
  assert.match(graph, /if \(!changes\.length \|\| saving\.value\) return;/);
  // 无关的目录重算不能重置画布：只有投影或权威关系集合真的变化才重建。
  assert.match(graph, /watch\(layoutKey, \(\) => \{\n  flowNodes\.value = layoutNodes\(props\.agents, props\.nodes\);\n\}, \{ immediate: true \}\);/);
  assert.match(graph, /watch\(authorityKey, \(\) => \{\n  flowEdges\.value = baselineEdges\(\);\n\}, \{ immediate: true \}\);/);
  assert.match(graph, /rejectedMessage\.value = translateApiError\(cause, t, t\("agents\.graph\.saveFailed"\)\);/);
  assert.match(view, /:save="saveCallableChanges"/);
  assert.match(view, /callableAgentIds: change\.callableAgentIds,/);
});

test("agent selection and graph identities compose nodeId with node-local ids", () => {
  assert.match(catalog, /export function agentCatalogKey\(nodeId: string, objectId: string\)/);
  assert.match(view, /const agentsByKey = computed/);
  assert.match(view, /agentCatalogKey\(selectedAgent\.value\.nodeId, id\)/);
  assert.match(graph, /id: agent\.key/);
  assert.match(graph, /nodeId: agent\.nodeId, agentId: agent\.id/);
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
