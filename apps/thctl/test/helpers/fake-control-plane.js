import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  CONTROL_PLANE_ACCESS_PROTOCOL_VERSION,
  ControlPlaneCliAuthorizationRequestDetailResponseSchema,
  ControlPlaneCliAuthorizeResponseSchema,
  ControlPlaneCliTokenResponseSchema,
  ControlPlanePublicIdentityDocumentSchema,
  controlPlaneIdentitySigningInput,
} from "@task-handoff/protocol/control-plane-access";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(status, code, message, details) {
  return json(status, { error: { code, message, ...(details ? { details } : {}) } });
}

export function createFakeControlPlane(options = {}) {
  const origin = options.origin ?? "http://control-plane.test";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawKey = spki.subarray(spki.length - 32);
  const fingerprint = `sha256:${createHash("sha256").update(rawKey).digest("base64url")}`;
  const now = new Date().toISOString();

  const identityPayload = {
    version: 1,
    kind: "control-plane",
    controlPlaneId: options.controlPlaneId ?? "cp_fakecp0000000",
    publicKey: { algorithm: "Ed25519", encoding: "base64url", value: rawKey.toString("base64url"), fingerprint },
    capabilities: options.capabilities ?? {
      authentication: "required",
      aiSessions: true,
      nodes: true,
      instanceBoard: true,
      triggers: true,
      stories: true,
      cliSessions: options.cliSessions ?? true,
    },
    protocolVersion: CONTROL_PLANE_ACCESS_PROTOCOL_VERSION,
    issuedAt: now,
    expiresAt: new Date(Date.now() + DAY).toISOString(),
  };
  const identityDocument = ControlPlanePublicIdentityDocumentSchema.parse({
    data: {
      payload: identityPayload,
      signature: sign(null, Buffer.from(controlPlaneIdentitySigningInput(identityPayload)), privateKey).toString("base64url"),
    },
  });

  const state = {
    calls: [],
    authorizeRequests: [],
    approved: false,
    denied: false,
    tokenRequests: 0,
    issuedCode: "code_fake_0000000001",
    sessionToken: "csess_fake0000000000000000000000000000.token",
    localSessionToken: "csess_fakelocal000000000000000000000.token",
    deviceApproved: false,
    deviceExpired: false,
    sessionRevoked: false,
    localSessionRequests: 0,
    renewalCalls: 0,
    deleteIncomplete: false,
    approvalRequests: new Map(),
    slowDownRemaining: options.slowDownRemaining ?? 0,
  };

  const user = {
    id: "user_fake0000000",
    displayName: "Fake Admin",
    primaryUsername: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const authorization = {
    userId: user.id,
    identityId: "identity_fake000",
    roleIds: ["role_admin"],
    permissionIds: [],
    nodeScope: { kind: "all" },
    instanceScope: { kind: "inherit-node-scope" },
    authorizationRevision: 1,
  };
  const cliSession = {
    id: "csess_fake0000000",
    userId: user.id,
    identityId: authorization.identityId,
    clientType: "cli",
    client: { name: "fake-host", platform: "darwin", version: "1.0.0" },
    createdAt: now,
    expiresAt: new Date(Date.now() + (options.sessionTtlMs ?? 14 * DAY)).toISOString(),
    user,
  };
  const localUser = { ...user, displayName: "Local Operator", primaryUsername: undefined };
  const localCliSession = { ...cliSession, user: localUser };

  function authorizationDetail(requestId, extra = {}) {
    return ControlPlaneCliAuthorizationRequestDetailResponseSchema.parse({
      data: {
        requestId,
        mode: extra.mode ?? "browser",
        status: extra.status ?? "pending",
        client: { name: "fake-host", platform: "darwin", version: "1.0.0" },
        createdAt: now,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        ...(extra.userCode ? { userCode: extra.userCode } : {}),
      },
    }).data;
  }

  const instanceEntry = {
    id: "instance_fake001",
    name: "fake-instance",
    nodeId: "node_fake0000001",
    status: "running",
    health: "ok",
    connectionStatus: "online",
    ready: true,
    observedAt: now,
    runtime: { id: "runtime_fake01", type: "docker" },
    workspace: { status: "ready", path: "/workspace" },
    protocol: { version: "2026-10-01", compatible: true },
    aiSessions: { runningCount: 1, waitingCount: 0, staleCount: 0, idleCount: 0, problemCount: 0, updatedAt: now },
    availableAgents: [],
  };
  const nodeEntry = {
    id: "node_fake0000001",
    name: "fake-node",
    status: "online",
    health: "ok",
    connectionMode: "reverse-wss",
    observedAt: now,
    capabilities: ["story", "trigger"],
  };
  const createdInstance = {
    id: "inst_created0001",
    name: "fake-created",
    source: { type: "local-folder", path: "/workspace/fake" },
    modelSelection: {},
    nodeId: nodeEntry.id,
    runtimeId: "runtime_local_docker",
    status: "provisioning",
    health: "unknown",
    connectionStatus: "unknown",
    controlMode: "controlled",
    ready: false,
    workspace: { status: "unknown" },
    access: { strategy: "control-plane-proxy", web: "/instances/inst_created0001/", api: "/instances/inst_created0001/api", ws: "/instances/inst_created0001/api", status: "endpoint-unreachable" },
    createdAt: now,
    updatedAt: now,
  };
  const appSession = {
    id: "appsess_fake001",
    appId: "app_fake01",
    title: "Fake app session",
    kind: "tty",
    status: "running",
    bindings: [],
    createdAt: now,
    updatedAt: now,
  };
  const guiAppSession = {
    id: "appsess_fakegui1",
    appId: "app_fakegui01",
    title: "Fake GUI session",
    kind: "gui",
    status: "running",
    bindings: [],
    createdAt: now,
    updatedAt: now,
  };
  const modelEntry = {
    id: "model_fake00001",
    model: { id: "model_fake00001", name: "Fake Model", model: "gpt-5.4", modelNames: [], protocols: ["openai"], enabled: true, order: 1 },
    locations: [{ type: "control-plane", enabled: true }],
  };
  const userDetail = {
    ...user,
    identities: [],
    accessGrant: {
      userId: user.id,
      roleIds: ["role_admin"],
      nodeScope: { kind: "all" },
      instanceScope: { kind: "inherit-node-scope" },
      authorizationRevision: 1,
      updatedAt: now,
    },
  };
  const userSession = {
    id: "usess_fake0001",
    userId: user.id,
    identityId: "identity_fake000",
    clientType: "web",
    createdAt: now,
    expiresAt: new Date(Date.now() + DAY).toISOString(),
  };
  const storyDocument = { title: "Intro", storyPath: "intro.md", revision: "a".repeat(64) };
  const story = {
    id: "story_fake000001",
    ownerNodeId: nodeEntry.id,
    title: "Fake story",
    documents: [storyDocument],
    actions: [],
    createdAt: now,
    updatedAt: now,
  };
  const automation = {
    id: "auto_fake000001",
    storyId: story.id,
    actionId: "action_fake0001",
    schedule: { scheduleKind: "interval", intervalMs: 60_000 },
    enabled: true,
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
    createdAt: now,
    updatedAt: now,
  };
  const automationStatus = { automation, effectiveStatus: "scheduled", currentRuns: [] };
  const automationRun = {
    id: "autorun_fake001",
    automationId: automation.id,
    eventType: "manual",
    status: "queued",
    scheduledFor: now,
    targetInstanceId: instanceEntry.id,
    queuedAt: now,
  };
  const triggerConfig = {
    configHash: "trg_fake000000000000000001",
    name: "Fake trigger",
    source: { type: "ai-session" },
    action: { promptTemplate: "Run the fake trigger." },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
    createdAt: now,
    updatedAt: now,
  };
  const triggerDeployment = {
    configHash: triggerConfig.configHash,
    deploymentId: "dep_fake0001",
    instanceId: instanceEntry.id,
    origin: "control-plane",
    enabled: true,
    target: { type: "ai-session", aiSessionId: "ais_fake0000001" },
    createdAt: now,
    updatedAt: now,
  };
  const triggerProjection = {
    configHash: triggerConfig.configHash,
    config: triggerConfig,
    deploymentCount: 1,
    enabledCount: 1,
    runningCount: 0,
    errorCount: 0,
    ownedByControlPlane: true,
    controlPlaneDeploymentCount: 1,
    deployments: [{ instanceId: instanceEntry.id, instanceName: instanceEntry.name, deployment: triggerDeployment }],
    recentRuns: [],
  };

  const aiSessionsView = {
    updatedAt: now,
    instances: [{
      instanceId: instanceEntry.id,
      streamId: "stream_fake01",
      aiSessions: {
        updatedAt: now,
        runningCount: 1,
        waitingCount: 0,
        staleCount: 0,
        sessions: [{
          id: "ais_fake0000001",
          agent: "codex",
          creationSource: "app-session",
          status: "running",
          phase: "thinking",
          title: "Fake session",
          startedAt: now,
          updatedAt: now,
          unread: false,
        }],
      },
    }],
  };

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url.startsWith("http") ? url : `${origin}${url}`);
    const path = parsed.pathname;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ method, path, search: parsed.search, headers: Object.fromEntries(headers.entries()), body });
    const bearer = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const knownToken = bearer === state.sessionToken || bearer === state.localSessionToken;

    if (method === "GET" && path === "/api/control-plane/identity") return json(200, identityDocument);
    if (method === "POST" && path === "/api/auth/cli/authorize") {
      state.authorizeRequests.push(body);
      state.lastState = body.state;
      state.lastCodeChallenge = body.codeChallenge;
      const requestId = `cliauth_fake${String(state.authorizeRequests.length).padStart(4, "0")}`;
      state.lastRequestId = requestId;
      const response = body.mode === "device"
        ? { mode: "device", requestId, verificationUri: `${origin}/cli/authorize`, verificationUriComplete: `${origin}/cli/authorize?user_code=ABCD-EFGH`, userCode: "ABCD-EFGH", intervalSeconds: 1, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
        : { mode: "browser", requestId, verificationUri: `${origin}/cli/authorize?request=${requestId}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
      return json(200, ControlPlaneCliAuthorizeResponseSchema.parse({ data: response }));
    }
    if (method === "POST" && path === "/api/auth/cli/token") {
      state.tokenRequests += 1;
      if (body.grantType === "authorization_code") {
        const challenge = createHash("sha256").update(String(body.codeVerifier)).digest("base64url");
        if (body.code !== state.issuedCode || challenge !== state.lastCodeChallenge) {
          return errorResponse(400, "CLI_AUTHORIZATION_INVALID_GRANT", "The CLI authorization grant is invalid or no longer usable.");
        }
      } else if (!state.deviceApproved) {
        if (state.deviceExpired) return errorResponse(410, "CLI_AUTHORIZATION_EXPIRED", "The CLI authorization request expired.");
        if (state.slowDownRemaining > 0) {
          state.slowDownRemaining -= 1;
          return errorResponse(400, "CLI_AUTHORIZATION_SLOW_DOWN", "Polling too quickly.", { intervalSeconds: 10 });
        }
        return errorResponse(400, "CLI_AUTHORIZATION_PENDING", "The CLI authorization request is still pending.");
      }
      if (state.sessionRevoked) return errorResponse(401, "CONTROL_PLANE_AUTH_REQUIRED", "Sign in again.");
      return json(200, ControlPlaneCliTokenResponseSchema.parse({
        data: {
          sessionToken: state.sessionToken,
          session: cliSession,
          authorization,
        },
      }));
    }
    if (method === "POST" && path === "/api/auth/cli/local") {
      state.localSessionRequests += 1;
      if (identityPayload.capabilities.localCliSessions !== true) {
        return errorResponse(403, "AUTH_LOCAL_SESSION_UNAVAILABLE", "Local CLI sessions are unavailable while Control Plane authentication is enabled.");
      }
      return json(200, ControlPlaneCliTokenResponseSchema.parse({
        data: {
          sessionToken: state.localSessionToken,
          session: localCliSession,
          authorization: { ...authorization, userId: localUser.id, identityId: "identity_fake_local" },
        },
      }));
    }
    if (path.startsWith("/api/auth/cli/") && (state.sessionRevoked || !knownToken)) {
      return errorResponse(401, "CONTROL_PLANE_AUTH_REQUIRED", "Sign in with a Control Plane CLI session.");
    }
    if (state.sessionRevoked && knownToken && path !== "/api/auth/cli/logout") {
      return errorResponse(401, "CONTROL_PLANE_AUTH_REQUIRED", "Sign in with a Control Plane CLI session.");
    }
    if (options.approvalAutoApprove && method === "GET" && path === "/api/operation-approvals/support") {
      return json(200, { data: { supported: true } });
    }
    if (options.approvalAutoApprove && method === "GET" && /^\/api\/operation-approvals\/[^/]+\/status$/.test(path)) {
      const approval = state.approvalRequests.get(path.split("/")[3]);
      if (!approval) return errorResponse(404, "OPERATION_APPROVAL_NOT_FOUND", "Approval not found.");
      return json(200, { data: { id: approval.id, status: "approved", expiresAt: approval.expiresAt } });
    }
    if (method === "GET" && path === "/api/auth/session") {
      if (bearer === state.localSessionToken) {
        return json(200, { data: { mode: "password", enabled: true, requiresBootstrap: false, authenticated: true, user: localUser, authorization: { ...authorization, userId: localUser.id, identityId: "identity_fake_local" } } });
      }
      if (bearer !== state.sessionToken) return json(200, { data: { mode: "password", enabled: true, requiresBootstrap: false, authenticated: false } });
      return json(200, { data: { mode: "password", enabled: true, requiresBootstrap: false, authenticated: true, user, authorization } });
    }
    if (method === "POST" && path === "/api/auth/cli/logout") return json(200, { data: { ok: true } });
    if (method === "POST" && path === "/api/auth/cli/renew") {
      state.renewalCalls += 1;
      return json(200, { data: { expiresAt: new Date(Date.now() + 14 * DAY).toISOString() } });
    }
    if (method === "GET" && path === "/api/auth/cli/sessions") return json(200, { data: [cliSession] });
    if (method === "GET" && path === "/api/instance-board") return json(200, { data: [instanceEntry] });
    if (method === "PATCH" && /^\/api\/controlled-instances\/[^/]+$/.test(path)) {
      instanceEntry.name = typeof body?.name === "string" ? body.name : instanceEntry.name;
      return json(200, { data: { id: instanceEntry.id, name: instanceEntry.name } });
    }
    if (method === "GET" && path === "/api/ai-sessions") {
      if (parsed.searchParams.get("instanceId") && parsed.searchParams.get("instanceId") !== instanceEntry.id) return json(200, { data: { updatedAt: now, instances: [] } });
      return json(200, { data: aiSessionsView });
    }
    if (method === "GET" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/(?!history$)[^/]+$/.test(path)) {
      return json(200, {
        data: {
          kind: "updated",
          revision: "rev-1",
          detail: {
            id: path.split("/").at(-1),
            cwd: "/workspace",
            subAgents: [],
            queue: { revision: 0, pendingCount: 1, items: [{ id: "queue_fake01", message: "Queued hello", attachments: [], references: [], status: "queued", createdAt: now, updatedAt: now }] },
          },
        },
      });
    }
    if (method === "GET" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/turns$/.test(path)) {
      const sessionId = path.split("/")[5];
      return json(200, {
        data: {
          kind: "updated",
          revision: "rev-turns",
          index: {
            sessionId,
            revision: "rev-turns",
            turns: [{
              id: "turn_fake01",
              providerTurnId: "turn_fake01",
              status: "completed",
              phase: "unknown",
              revision: 1,
              startedAt: now,
              updatedAt: now,
              completedAt: now,
              bodyRevision: "rev-body",
            }],
          },
        },
      });
    }
    if (method === "GET" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/turns\/[^/]+\/timeline$/.test(path)) {
      const segments = path.split("/");
      return json(200, {
        data: {
          sessionId: segments[5],
          turnId: segments[7],
          items: [
            { id: "item_user01", turnId: segments[7], type: "user-message", text: "Please fix the bug", attachments: [] },
            { id: "item_ai01", turnId: segments[7], type: "ai-message", text: "Fixed." },
            { id: "item_act01", turnId: segments[7], type: "activity", activityKind: "commandExecution", title: "Command", status: "completed", output: "ok" },
          ],
          generatedAt: now,
        },
      });
    }
    if (method === "GET" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/turns\/[^/]+$/.test(path)) {
      const segments = path.split("/");
      return json(200, {
        data: {
          kind: "updated",
          revision: "rev-body",
          body: {
            sessionId: segments[5],
            revision: "rev-body",
            turn: {
              id: segments[7],
              status: "completed",
              userMessages: [{ id: "msg_user01", text: "Please fix the bug", attachments: [] }],
              lastMessage: "Fixed.",
              summary: "Fixed.",
            },
          },
        },
      });
    }
    if (method === "GET" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/timeline$/.test(path)) {
      const sessionId = path.split("/")[5];
      return json(200, {
        data: {
          sessionId,
          providerSessionId: "prov_fake01",
          items: [
            { id: "item_user01", turnId: "turn_fake01", type: "user-message", text: "Please fix the bug", attachments: [] },
            { id: "item_ai01", turnId: "turn_fake01", type: "ai-message", text: "Fixed." },
          ],
          generatedAt: now,
        },
      });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/(start|stop|restart)$/.test(path)) {
      const action = path.split("/").at(-1);
      return json(200, { data: { id: instanceEntry.id, status: action === "stop" ? "stopping" : action === "start" ? "starting" : "restarting" } });
    }
    if (method === "POST" && path === "/api/controlled-instances") {
      const id = typeof body?.id === "string" ? body.id : createdInstance.id;
      return json(201, {
        data: {
          ...createdInstance,
          id,
          name: body?.name ?? createdInstance.name,
          nodeId: body?.nodeId ?? createdInstance.nodeId,
          status: body?.start ? "starting" : "provisioning",
          startOutcome: body?.start ? { status: "started" } : { status: "not-requested" },
        },
      });
    }
    if (method === "DELETE" && /^\/api\/controlled-instances\/[^/]+$/.test(path)) {
      const id = path.split("/").at(-1);
      if (options.approvalAutoApprove) {
        const approvalId = headers.get("x-task-handoff-approval-id");
        if (!approvalId) {
          const approval = { kind: "operation-approval", id: `approval_fake${state.approvalRequests.size + 1}`, status: "pending", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
          state.approvalRequests.set(approval.id, approval);
          return json(202, { data: approval });
        }
        if (!state.approvalRequests.delete(approvalId)) return errorResponse(403, "OPERATION_APPROVAL_INVALID", "Approval not found.");
      }
      const deleteVolumes = body?.deleteVolumes === true;
      const volume = { role: "workspace", name: `fake-${id}-workspace`, mountPath: "/workspace", status: deleteVolumes ? "deleted" : "retained" };
      if (state.deleteIncomplete) {
        const failed = { role: "data", name: `fake-${id}-data`, mountPath: "/data", status: "failed", error: { code: "INSTANCE_VOLUME_IDENTITY_MISMATCH", message: "volume identity mismatch" } };
        return json(200, {
          data: {
            instanceId: id,
            containerDeleted: true,
            completed: false,
            deletedVolumes: [],
            retainedVolumes: [volume],
            volumeResults: [failed],
          },
        });
      }
      return json(200, {
        data: {
          instanceId: id,
          containerDeleted: true,
          completed: true,
          deletedVolumes: deleteVolumes ? [volume] : [],
          retainedVolumes: deleteVolumes ? [] : [volume],
          volumeResults: [volume],
        },
      });
    }
    if (method === "GET" && path === "/api/nodes") return json(200, { data: [nodeEntry] });
    if (method === "PATCH" && /^\/api\/nodes\/[^/]+$/.test(path)) {
      nodeEntry.name = typeof body?.name === "string" ? body.name : nodeEntry.name;
      return json(200, { data: { id: nodeEntry.id, name: nodeEntry.name } });
    }
    if (method === "GET" && path === "/api/models") return json(200, { data: { models: [modelEntry] } });
    if (method === "GET" && path === "/api/users") return json(200, { data: [user] });
    if (method === "GET" && /^\/api\/users\/[^/]+$/.test(path)) return json(200, { data: userDetail });
    if (method === "GET" && /^\/api\/users\/[^/]+\/sessions$/.test(path)) return json(200, { data: [userSession] });
    if (method === "DELETE" && /^\/api\/users\/[^/]+\/sessions\/[^/]+$/.test(path)) return json(200, { data: { revoked: true } });
    if (method === "GET" && path === "/api/app-sessions") {
      return json(200, { data: { updatedAt: now, instances: [{ instanceId: instanceEntry.id, streamId: "stream_fake01", appSessions: { runningCount: 2, problemCount: 0, sessions: [appSession, guiAppSession], updatedAt: now } }] } });
    }
    if (method === "POST" && path === `/api/controlled-instances/${instanceEntry.id}/apps/sessions`) {
      return json(201, { data: { ...appSession, id: "appsess_new001", appId: body?.appId ?? appSession.appId, status: "starting" } });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/apps\/sessions\/[^/]+\/stop$/.test(path)) {
      return json(200, { data: { ...appSession, status: "stopped" } });
    }
    if (method === "PATCH" && /^\/api\/controlled-instances\/[^/]+\/apps\/sessions\/[^/]+$/.test(path)) {
      const sessionId = path.split("/").at(-1);
      const session = [appSession, guiAppSession].find((entry) => entry.id === sessionId) ?? appSession;
      return json(200, { data: { ...session, title: typeof body?.title === "string" ? body.title : session.title, updatedAt: now } });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/apps\/sessions\/[^/]+\/access$/.test(path)) {
      const sessionId = path.split("/").at(-2);
      const session = [appSession, guiAppSession].find((entry) => entry.id === sessionId);
      if (!session) return errorResponse(404, "APP_SESSION_NOT_FOUND", "App session was not found.");
      if (session.kind !== "gui") return errorResponse(409, "APP_SESSION_ACCESS_UNAVAILABLE", "This app session does not expose a VNC view.");
      return json(200, { data: { mode: "vnc", url: "/apps/access/vnc?token=lease_fake", token: "lease_fake", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/apps\/sessions\/[^/]+\/restart$/.test(path)) {
      return json(200, { data: { ...appSession, id: "appsess_restarted1", status: "running", updatedAt: now } });
    }
    if (method === "GET" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/history$/.test(path)) {
      return json(200, { data: { items: [{
        id: "ais_fake0000002",
        agent: "claude",
        creationSource: "ai-session",
        providerSessionId: "prov_history_01",
        cwd: "/workspace",
        lastActiveAt: now,
        archivedAt: now,
      }] } });
    }
    if (method === "POST" && path === `/api/controlled-instances/${instanceEntry.id}/ai-sessions`) {
      return json(201, { data: { disposition: "created", aiSessionId: "ais_created0001", providerSessionId: "prov_created01", creationSource: "ai-session" } });
    }
    if (method === "PUT" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/title$/.test(path)) {
      return json(200, { data: { disposition: "renamed", aiSessionId: path.split("/").at(-2), title: body?.title ?? "" } });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/fork$/.test(path)) {
      return json(200, { data: { disposition: "created", aiSessionId: "ais_forked0001", providerSessionId: "prov_fork01", creationSource: "ai-session" } });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/close$/.test(path)) {
      return json(200, { data: { disposition: "closed", aiSessionId: path.split("/")[5], providerSessionId: "prov_close01", creationSource: "ai-session" } });
    }
    if (method === "PUT" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/model-selection$/.test(path)) {
      return json(200, { data: { sessionId: path.split("/")[5], accepted: true } });
    }
    if (method === "PUT" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/reasoning-effort$/.test(path)) {
      return json(200, { data: { sessionId: path.split("/")[5], accepted: true } });
    }
    if (method === "PATCH" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/queue\/reorder$/.test(path)) {
      return json(200, { data: { sessionId: path.split("/")[5], queueRevision: 2, action: "reorder" } });
    }
    if (method === "PATCH" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/queue\/[^/]+$/.test(path)) {
      return json(200, { data: { sessionId: path.split("/")[5], queueRevision: 1, action: "edit", queueId: path.split("/").at(-1) } });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/(messages|interrupt|approval|resume|read)$/.test(path)) {
      const sessionId = path.split("/")[4];
      const action = path.split("/").at(-1);
      const payload = action === "messages"
        ? { sessionId, provider: "codex", action: "send", turnId: "turn_fake01", messageId: "msg_fake01" }
        : action === "interrupt"
          ? { sessionId, provider: "codex", action: "interrupt" }
          : action === "approval"
            ? { sessionId, provider: "codex", action: "approval", decision: body?.decision ?? "allow" }
            : action === "resume"
              ? { disposition: "resumed", aiSessionId: sessionId, providerSessionId: "prov_fake01", creationSource: "ai-session" }
              : { sessionId, unread: false };
      return json(200, { data: payload });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/queue\/[^/]+\/(steer|retry)$/.test(path)) {
      const segments = path.split("/");
      const queueId = segments.at(-2);
      const action = segments.at(-1);
      return action === "steer"
        ? json(200, { data: { sessionId: segments[4], provider: "codex", action: "steer", queueId } })
        : json(200, { data: { sessionId: segments[4], queueRevision: 1, action: "retry", queueId } });
    }
    if (method === "DELETE" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/queue\/[^/]+$/.test(path)) {
      const segments = path.split("/");
      return json(200, { data: { sessionId: segments[4], queueRevision: 1, action: "remove", queueId: segments.at(-1) } });
    }
    if (method === "GET" && path === "/api/stories") return json(200, { data: { stories: [story], unavailableNodeIds: [] } });
    if (method === "POST" && path === "/api/stories") return json(201, { data: { ...story, id: "story_new00000001", title: body?.input?.title ?? story.title } });
    if (method === "PATCH" && /^\/api\/stories\/[^/]+$/.test(path)) return json(200, { data: { ...story, ...(body?.input ?? {}) } });
    if (method === "POST" && /^\/api\/stories\/[^/]+\/(archive|restore)$/.test(path)) {
      const archivedAt = path.endsWith("archive") ? now : undefined;
      return json(200, { data: archivedAt ? { ...story, archivedAt } : story });
    }
    if (method === "DELETE" && /^\/api\/stories\/[^/]+$/.test(path)) return json(200, { data: { deleted: true } });
    if (method === "POST" && /^\/api\/stories\/[^/]+\/documents\/order$/.test(path)) {
      const order = body?.input?.storyPaths ?? [];
      return json(200, { data: { ...story, documents: order.map((storyPath) => ({ ...storyDocument, storyPath })) } });
    }
    if (method === "PATCH" && /^\/api\/stories\/[^/]+\/documents\//.test(path)) {
      return json(200, { data: { ...story, documents: [{ ...storyDocument, ...(body?.input ?? {}) }] } });
    }
    if (method === "DELETE" && /^\/api\/stories\/[^/]+\/documents\//.test(path)) return json(200, { data: { deleted: true } });
    if (method === "GET" && /^\/api\/stories\/[^/]+\/automations$/.test(path)) return json(200, { data: { automations: [automationStatus] } });
    if (method === "POST" && /^\/api\/stories\/[^/]+\/automations$/.test(path)) {
      const input = body?.input ?? {};
      return json(201, { data: { ...automationStatus, automation: { ...automation, ...input, id: "auto_new0000001" }, effectiveStatus: input.enabled === false ? "disabled" : "scheduled" } });
    }
    if (method === "PATCH" && /^\/api\/stories\/[^/]+\/automations\/[^/]+$/.test(path)) {
      const input = body?.input ?? {};
      return json(200, { data: { ...automationStatus, automation: { ...automation, ...input }, effectiveStatus: input.enabled === false ? "disabled" : automationStatus.effectiveStatus } });
    }
    if (method === "DELETE" && /^\/api\/stories\/[^/]+\/automations\/[^/]+$/.test(path)) return json(200, { data: { deleted: true } });
    if (method === "GET" && /^\/api\/stories\/[^/]+\/automations\/[^/]+\/runs$/.test(path)) return json(200, { data: { runs: [automationRun] } });
    if (method === "GET" && /^\/api\/stories\/[^/]+\/automations\/[^/]+$/.test(path)) return json(200, { data: automationStatus });
    if (method === "POST" && /^\/api\/stories\/[^/]+\/automations\/[^/]+\/(enable|disable)$/.test(path)) {
      const enabled = path.endsWith("enable");
      return json(200, { data: { ...automationStatus, automation: { ...automation, enabled }, effectiveStatus: enabled ? "scheduled" : "disabled" } });
    }
    if (method === "POST" && /^\/api\/stories\/[^/]+\/automations\/[^/]+\/run$/.test(path)) return json(200, { data: automationRun });
    if (method === "GET" && /^\/api\/stories\/[^/]+$/.test(path)) return json(200, { data: story });
    if (method === "GET" && path === "/api/triggers") return json(200, { data: { updatedAt: now, triggers: [triggerProjection] } });
    if (method === "POST" && path === "/api/triggers") {
      state.createdTriggerInput = body;
      return json(201, { data: { ...triggerConfig, id: triggerConfig.configHash } });
    }
    if (method === "PUT" && /^\/api\/triggers\/[^/]+$/.test(path)) {
      return json(200, { data: { trigger: { ...triggerConfig, id: triggerConfig.configHash }, partialFailures: [] } });
    }
    if (method === "DELETE" && /^\/api\/triggers\/[^/]+$/.test(path)) return json(200, { data: { deletedTemplate: true, partialFailures: [] } });
    if (method === "POST" && /^\/api\/triggers\/[^/]+\/apply$/.test(path)) {
      const instanceIds = Array.isArray(body?.instanceIds) ? body.instanceIds : [];
      return json(200, { data: { configHash: triggerConfig.configHash, results: instanceIds.map((instanceId) => ({ instanceId, applied: true })) } });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/triggers$/.test(path)) {
      return json(200, { data: { config: triggerConfig, deployment: triggerDeployment } });
    }
    if (method === "DELETE" && /^\/api\/controlled-instances\/[^/]+\/ai-sessions\/[^/]+\/triggers\/[^/]+$/.test(path)) {
      return json(200, { data: { deleted: true } });
    }
    if (method === "POST" && /^\/api\/controlled-instances\/[^/]+\/triggers\/[^/]+\/run$/.test(path)) {
      return json(200, { data: { runId: "autorun_fake001", status: "queued" } });
    }
    return errorResponse(404, "CONTROL_PLANE_NOT_FOUND", `No fake route for ${method} ${path}.`);
  }

  return {
    origin,
    state,
    fetchImpl,
    user,
    authorization,
    identityPayload,
    instanceEntry,
    aiSessionsView,
    nodeEntry,
    appSession,
    guiAppSession,
    modelEntry,
    userDetail,
    story,
    automation,
    automationStatus,
    automationRun,
    triggerProjection,
    authorizationDetail,
    approveBrowser() {
      state.approved = true;
    },
    paths() {
      return state.calls.map((call) => `${call.method} ${call.path}`);
    },
  };
}
