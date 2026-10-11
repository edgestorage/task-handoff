import assert from "node:assert/strict";
import test from "node:test";
import {
  InstanceResourceMetricsSchema,
  NODE_RUNTIME_TYPES,
  NodeRuntimeConsumerListSchema,
  NodeRuntimeSchema,
  NodeRuntimeTypeSchema,
  normalizeWslRuntimeCapabilities,
  nodeRuntimeTypeIsKnown,
} from "../src/control-plane.ts";
import {
  NODE_AGENT_SHARED_SPACE_RUNTIMES,
  normalizeNodeAgentCapabilities,
  supportsNodeAgentSharedSpace,
  supportsNodeGitWorkspaceProvisioning,
} from "../src/node-agent-capabilities.ts";

const timestamp = "2026-10-11T00:00:00.000Z";

function runtime(type: string, capabilities: Record<string, unknown> = {}) {
  return {
    id: `runtime_${type}`,
    nodeId: "node_one",
    name: `${type} runtime`,
    type,
    status: "online",
    accessStrategy: "node-proxy",
    capabilities,
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("NodeRuntimeSchema accepts the additive wsl runtime type and still rejects unknown types", () => {
  assert.deepEqual([...NODE_RUNTIME_TYPES], ["docker", "kubernetes", "local", "wsl"]);
  assert.equal(NodeRuntimeTypeSchema.parse("wsl"), "wsl");
  assert.equal(NodeRuntimeSchema.parse(runtime("wsl")).type, "wsl");
  assert.equal(nodeRuntimeTypeIsKnown("wsl"), true);
  assert.equal(nodeRuntimeTypeIsKnown("podman"), false);
  assert.equal(NodeRuntimeSchema.safeParse(runtime("podman")).success, false);
});

test("consumer runtime lists ignore unknown types instead of failing the whole table", () => {
  const parsed = NodeRuntimeConsumerListSchema.parse([
    runtime("docker"),
    runtime("wsl"),
    runtime("podman"),
    { id: "runtime_broken" },
    null,
  ]);
  assert.deepEqual(parsed.map((entry) => entry.type), ["docker", "wsl"]);
});

test("consumer runtime lists keep strict field validation for known types", () => {
  const invalid = { ...runtime("docker"), status: "broken" };
  assert.throws(() => NodeRuntimeConsumerListSchema.parse([invalid]));
});

test("new node agent capability document keeps wsl without resetting unrelated agent execution", () => {
  const capabilities = {
    agentExecution: {
      definitions: true,
      runs: true,
      sharedSpace: { enabled: true, runtimes: ["docker", "wsl", "podman"] },
    },
  };
  const normalized = normalizeNodeAgentCapabilities(capabilities);
  assert.deepEqual(normalized.agentExecution.sharedSpace.runtimes, ["docker", "wsl"]);
  assert.equal(normalized.agentExecution.definitions, true);
  assert.equal(normalized.agentExecution.runs, true);
  assert.equal(supportsNodeAgentSharedSpace(capabilities, "wsl"), true);
  assert.equal(supportsNodeAgentSharedSpace(capabilities, "podman"), false);
  assert.equal(supportsNodeAgentSharedSpace(capabilities, "local"), false);
  assert.deepEqual([...NODE_AGENT_SHARED_SPACE_RUNTIMES], ["docker", "local", "wsl"]);
});

test("shared space tolerates a future runtime value without falling back to defaults", () => {
  const normalized = normalizeNodeAgentCapabilities({
    agentExecution: {
      definitions: true,
      runs: true,
      sharedSpace: { enabled: true, runtimes: ["podman"] },
    },
  });
  assert.deepEqual(normalized.agentExecution.sharedSpace, { enabled: true, runtimes: [] });
  assert.equal(normalized.agentExecution.definitions, true);
  assert.equal(normalized.agentExecution.runs, true);
});

test("managed Git provisioning declares wsl and fails closed for unknown runtimes", () => {
  const node = {
    managedGitCredentials: {
      registry: true,
      runtimeBroker: true,
      workspaceProvisioning: { docker: true, wsl: true, podman: true },
    },
  };
  assert.equal(supportsNodeGitWorkspaceProvisioning(node, "wsl"), true);
  assert.equal(supportsNodeGitWorkspaceProvisioning(node, "docker"), true);
  assert.equal(supportsNodeGitWorkspaceProvisioning(node, "kubernetes"), false);
  assert.equal(supportsNodeGitWorkspaceProvisioning(node, "podman"), false);
  assert.deepEqual(normalizeNodeAgentCapabilities(node).managedGitCredentials.workspaceProvisioning, {
    docker: true,
    kubernetes: false,
    local: false,
    wsl: true,
  });
});

test("N-1 node agents normalize to no wsl support", () => {
  const legacy = { managedGitCredentials: { registry: true, runtimeBroker: true, workspaceProvisioning: { docker: true } } };
  assert.equal(supportsNodeGitWorkspaceProvisioning(legacy, "wsl"), false);
  assert.equal(supportsNodeAgentSharedSpace({ agentExecution: { sharedSpace: { enabled: true, runtimes: ["docker"] } } }, "wsl"), false);
  assert.equal(supportsNodeAgentSharedSpace({}, "wsl"), false);
  assert.equal(normalizeNodeAgentCapabilities({}).managedGitCredentials.workspaceProvisioning.wsl, false);
});

test("wsl publishes no execution combination and no new process sandbox value", () => {
  const normalized = normalizeNodeAgentCapabilities({
    agentExecution: {
      definitions: true,
      combinations: [
        { runtime: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance", providerId: "codex" },
        { runtime: "wsl", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance", providerId: "codex" },
        { runtime: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "wsl-distro", providerId: "codex" },
      ],
    },
  });
  assert.deepEqual(normalized.agentExecution.combinations, [{
    runtime: "docker",
    workspaceMaterializer: "overlay-copy-on-write",
    processSandbox: "instance",
    providerId: "codex",
  }]);
  assert.equal(normalized.agentExecution.definitions, true);
});

test("wsl instance resource metrics stay unpublished instead of mislabeled as docker", () => {
  assert.equal(InstanceResourceMetricsSchema.safeParse({
    instanceId: "inst_one",
    runtimeKind: "wsl",
    state: "available",
    sampledAt: timestamp,
  }).success, false);
});

test("wsl runtime capabilities normalize to the documented defaults", () => {
  assert.deepEqual(normalizeWslRuntimeCapabilities(), {
    requiresImage: false,
    artifactKind: "bundled-runtime-artifact",
    isolation: "distro",
    supportsControlledInstanceApi: true,
    supportsContainerLifecycle: false,
    supportsAppSessions: true,
    supportsHostSessions: false,
    workspaceProvisioning: { git: false, localFolder: false },
    baseProfiles: [],
  });
  const declared = normalizeWslRuntimeCapabilities({
    workspaceProvisioning: { git: true, localFolder: true },
    baseProfiles: ["default"],
    future: true,
  });
  assert.equal(declared.requiresImage, false);
  assert.equal(declared.artifactKind, "bundled-runtime-artifact");
  assert.deepEqual(declared.workspaceProvisioning, { git: true, localFolder: true });
  assert.deepEqual(declared.baseProfiles, ["default"]);
  assert.equal("future" in declared, false);
});
