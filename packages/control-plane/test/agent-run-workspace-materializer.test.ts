import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUN_WORKSPACE_ROOT,
  agentRunWorkspaceLayout,
  assertAgentRunWorkspacePath,
  createAgentRunWorkspaceMarker,
  workspaceMarkerMatches,
} from "../src/node-agent/agents/workspace-materializer.ts";

test("Agent Run workspace layout is deterministic and member-scoped", () => {
  const layout = agentRunWorkspaceLayout("run_one", "member_root");
  assert.equal(layout.runRoot, `${AGENT_RUN_WORKSPACE_ROOT}/run_one`);
  assert.equal(layout.memberRoot, `${AGENT_RUN_WORKSPACE_ROOT}/run_one/member_root`);
  assert.equal(layout.cwd, `${layout.memberRoot}/merged`);
  assert.equal(layout.markerPath, `${layout.memberRoot}/.task-handoff-agent-run.json`);
  assert.notEqual(agentRunWorkspaceLayout("run_one", "member_two").cwd, layout.cwd);
});

test("Agent Run workspace paths reject traversal and sibling roots", () => {
  assert.throws(() => agentRunWorkspaceLayout("../run", "member_root"), (error: any) => error.code === "AGENT_RUN_WORKSPACE_ID_INVALID");
  assert.throws(() => agentRunWorkspaceLayout("run_one", "/member"), (error: any) => error.code === "AGENT_RUN_WORKSPACE_ID_INVALID");
  assert.equal(
    assertAgentRunWorkspacePath(`${AGENT_RUN_WORKSPACE_ROOT}/run_one`, `${AGENT_RUN_WORKSPACE_ROOT}/run_one/member/merged`),
    `${AGENT_RUN_WORKSPACE_ROOT}/run_one/member/merged`,
  );
  assert.throws(
    () => assertAgentRunWorkspacePath(`${AGENT_RUN_WORKSPACE_ROOT}/run_one`, `${AGENT_RUN_WORKSPACE_ROOT}/run_two/member/merged`),
    (error: any) => error.code === "AGENT_RUN_WORKSPACE_PATH_OUTSIDE_ROOT",
  );
});

test("Workspace ownership requires the complete generation marker", () => {
  const marker = createAgentRunWorkspaceMarker({
    runId: "run_one",
    memberId: "member_root",
    generationId: "generation_one",
    createdAt: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(workspaceMarkerMatches(marker, marker), true);
  assert.equal(workspaceMarkerMatches(marker, { ...marker, generationId: "generation_other" }), false);
  assert.equal(workspaceMarkerMatches({ ...marker, version: 2 as 1 }, marker), false);
});
