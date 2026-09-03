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
  assert.match(source, /export function instanceBoardQueryOptions\(instanceId:[\s\S]*queryKey: computed\(\(\) => controlPlaneQueryKeys\.scopedInstanceBoard\(toValue\(instanceId\)\)\)[\s\S]*queryFn: \(\{ signal \}[^)]*\) => fetchInstanceBoardPayload\(signal, toValue\(instanceId\)\)[\s\S]*structuralSharing: mergeInstanceBoardQueryData/);
  const boardOptions = source.match(/export function instanceBoardQueryOptions[\s\S]*?\n\}/)?.[0] || "";
  assert.match(boardOptions, /staleTime: Infinity/);
  assert.match(boardOptions, /refetchOnWindowFocus: false/);
  assert.match(boardOptions, /refetchOnReconnect: false/);
  assert.match(source, /useInstanceBoardQuery\(instanceId:[\s\S]*\.\.\.instanceBoardQueryOptions\(instanceId\)/);
  assert.match(source, /useInstanceBoardPayloadQuery\(\)[\s\S]*useQuery\(instanceBoardQueryOptions\(\)\)/);
  assert.doesNotMatch(source, /queryKey: \["control-plane-node-runtimes"\]/);
  assert.doesNotMatch(source, /queryKey: \["instance-board"\]/);
});

test("AI Session summaries recover through their revisioned stream instead of focus refetches", () => {
  const query = source.match(/export function useControlPlaneAiSessionsQuery[\s\S]*?\n\}/)?.[0] || "";
  assert.match(query, /staleTime: Infinity/);
  assert.match(query, /refetchOnWindowFocus: false/);
  assert.match(query, /refetchOnReconnect: false/);
});

test("Story snapshots persist across view remounts and converge through events", () => {
  const query = source.match(/export function useStoriesQuery[\s\S]*?\n\}/)?.[0] || "";
  assert.match(query, /staleTime: Infinity/);
  assert.match(query, /gcTime: Infinity/);
  assert.match(query, /refetchOnWindowFocus: false/);
  assert.match(query, /refetchOnReconnect: false/);
});

test("instance directory and scoped board reads stay progressive", () => {
  assert.match(source, /function fetchInstanceBoardPayload[\s\S]*params\.set\("progressive", "true"\)[\s\S]*if \(instanceId\) params\.set\("instanceId", instanceId\)/);
  assert.match(source, /useInstanceDirectoryQuery[\s\S]*sharedControlPlaneClient\.resources\.instanceDirectory\(signal\)/);
  assert.match(workbenchSource, /const standaloneBoardPending = computed\([\s\S]*state\.resource === "instances"[\s\S]*state\.phase === "loading"/);
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
