import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/api/queries.ts"), "utf8");
const keySource = fs.readFileSync(path.join(root, "src/api/queryKeys.ts"), "utf8");
const workbenchSource = fs.readFileSync(path.join(root, "src/apps/control-plane/ControlPlaneWorkbench.vue"), "utf8");

test("control-plane query keys expose stable roots and scoped factories", () => {
  assert.match(source, /export \{ controlPlaneQueryKeys \} from "\.\/queryKeys\.ts"/);
  assert.match(keySource, /export const controlPlaneQueryKeys = \{/);
  assert.match(keySource, /nodeRuntimes: \["control-plane-node-runtimes-payload"\] as const/);
  assert.match(keySource, /instanceBoard: \["instance-board-payload"\] as const/);
  assert.match(keySource, /nodeLocalFolders: \(nodeId\?: string\) => nodeId[\s\S]*\["control-plane-node-local-folders", nodeId\]/);
  assert.match(keySource, /nodeImageCatalog: \(nodeId\?: string\) => nodeId[\s\S]*\["node-image-catalog", nodeId\]/);
});

test("node local-folder query options share the centralized key factory", () => {
  assert.match(source, /export function nodeLocalFoldersQueryOptions\(nodeId: string\) \{[\s\S]*queryKey: controlPlaneQueryKeys\.nodeLocalFolders\(nodeId\)[\s\S]*enabled: Boolean\(nodeId\)/);
  assert.match(source, /useQuery\(computed\(\(\) => nodeLocalFoldersQueryOptions\(resolvedNodeId\.value\)\)\)/);
});

test("plain and payload hooks share one payload cache per resource", () => {
  assert.equal((source.match(/queryKey: controlPlaneQueryKeys\.nodeRuntimes/g) || []).length, 2);
  assert.equal((source.match(/queryFn: \(\{ signal \}\) => fetchNodeRuntimesPayload\(signal\)/g) || []).length, 2);
  assert.match(source, /function instanceBoardQueryOptions\(\)[\s\S]*queryKey: controlPlaneQueryKeys\.instanceBoard[\s\S]*queryFn: \(\{ signal \}[^)]*\) => fetchInstanceBoardPayload\(signal\)[\s\S]*structuralSharing: mergeInstanceBoardQueryData/);
  assert.match(source, /useInstanceBoardQuery\(\)[\s\S]*\.\.\.instanceBoardQueryOptions\(\)/);
  assert.match(source, /useInstanceBoardPayloadQuery\(\)[\s\S]*useQuery\(instanceBoardQueryOptions\(\)\)/);
  assert.doesNotMatch(source, /queryKey: \["control-plane-node-runtimes"\]/);
  assert.doesNotMatch(source, /queryKey: \["instance-board"\]/);
});

test("workbench local folders consume the shared query cache", () => {
  assert.match(workbenchSource, /useQueries\(\{/);
  assert.match(workbenchSource, /nodeLocalFoldersQueryOptions/);
  assert.match(workbenchSource, /invalidateQueries\(\{ queryKey: controlPlaneQueryKeys\.nodeLocalFolders\(\) \}\)/);
  assert.doesNotMatch(workbenchSource, /getApiData<NodeLocalFolder\[\]>/);
  assert.doesNotMatch(workbenchSource, /reactive<Record<string, NodeLocalFolder\[\]>>/);
});

test("AI session snapshots do not rebuild unchanged node folder observers", () => {
  assert.match(workbenchSource, /const nodeLocalFolderNodeIds = ref<string\[\]>\(\[\]\);/);
  assert.match(workbenchSource, /next\.every\(\(nodeId, index\) => nodeId === nodeLocalFolderNodeIds\.value\[index\]\)\) return;/);
  assert.doesNotMatch(workbenchSource, /const nodeLocalFolderNodeIds = computed\(/);
});
