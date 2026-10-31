import assert from "node:assert/strict";
import test from "node:test";

import {
  aiSessionApprovalDecisions,
  aiSessionApprovalItems,
  approvalCenterBadgeText,
  approvalCenterPendingCount,
  deviceTrustApprovalItems,
  mergeApprovalCenterItems,
  nodeControlPlaneTrustApprovalItems,
  operationApprovalItems,
  storyDecisionApprovalItems,
  type ApprovalCenterItem,
} from "../src/approval-center.ts";

const ts = (minute: number) => `2026-10-31T00:${String(minute).padStart(2, "0")}:00.000Z`;
const fingerprint = `sha256:${"a".repeat(43)}`;

function aiSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_a",
    agent: "codex",
    cwd: "/workspace",
    startedAt: ts(0),
    updatedAt: ts(1),
    status: "waiting",
    phase: "approval",
    ...overrides,
  };
}

function instance(agent: string, approvalDecisions: string[], overrides: Record<string, unknown> = {}) {
  return {
    instanceId: "ins_a",
    instanceName: "Instance A",
    capabilities: { aiSessionProviders: [{ agent, actions: { approvalDecisions }, timeline: {} }] },
    aiSessions: { sessions: [aiSession({ agent })] },
    ...overrides,
  };
}

function storyDecision(overrides: Record<string, unknown> = {}) {
  return {
    id: "dec_a",
    storyId: "stry_a",
    actionId: "act_a",
    storyRunId: "srun_a",
    sessionId: "ses_a",
    turnId: "trn_a",
    question: "Continue?",
    options: [],
    allowFreeText: true,
    status: "pending",
    revision: 1,
    createdAt: ts(2),
    updatedAt: ts(2),
    ...overrides,
  };
}

function story(overrides: Record<string, unknown> = {}) {
  return {
    id: "stry_a",
    ownerNodeId: "nod_a",
    title: "Story A",
    documents: [],
    actions: [],
    createdAt: ts(0),
    updatedAt: ts(0),
    ...overrides,
  };
}

const operationRequest = {
  id: "apr_a",
  operation: "instance.delete",
  targetId: "ins_a",
  createdAt: ts(3),
  expiresAt: "2026-10-31T01:00:00.000Z",
};

const deviceRequest = {
  source: "control-plane-device",
  requestId: "dtr_a",
  status: "pending",
  reason: "first-seen",
  device: { name: "Phone", kind: "mobile", platform: "ios" },
  fingerprint,
  comparisonCode: "AAAA-BBBB-CCCC-DDDD",
  bindingId: "bind_a",
  accountId: "acct_a",
  ownerAccountId: "acct_a",
  accessMode: "owner",
  cloudAccessRoleId: "role_a",
  requestedAt: ts(4),
  lastSeenAt: ts(4),
  expiresAt: "2026-10-31T01:00:00.000Z",
  revision: 1,
};

const nodeRequest = {
  controlPlaneId: "cp_a",
  fingerprint,
  comparisonCode: "AAAA-BBBB-CCCC-DDDD",
  nodeHandle: "node-a",
  bindingId: "bind_a",
  bindingRevision: 1,
  access: {
    userId: "usr_a",
    permissions: [],
    roleIds: [],
  },
  requestId: "ntr_a",
  status: "pending",
  reason: "first-seen",
  requestedAt: ts(5),
  lastSeenAt: ts(5),
  expiresAt: "2026-10-31T01:00:00.000Z",
  revision: 1,
};

test("approval-center projections combine all five sources and use one stable order", () => {
  const items: ApprovalCenterItem[] = [
    ...aiSessionApprovalItems("cp_a", [instance("codex", ["allow", "deny"])]),
    ...storyDecisionApprovalItems("cp_a", [{ story: story() as never, decisions: [storyDecision() as never] }]),
    ...operationApprovalItems("cp_a", [operationRequest as never]),
    ...deviceTrustApprovalItems("cp_a", {
      revision: 1,
      requests: [deviceRequest as never],
      trustedDevices: [],
      roles: [{ roleId: "role_a", name: "Operator", status: "active", system: false }],
    } as never),
    ...nodeControlPlaneTrustApprovalItems("cp_a", [{
      nodeId: "nod_a",
      snapshot: {
        nodeId: "nod_a",
        requests: [nodeRequest as never],
        pins: [],
      } as never,
    }]),
  ];
  const merged = mergeApprovalCenterItems(items);

  assert.deepEqual(merged.map((item) => item.type), [
    "node-control-plane-trust",
    "device-trust",
    "operation-approval",
    "story-decision",
    "ai-session-approval",
  ]);
  assert.equal(approvalCenterPendingCount(merged), 5);
  assert.deepEqual(merged, mergeApprovalCenterItems([...merged].reverse()));
  assert.deepEqual(
    merged.find((item) => item.type === "device-trust")?.roles.map((role) => role.name),
    ["Operator"],
  );
});

test("equal timestamps use the stable business key instead of input order", () => {
  const sameTimestamp = [
    { ...operationRequest, id: "apr_b", createdAt: ts(3) },
    { ...operationRequest, id: "apr_a", createdAt: ts(3) },
  ];
  const forward = mergeApprovalCenterItems(operationApprovalItems("cp_a", sameTimestamp as never));
  const reverse = mergeApprovalCenterItems(operationApprovalItems("cp_a", [...sameTimestamp].reverse() as never));

  assert.deepEqual(forward.map((item) => item.type === "operation-approval" && item.request.id), ["apr_a", "apr_b"]);
  assert.deepEqual(forward, reverse);
});

test("stable keys include Control Plane identity for identical source ids", () => {
  const first = operationApprovalItems("cp_a", [operationRequest as never])[0];
  const second = operationApprovalItems("cp_b", [operationRequest as never])[0];

  assert.notEqual(first.key, second.key);
  assert.equal(first.key.includes("cp_a"), true);
  assert.equal(second.key.includes("cp_b"), true);
});

test("source projections exclude terminal, archived, wrong-source and unsupported items", () => {
  assert.deepEqual(storyDecisionApprovalItems("cp_a", [
    { story: story({ archivedAt: ts(5) }) as never, decisions: [storyDecision() as never] },
    { story: story() as never, decisions: [storyDecision({ status: "decided" }) as never] },
  ]), []);
  assert.equal(deviceTrustApprovalItems("cp_a", {
    revision: 1,
    requests: [{ ...deviceRequest, source: "node-control-plane" }, { ...deviceRequest, status: "approved" }],
    trustedDevices: [],
    roles: [],
  } as never).length, 0);
  assert.equal(nodeControlPlaneTrustApprovalItems("cp_a", [{
    nodeId: "nod_a",
    snapshot: { nodeId: "nod_a", requests: [{ ...nodeRequest, status: "approved" }], pins: [] },
  } as never]).length, 0);
});

test("AI Session approval requires a pending session and executable provider action", () => {
  assert.deepEqual(aiSessionApprovalDecisions(aiSession({ agent: "opencode" }) as never, {
    aiSessionProviders: [{ agent: "opencode", actions: { approvalDecisions: [] }, timeline: {} }],
  }), []);
  assert.equal(aiSessionApprovalItems("cp_a", [instance("opencode", [])]).length, 0);
  assert.deepEqual(aiSessionApprovalItems("cp_a", [instance("codex", ["allow"])]).map((item) => item.decisions), [["allow"]]);
  assert.equal(aiSessionApprovalItems("cp_a", [{
    ...instance("codex", ["allow"]),
    aiSessions: { sessions: [aiSession({ status: "idle", phase: "responding" })] },
  }]).length, 0);
});

test("pending badge text preserves the true large count", () => {
  assert.equal(approvalCenterBadgeText(0), "0");
  assert.equal(approvalCenterBadgeText(99), "99");
  assert.equal(approvalCenterBadgeText(100), "99+");
  assert.equal(approvalCenterPendingCount([]), 0);
});
