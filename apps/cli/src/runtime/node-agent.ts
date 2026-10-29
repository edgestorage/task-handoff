import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { resolvePackageVersion } from "@task-handoff/core/core/package-version";
import {
  defaultNodeAgentDataDir,
  fetchNodeAgentIpc,
  nodeAgentIpcPath,
  runNodeAgentServer,
  uninstallNodeAgent,
} from "@task-handoff/control-plane/node-agent";
import {
  NodeAgentControlPlaneTrustSnapshotSchema,
  type NodeAgentControlPlaneTrustRequest,
  type NodeAgentControlPlaneTrustSnapshot,
} from "@task-handoff/protocol/node-agent-control-plane-trust";
import {
  UpdateCheckResultSchema,
  UpdateJobSchema,
  type UpdateChannel,
  type UpdateCheckResult,
  type UpdateJob,
} from "@task-handoff/protocol/control-plane";

// The Linux service installer listens here explicitly. Keep the same default
// for one-off CLI commands run through sudo, where the service's environment
// file is not loaded and the invoking user's data directory is not the agent's.
const INSTALLED_NODE_AGENT_IPC_PATH = "/run/task-handoff/node-agent.sock";
const UPDATE_POLL_INTERVAL_MS = 1_000;
const UPDATE_WAIT_TIMEOUT_SECONDS = 15 * 60;
const TERMINAL_UPDATE_STATUSES = new Set<UpdateJob["status"]>(["succeeded", "degraded", "failed"]);

function resolveNodeAgentIpcPath(explicitIpcPath?: string, dataDir?: string) {
  if (explicitIpcPath) return explicitIpcPath;
  if (!dataDir && process.platform !== "win32") {
    try {
      if (fs.statSync(INSTALLED_NODE_AGENT_IPC_PATH).isSocket()) return INSTALLED_NODE_AGENT_IPC_PATH;
    } catch {
      // Fall through to the per-data-directory socket used by local/desktop runs.
    }
  }
  return nodeAgentIpcPath(dataDir || defaultNodeAgentDataDir());
}

function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Port must be a valid TCP port.");
  }
  return port;
}

function parseConnectionMode(value: string) {
  if (value !== "local-ipc" && value !== "local-loopback") {
    throw new Error("Connection mode must be local-ipc or local-loopback.");
  }
  return value;
}

function parsePositiveInteger(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Expiry must be a positive integer.");
  }
  return parsed;
}

function parseUpdateChannel(value: string): UpdateChannel {
  if (value !== "stable" && value !== "beta" && value !== "alpha") {
    throw new InvalidArgumentError("must be stable, beta, or alpha");
  }
  return value;
}

function parsePositiveSeconds(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

async function createPairingInvite(options: {
  endpoint?: string;
  ipcPath?: string;
  token?: string;
  expiresInMs?: number;
}) {
  const headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const body = JSON.stringify({
    ...(options.expiresInMs ? { expiresInMs: options.expiresInMs } : {}),
  });
  const response = options.endpoint
    ? await fetch(`${options.endpoint.replace(/\/$/, "")}/api/node-agent/pairing/invites`, { method: "POST", headers, body })
    : await fetchNodeAgentIpc(options.ipcPath!, "/pairing/invites", { method: "POST", headers, body });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { nodeId?: unknown; joinToken?: unknown; expiresAt?: unknown };
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || `Node agent pairing invite failed with HTTP ${response.status}`);
  }
  const joinToken = typeof payload.data?.joinToken === "string" ? payload.data.joinToken : "";
  if (!joinToken) {
    throw new Error("Node agent pairing invite response did not include a join token.");
  }
  return {
    nodeId: typeof payload.data?.nodeId === "string" ? payload.data.nodeId : "",
    joinToken,
    expiresAt: typeof payload.data?.expiresAt === "string" ? payload.data.expiresAt : "",
  };
}

async function connectControlPlane(options: {
  controlPlane: string;
  joinToken: string;
  controlPlaneName?: string;
  endpoint?: string;
  ipcPath?: string;
  token?: string;
}) {
  const headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const body = JSON.stringify({
    controlPlaneUrl: options.controlPlane,
    joinToken: options.joinToken,
    ...(options.controlPlaneName ? { controlPlaneName: options.controlPlaneName } : {}),
    activate: true,
  });
  const response = options.endpoint
    ? await fetch(`${options.endpoint.replace(/\/$/, "")}/api/node-agent/control-plane-connections`, { method: "POST", headers, body })
    : await fetchNodeAgentIpc(options.ipcPath!, "/control-plane-connections", { method: "POST", headers, body });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { connection?: { id?: unknown; url?: unknown }; tunnel?: { status?: unknown; error?: unknown } };
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message || `Node Agent connection failed with HTTP ${response.status}`);
  return payload.data;
}

async function bindCloudRelay(options: {
  cloudOrigin?: string;
  bindingToken: string;
  displayName?: string;
  endpoint?: string;
  ipcPath?: string;
  token?: string;
}) {
  const headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const body = JSON.stringify({
    ...(options.cloudOrigin ? { cloudOrigin: options.cloudOrigin } : {}),
    bindingToken: options.bindingToken,
    ...(options.displayName ? { displayName: options.displayName } : {}),
  });
  const response = options.endpoint
    ? await fetch(`${options.endpoint.replace(/\/$/, "")}/api/node-agent/cloud-relay/bind`, { method: "POST", headers, body })
    : await fetchNodeAgentIpc(options.ipcPath!, "/cloud-relay/bind", { method: "POST", headers, body });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { nodeHandle?: unknown; channels?: unknown };
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message || `Cloud relay binding failed with HTTP ${response.status}`);
  return payload.data || {};
}

type NodeAgentRequestOptions = {
  endpoint?: string;
  ipcPath?: string;
  token?: string;
};

class NodeAgentRequestError extends Error {
  readonly statusCode?: number;
  readonly code?: string;

  constructor(message: string, statusCode?: number, code?: string) {
    super(message);
    this.name = "NodeAgentRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function requestNodeAgent(options: NodeAgentRequestOptions, requestPath: string, method = "GET", body?: unknown) {
  const headers = {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const response = options.endpoint
    ? await fetch(`${options.endpoint.replace(/\/$/, "")}/api/node-agent${requestPath}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    : await fetchNodeAgentIpc(options.ipcPath!, requestPath, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: unknown;
    error?: { message?: unknown; code?: unknown };
  };
  if (!response.ok) {
    const code = typeof payload.error?.code === "string" ? payload.error.code : undefined;
    const message = typeof payload.error?.message === "string"
      ? payload.error.message
      : code || `Node Agent request failed with HTTP ${response.status}`;
    throw new NodeAgentRequestError(message, response.status, code);
  }
  return payload.data;
}

async function fetchNodeAgentTrust(options: NodeAgentRequestOptions, path: string, method = "GET", body?: unknown) {
  const payload = await requestNodeAgent(options, path, method, body);
  const parsed = NodeAgentControlPlaneTrustSnapshotSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Node Agent trust response did not include a trust snapshot.");
  }
  return parsed.data;
}

async function checkNodeAgentUpdate(options: NodeAgentRequestOptions & { channel: UpdateChannel }) {
  const payload = await requestNodeAgent(options, "/updates/check", "POST", { channel: options.channel });
  const parsed = UpdateCheckResultSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Node Agent update check returned an invalid response.");
  return parsed.data;
}

async function applyNodeAgentUpdate(
  options: NodeAgentRequestOptions,
  input: { channel: UpdateChannel; targetVersion: string; preflightToken: string },
) {
  const payload = await requestNodeAgent(options, "/updates/apply", "POST", input);
  const parsed = UpdateJobSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Node Agent update apply returned an invalid response.");
  return parsed.data;
}

async function listNodeAgentUpdateJobs(options: NodeAgentRequestOptions) {
  const payload = await requestNodeAgent(options, "/updates/jobs");
  const parsed = UpdateJobSchema.array().safeParse(payload);
  if (!parsed.success) throw new Error("Node Agent update jobs returned an invalid response.");
  return parsed.data;
}

function matchesTrustIdentity(value: { fingerprint: string; comparisonCode: string }, options: { fingerprint?: string; comparisonCode?: string }) {
  if (!options.fingerprint && !options.comparisonCode) throw new Error("Specify --fingerprint or --comparison-code.");
  if (options.fingerprint && value.fingerprint !== options.fingerprint) return false;
  if (options.comparisonCode && value.comparisonCode !== options.comparisonCode) return false;
  return true;
}

function requireTrustRequest(snapshot: NodeAgentControlPlaneTrustSnapshot, requestId: string, options: { fingerprint?: string; comparisonCode?: string }) {
  const request = snapshot.requests.find((item) => item.requestId === requestId);
  if (!request) throw new Error(`Control Plane trust request not found: ${requestId}`);
  if (!matchesTrustIdentity(request, options)) throw new Error("The Control Plane fingerprint or comparison code does not match the request.");
  return request;
}

function requireTrustPin(snapshot: NodeAgentControlPlaneTrustSnapshot, pinId: string, options: { fingerprint?: string; comparisonCode?: string }) {
  const pin = snapshot.pins.find((item) => item.pinId === pinId);
  if (!pin) throw new Error(`Control Plane trust pin not found: ${pinId}`);
  if (!matchesTrustIdentity(pin, options)) throw new Error("The Control Plane fingerprint or comparison code does not match the pin.");
  return pin;
}

function accessLabel(access: NodeAgentControlPlaneTrustRequest["access"]) {
  return access.accessMode === "shared"
    ? `shared ${access.accountId} via ${access.shareGrantId || "grant"}${access.shareRevision ? ` r${access.shareRevision}` : ""}`
    : `owner ${access.accountId}`;
}

function printTrustSnapshot(snapshot: NodeAgentControlPlaneTrustSnapshot) {
  console.log(`Node Agent: ${snapshot.nodeId}${snapshot.nodeHandle ? ` · ${snapshot.nodeHandle}` : ""}`);
  const pending = snapshot.requests.filter((request) => request.status === "pending");
  console.log(`Pending Control Plane requests (not mobile devices): ${pending.length}`);
  for (const request of pending) {
    console.log(`- request ${request.requestId} · ${request.controlPlaneId} · ${request.reason}`);
    console.log(`  fingerprint ${request.fingerprint}`);
    console.log(`  compare ${request.comparisonCode}`);
    console.log(`  node ${request.nodeHandle} · ${request.bindingId} r${request.bindingRevision} · ${accessLabel(request.access)}`);
    console.log(`  requested ${request.requestedAt} · expires ${request.expiresAt} · revision ${request.revision}`);
  }
  const pins = snapshot.pins.filter((pin) => pin.status === "active");
  console.log(`Active trusted Control Planes (not mobile devices): ${pins.length}`);
  for (const pin of pins) {
    console.log(`- pin ${pin.pinId} · ${pin.controlPlaneId}`);
    console.log(`  fingerprint ${pin.fingerprint}`);
    console.log(`  compare ${pin.comparisonCode}`);
    console.log(`  node ${pin.nodeHandle} · ${pin.bindingId} r${pin.bindingRevision} · ${accessLabel(pin.access)}`);
    console.log(`  approved ${pin.approvedAt} by ${pin.approvedByActorType}:${pin.approvedByActorId} · last seen ${pin.lastSeenAt} · revision ${pin.revision}`);
  }
}

function resolveNodeAgentTransport(rootOptions: { ipcPath?: string; dataDir?: string }, options: {
  endpoint?: string;
  ipcPath?: string;
  dataDir?: string;
}) {
  const explicitIpcPath = options.ipcPath || rootOptions.ipcPath
    || process.env.TASK_HANDOFF_NODE_AGENT_IPC_PATH;
  const dataDir = options.dataDir || rootOptions.dataDir
    || process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR;
  return {
    endpoint: options.endpoint,
    ipcPath: options.endpoint ? undefined : resolveNodeAgentIpcPath(explicitIpcPath, dataDir),
  };
}

function updateImpactLabel(check: UpdateCheckResult) {
  const { runningInstanceCount, activeInstanceCount, stoppedInstanceCount } = check.impact;
  return `${runningInstanceCount} running${activeInstanceCount ? ` (${activeInstanceCount} active)` : ""}, ${stoppedInstanceCount} stopped`;
}

function printUpdateCheck(check: UpdateCheckResult) {
  const current = check.currentVersion || "unknown";
  console.log(`Current: ${current}`);
  console.log(`Available: ${check.availableVersion} (${check.channel})`);
  console.log(`Impact: ${updateImpactLabel(check)}`);
  if (!check.supported) {
    console.log(`Managed updates are unavailable: ${check.reason || "the current installation does not support updates"}`);
  } else if (check.updateAvailable) {
    console.log(`Update available: ${current} -> ${check.availableVersion}`);
  } else {
    console.log(check.reason || "Node Agent is up to date.");
  }
}

async function confirmNodeAgentUpdate(check: UpdateCheckResult, options: { yes?: boolean }) {
  if (options.yes) return;
  if (!process.stdin.isTTY) {
    throw new Error("Use --yes to apply a Node Agent update when standard input is not interactive.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(
      `Update Node Agent ${check.currentVersion || "unknown"} -> ${check.availableVersion}? `
      + `${updateImpactLabel(check)}; the service will restart. [y/N] `,
    );
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Node Agent update cancelled.");
  } finally {
    prompt.close();
  }
}

async function waitForNodeAgentUpdate(
  transport: NodeAgentRequestOptions,
  job: UpdateJob,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    if (TERMINAL_UPDATE_STATUSES.has(job.status)) return job;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
      throw new Error(`Timed out waiting for Node Agent update ${job.id}.${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(UPDATE_POLL_INTERVAL_MS, remaining)));
    try {
      const jobs = await listNodeAgentUpdateJobs(transport);
      const current = jobs.find((candidate) => candidate.id === job.id);
      if (!current) throw new Error(`Node Agent update job ${job.id} disappeared.`);
      job = current;
      lastError = undefined;
    } catch (error) {
      if (error instanceof NodeAgentRequestError && error.statusCode && error.statusCode < 500) throw error;
      lastError = error;
    }
  }
}

async function unbindCloudRelay(options: { endpoint?: string; ipcPath?: string; token?: string }) {
  const headers = {
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const response = options.endpoint
    ? await fetch(`${options.endpoint.replace(/\/$/, "")}/api/node-agent/cloud-relay`, { method: "DELETE", headers })
    : await fetchNodeAgentIpc(options.ipcPath!, "/cloud-relay", { method: "DELETE", headers });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { unbound?: unknown; nodeHandle?: unknown; cloudUnbind?: unknown };
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message || `Cloud relay unbind failed with HTTP ${response.status}`);
  return payload.data || {};
}

async function main() {
  const program = new Command();
  program
    .name("task-handoff-node-agent")
    .description("Run a TaskHandoff node agent.")
    .version(resolvePackageVersion("@task-handoff/cli"))
    .option("--host <host>", "Node agent host", process.env.TASK_HANDOFF_NODE_AGENT_HOST || "127.0.0.1")
    .option("-p, --port <port>", "Node agent port", parsePort, Number(process.env.TASK_HANDOFF_NODE_AGENT_PORT) || 8091)
    .option("--data-dir <path>", "Node agent data directory")
    .option("--token <token>", "Bearer token required by the control plane")
    .option("--connection-mode <mode>", "Local control connection mode", parseConnectionMode)
    .option("--ipc-path <path>", "Unix socket path used by local-ipc mode")
    .option("--control-plane-tunnel-url <url>", "Control plane reverse WebSocket tunnel URL")
    .action(async (options) => {
      await runNodeAgentServer({
        host: options.host,
        port: options.port,
        dataDir: options.dataDir,
        token: options.token,
        connectionMode: options.connectionMode,
        ipcPath: options.ipcPath,
        controlPlaneTunnelUrl: options.controlPlaneTunnelUrl,
      });
    });

  program
    .command("invite")
    .description("Create a one-time token for pairing this node agent with a control plane.")
    .option("--endpoint <url>", "Use the node-agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local node-agent IPC socket path")
    .option("--data-dir <path>", "Node-agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local node-agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--expires-in-ms <ms>", "Invite expiry in milliseconds", parsePositiveInteger)
    .option("--json", "Print raw JSON output")
    .action(async (options) => {
      const rootOptions = program.opts();
      const explicitIpcPath = options.ipcPath || rootOptions.ipcPath
        || process.env.TASK_HANDOFF_NODE_AGENT_IPC_PATH;
      const dataDir = options.dataDir || rootOptions.dataDir
        || process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR;
      const ipcPath = options.endpoint
        ? undefined
        : resolveNodeAgentIpcPath(explicitIpcPath, dataDir);
      const invite = await createPairingInvite({
        endpoint: options.endpoint,
        ipcPath,
        token: options.token,
        expiresInMs: options.expiresInMs,
      });
      if (options.json) {
        console.log(JSON.stringify(invite, null, 2));
        return;
      }
      if (invite.nodeId) console.log(`Node: ${invite.nodeId}`);
      console.log(`Join token: ${invite.joinToken}`);
      if (invite.expiresAt) console.log(`Expires: ${invite.expiresAt}`);
    });

  program
    .command("connect")
    .description("Connect this Node Agent to a reachable Control Plane.")
    .requiredOption("--control-plane <url>", "Public Control Plane base URL")
    .requiredOption("--join-token <token>", "One-time join token issued by the Control Plane")
    .option("--control-plane-name <name>", "Control Plane display name")
    .option("--endpoint <url>", "Use the Node Agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local Node Agent IPC socket path")
    .option("--data-dir <path>", "Node Agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local Node Agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--json", "Print raw JSON output")
    .action(async (options) => {
      const rootOptions = program.opts();
      const explicitIpcPath = options.ipcPath || rootOptions.ipcPath
        || process.env.TASK_HANDOFF_NODE_AGENT_IPC_PATH;
      const dataDir = options.dataDir || rootOptions.dataDir
        || process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR;
      const ipcPath = options.endpoint
        ? undefined
        : resolveNodeAgentIpcPath(explicitIpcPath, dataDir);
      const result = await connectControlPlane({
        controlPlane: options.controlPlane,
        joinToken: options.joinToken,
        controlPlaneName: options.controlPlaneName,
        endpoint: options.endpoint,
        ipcPath,
        token: options.token,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Control Plane: ${String(result?.connection?.url || options.controlPlane)}`);
      console.log(`Connection: ${String(result?.tunnel?.status || "saved")}`);
    });

  program
    .command("update")
    .alias("self-update")
    .description("Check for and install a newer Node Agent release, then restart its service.")
    .option("--check", "Check for an available update without installing it")
    .option("--channel <channel>", "Release channel: stable, beta, or alpha", parseUpdateChannel, "stable")
    .option("-y, --yes", "Apply the update without an interactive confirmation")
    .option("--no-wait", "Return after queuing the update job without waiting for completion")
    .option("--timeout <seconds>", "Maximum time to wait for completion", parsePositiveSeconds, UPDATE_WAIT_TIMEOUT_SECONDS)
    .option("--endpoint <url>", "Use the Node Agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local Node Agent IPC socket path")
    .option("--data-dir <path>", "Node Agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local Node Agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--json", "Print raw JSON output")
    .action(async (options) => {
      const transport = {
        ...resolveNodeAgentTransport(program.opts(), options),
        token: options.token,
      };
      const check = await checkNodeAgentUpdate({ ...transport, channel: options.channel });
      if (options.check) {
        if (options.json) console.log(JSON.stringify(check, null, 2));
        else printUpdateCheck(check);
        return;
      }
      if (!check.supported) {
        throw new Error(check.reason || "Managed Node Agent updates are unavailable on this installation.");
      }
      if (!check.updateAvailable) {
        if (options.json) console.log(JSON.stringify(check, null, 2));
        else printUpdateCheck(check);
        return;
      }
      if (!check.preflightToken) {
        throw new Error("Node Agent update check did not return a preflight token.");
      }

      if (!options.json) printUpdateCheck(check);
      await confirmNodeAgentUpdate(check, options);
      const queued = await applyNodeAgentUpdate(transport, {
        channel: check.channel,
        targetVersion: check.availableVersion,
        preflightToken: check.preflightToken,
      });
      if (!options.wait) {
        if (options.json) console.log(JSON.stringify(queued, null, 2));
        else console.log(`Update job ${queued.id} queued with status ${queued.status}.`);
        return;
      }

      if (!options.json) console.log(`Update job ${queued.id} started; waiting for the Node Agent to restart...`);
      const completed = await waitForNodeAgentUpdate(transport, queued, options.timeout * 1_000);
      if (options.json) console.log(JSON.stringify(completed, null, 2));
      else if (completed.status === "succeeded") {
        console.log(`Node Agent updated to ${completed.toVersion}.`);
      } else if (completed.status === "degraded") {
        console.error(`Node Agent restarted at ${completed.toVersion}, but instance convergence is degraded.${completed.error?.message ? ` ${completed.error.message}` : ""}`);
      } else {
        console.error(`Node Agent update finished with status ${completed.status}.${completed.error?.message ? ` ${completed.error.message}` : ""}`);
      }
      if (completed.status === "failed") process.exitCode = 1;
    });

  program
    .command("cloud-bind")
    .description("Bind this Node Agent to a cloud platform account with a one-time binding token.")
    .option("--cloud-origin <url>", "Pin the cloud platform origin and bypass cloud discovery")
    .requiredOption("--binding-token <token>", "One-time binding token from the cloud platform")
    .option("--display-name <name>", "Display name shown in the account node directory")
    .option("--endpoint <url>", "Use the Node Agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local Node Agent IPC socket path")
    .option("--data-dir <path>", "Node Agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local Node Agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--json", "Print raw JSON output")
    .action(async (options) => {
      const rootOptions = program.opts();
      const explicitIpcPath = options.ipcPath || rootOptions.ipcPath
        || process.env.TASK_HANDOFF_NODE_AGENT_IPC_PATH;
      const dataDir = options.dataDir || rootOptions.dataDir
        || process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR;
      const ipcPath = options.endpoint
        ? undefined
        : resolveNodeAgentIpcPath(explicitIpcPath, dataDir);
      const result = await bindCloudRelay({
        cloudOrigin: options.cloudOrigin,
        bindingToken: options.bindingToken,
        displayName: options.displayName,
        endpoint: options.endpoint,
        ipcPath,
        token: options.token,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Node handle: ${String(result.nodeHandle || "unknown")}`);
      console.log("Binding: active");
    });

  program
    .command("cloud-unbind")
    .description("Remove this Node Agent from its cloud platform account; local instances are untouched.")
    .option("--endpoint <url>", "Use the Node Agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local Node Agent IPC socket path")
    .option("--data-dir <path>", "Node Agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local Node Agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--json", "Print raw JSON output")
    .action(async (options) => {
      const rootOptions = program.opts();
      const explicitIpcPath = options.ipcPath || rootOptions.ipcPath
        || process.env.TASK_HANDOFF_NODE_AGENT_IPC_PATH;
      const dataDir = options.dataDir || rootOptions.dataDir
        || process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR;
      const ipcPath = options.endpoint
        ? undefined
        : resolveNodeAgentIpcPath(explicitIpcPath, dataDir);
      const result = await unbindCloudRelay({ endpoint: options.endpoint, ipcPath, token: options.token });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.unbound ? `Unbound: ${String(result.nodeHandle || "node")}` : "Node Agent was not bound.");
    });

  const trust = program
    .command("trust")
    .description("Review and manage Control Planes trusted for this Node Agent's cloud relay (not mobile devices).");

  trust
    .command("list")
    .description("List pending Control Plane trust requests and active trusted Control Planes.")
    .option("--endpoint <url>", "Use the Node Agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local Node Agent IPC socket path")
    .option("--data-dir <path>", "Node Agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local Node Agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--json", "Print raw JSON output")
    .action(async (options) => {
      const transport = resolveNodeAgentTransport(program.opts(), options);
      const snapshot = await fetchNodeAgentTrust({ ...transport, token: options.token }, "/control-plane-trust");
      if (options.json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }
      printTrustSnapshot(snapshot);
    });

  trust
    .command("approve")
    .description("Approve a pending Control Plane. Compare its fingerprint or short code with the Control Plane UI first.")
    .argument("<requestId>", "Pending Control Plane trust request ID")
    .option("--fingerprint <fingerprint>", "Expected Control Plane public key fingerprint")
    .option("--comparison-code <code>", "Expected short comparison code")
    .option("--revision <revision>", "Expected request revision from the list output", parsePositiveInteger)
    .option("--retain-previous-key", "Keep the previous key active for the same Control Plane and access context")
    .option("--reason <reason>", "Decision reason for the local audit log")
    .option("--endpoint <url>", "Use the Node Agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local Node Agent IPC socket path")
    .option("--data-dir <path>", "Node Agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local Node Agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--json", "Print raw JSON output")
    .action(async (requestId, options) => {
      const transport = resolveNodeAgentTransport(program.opts(), options);
      const snapshot = await fetchNodeAgentTrust({ ...transport, token: options.token }, "/control-plane-trust");
      const request = requireTrustRequest(snapshot, requestId, options);
      const result = await fetchNodeAgentTrust({ ...transport, token: options.token }, `/control-plane-trust/requests/${encodeURIComponent(requestId)}/decision`, "POST", {
        action: "approve",
        expectedFingerprint: request.fingerprint,
        expectedRevision: options.revision ?? request.revision,
        ...(options.retainPreviousKey ? { retainPreviousKey: true } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printTrustSnapshot(result);
    });

  trust
    .command("reject")
    .description("Reject a pending Control Plane trust request.")
    .argument("<requestId>", "Pending Control Plane trust request ID")
    .option("--fingerprint <fingerprint>", "Expected Control Plane public key fingerprint")
    .option("--comparison-code <code>", "Expected short comparison code")
    .option("--revision <revision>", "Expected request revision from the list output", parsePositiveInteger)
    .option("--reason <reason>", "Rejection reason for the local audit log")
    .option("--endpoint <url>", "Use the Node Agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local Node Agent IPC socket path")
    .option("--data-dir <path>", "Node Agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local Node Agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--json", "Print raw JSON output")
    .action(async (requestId, options) => {
      const transport = resolveNodeAgentTransport(program.opts(), options);
      const snapshot = await fetchNodeAgentTrust({ ...transport, token: options.token }, "/control-plane-trust");
      const request = requireTrustRequest(snapshot, requestId, options);
      const result = await fetchNodeAgentTrust({ ...transport, token: options.token }, `/control-plane-trust/requests/${encodeURIComponent(requestId)}/decision`, "POST", {
        action: "reject",
        expectedFingerprint: request.fingerprint,
        expectedRevision: options.revision ?? request.revision,
        ...(options.reason ? { reason: options.reason } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printTrustSnapshot(result);
    });

  trust
    .command("retry")
    .description("Explicitly reopen a rejected or expired request as a new pending request.")
    .argument("<requestId>", "Rejected or expired Control Plane trust request ID")
    .option("--fingerprint <fingerprint>", "Expected Control Plane public key fingerprint")
    .option("--comparison-code <code>", "Expected short comparison code")
    .option("--endpoint <url>", "Use the Node Agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local Node Agent IPC socket path")
    .option("--data-dir <path>", "Node Agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local Node Agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--json", "Print raw JSON output")
    .action(async (requestId, options) => {
      const transport = resolveNodeAgentTransport(program.opts(), options);
      const snapshot = await fetchNodeAgentTrust({ ...transport, token: options.token }, "/control-plane-trust");
      const request = requireTrustRequest(snapshot, requestId, options);
      if (request.status !== "rejected" && request.status !== "expired") {
        throw new Error(`Only rejected or expired requests can be retried; this request is ${request.status}.`);
      }
      const result = await fetchNodeAgentTrust({ ...transport, token: options.token }, `/control-plane-trust/requests/${encodeURIComponent(requestId)}/retry`, "POST", {});
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printTrustSnapshot(result);
    });

  trust
    .command("revoke")
    .description("Revoke one exact active Control Plane pin.")
    .argument("<pinId>", "Active Control Plane pin ID")
    .option("--fingerprint <fingerprint>", "Expected Control Plane public key fingerprint")
    .option("--comparison-code <code>", "Expected short comparison code")
    .option("--revision <revision>", "Expected pin revision from the list output", parsePositiveInteger)
    .option("--reason <reason>", "Revocation reason for the local audit log")
    .option("--endpoint <url>", "Use the Node Agent HTTP endpoint instead of its local IPC socket")
    .option("--ipc-path <path>", "Local Node Agent IPC socket path")
    .option("--data-dir <path>", "Node Agent data directory used to locate its IPC socket")
    .option("--token <token>", "Bearer token for local Node Agent access", process.env.TASK_HANDOFF_NODE_AGENT_TOKEN)
    .option("--json", "Print raw JSON output")
    .action(async (pinId, options) => {
      const transport = resolveNodeAgentTransport(program.opts(), options);
      const snapshot = await fetchNodeAgentTrust({ ...transport, token: options.token }, "/control-plane-trust");
      const pin = requireTrustPin(snapshot, pinId, options);
      if (pin.status !== "active") throw new Error("The selected Control Plane pin is already revoked.");
      const result = await fetchNodeAgentTrust({ ...transport, token: options.token }, `/control-plane-trust/pins/${encodeURIComponent(pinId)}/revoke`, "POST", {
        expectedFingerprint: pin.fingerprint,
        expectedRevision: options.revision ?? pin.revision,
        ...(options.reason ? { reason: options.reason } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printTrustSnapshot(result);
    });

  program
    .command("uninstall")
    .description("Uninstall the Node Agent service and packages; data is preserved by default.")
    .option("--data-dir <path>", "Override the installed Node Agent data directory")
    .option("--delete-data", "Delete Node Agent data without prompting")
    .option("--keep-data", "Preserve Node Agent data without prompting")
    .action(async (options) => {
      await uninstallNodeAgent(options);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
