import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { Readable } from "node:stream";
import Fastify from "fastify";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { TASK_HANDOFF_WEBSOCKET_SERVER_OPTIONS } from "@task-handoff/protocol/websocket-bridge";
import { isControlPlaneCredentialHeader } from "./proxy-headers.ts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyServerOptions } from "fastify";
import { z } from "zod";
import { TtyStreamSnapshotMessageSchema } from "@task-handoff/protocol/app-sessions";
import { RelayTtySnapshotEnvelopeSchema, UpdateControlPlaneAvailableRolesSchema } from "@task-handoff/cloud-contracts";
import type { CloudDeviceTrustRoleOption } from "@task-handoff/protocol/device-trust";
import { CONTROL_PLANE_PROTOCOL_VERSION, ControlPlaneHealthResponseSchema, GitProvisioningTerminalEventType, ImagePullTerminalEventType, NodeStateProjectionEventSchema, type BuildInfo, type Node } from "@task-handoff/protocol/control-plane";
import {
  ControlPlaneCliAuthorizationApprovalResponseSchema,
  ControlPlaneCliAuthorizationDenialResponseSchema,
  ControlPlaneCliAuthorizationRequestDetailResponseSchema,
} from "@task-handoff/protocol/control-plane-access";
import { packageVersionResolver } from "@task-handoff/core/core/package-version";
import { DEFAULT_MAINTENANCE_INTERVAL_MS } from "@task-handoff/core/storage/retention";
import { SESSION_STREAM_PROTOCOL_VERSION, SessionStreamsHelloEventType, aiSessionTransientSubscriptionAccepts, type AiSessionTransientSubscription, type EventEnvelope } from "@task-handoff/protocol/events";
import { CONTROL_PLANE_SESSION_COOKIE, ControlPlaneAuth, type ControlPlaneAuthOptions } from "../auth/service.ts";
import type { ControlPlaneSessionClientType } from "../auth/user-authentication.ts";
import { ControlPlaneService, type ControlPlaneServiceOptions } from "../application/service.ts";
import {
  DEFAULT_MARKET_CATALOG_REFRESH_INTERVAL_MS,
  DEFAULT_MARKET_CATALOG_URL,
} from "../catalog/remote-market.ts";
import { ControlPlaneChatGatewayRuntime } from "../chat/gateway/runtime.ts";
import { acceptsResourceMetricInstance, ControlPlaneEventBus } from "../events/bus.ts";
import { OperationApprovals, type OperationApprovalPolicy } from "../approvals/operation-approvals.ts";
import { registerOperationApprovalRoutes } from "./operation-approval-routes.ts";
import { AiSessionAttachmentStore } from "../sessions/ai-session-attachments.ts";
import { AiSessionAttachmentCache } from "../sessions/ai-session-attachment-cache.ts";
import { ControlPlaneNodeAgentTunnelTransport, ControlPlaneNodeEventSubscriber } from "../nodes/tunnel.ts";
import { controlPlaneStorePaths } from "../persistence/paths.ts";
import { createControlPlaneDatabase } from "../persistence/database/index.ts";
import { importLegacyP0Json } from "../persistence/database/legacy-p0-import.ts";
import { migrateLegacyIdentityProviderSecrets } from "../persistence/database/legacy-identity-provider-import.ts";
import { SecretEnvelopeService } from "../persistence/secret-envelope.ts";
import { acquireControlPlaneSingletonLock, defaultControlPlaneSingletonLockPath } from "../process/singleton-lock.ts";
import { assertCan, assertCanAccessResolvedResource, cloudAccountAuthorization, instanceScopeAllows, type ControlPlaneActor } from "../auth/authorization.ts";
import { cloudEventAllowed, cloudOwnerOnlyRoute, cloudRelayRouteReachable, routeAuthorization } from "./cloud-relay-authorization.ts";
import { resolveRequestResourceScopes } from "../auth/resource-scope.ts";
import { controlPlaneRequestActor, setControlPlaneRequestActor } from "./request-actor.ts";
import { registerControlPlaneManagementRoutes } from "./management-routes.ts";
import { registerInstanceProxyRoutes } from "./instance-proxy-routes.ts";
import { ControlPlaneAiSessionAggregator } from "../sessions/ai-session-aggregator.ts";
import { StorySessionIndex } from "../sessions/story-session-index.ts";
import { ControlPlaneAppSessionAggregator } from "../sessions/app-session-aggregator.ts";
import { nodeAgentInstallScript } from "../nodes/install-script.ts";
import { ImagePullProgressProjector } from "../images/image-pull-progress.ts";
import { GitProvisioningProgressProjector } from "../instances/git-provisioning-progress.ts";
import { PUBLIC_CONTROL_PLANE_ROUTE, PUBLIC_CONTROL_PLANE_UI_ROUTE } from "./auth-boundary.ts";
import { ControlPlaneProxyStore } from "../proxy/store.ts";
import { ControlPlaneProxyService } from "../proxy/service.ts";
import { ControlPlaneNodeProxyRuntime } from "../proxy/runtime.ts";
import { ControlPlaneProxyEventHub } from "../proxy/event-hub.ts";
import { registerNodeProxyRoutes } from "./node-proxy-routes.ts";
import { ControlPlaneProxyStateSubscriber } from "../nodes/control-plane-proxy-state-subscriber.ts";
import { registerControlPlaneProxyManagementRoutes } from "./control-plane-proxy-management-routes.ts";
import { registerControlPlaneUserRoutes } from "./user-routes.ts";
import { registerControlPlaneGitCredentialRoutes } from "./git-credential-routes.ts";
import { projectControlPlaneProxyTarget, publicControlPlaneProxyTarget } from "../proxy/target-projector.ts";
import { proxyStateProjectionSignature } from "../proxy/state-projection.ts";
import { ControlPlaneIdentityService } from "../identity/service.ts";
import { NodeConnectionRuntime } from "../nodes/connection-runtime.ts";
import { createControlPlaneDiagnosticLogger, createDiagnosticLogsArchive } from "../diagnostics/logs.ts";
import { CloudConnectivityService } from "../cloud-connectivity/service.ts";
import type { CloudConnectivityLifecycle } from "../cloud-connectivity/lifecycle.ts";
import { CloudConnectivityBackgroundRuntime } from "../cloud-connectivity/coordinator-runtime.ts";
import { relayTraceFromEnvironment } from "../cloud-connectivity/relay-trace.ts";
import { nodeRelayTraceFromEnvironment } from "../cloud-connectivity/node-relay-trace.ts";
import { CloudAccountSessionService } from "../cloud-connectivity/account-session.ts";
import { CloudRelayNodeAgentTransport } from "../nodes/cloud-relay-transport.ts";
import { nodeRelayInstallCommand } from "../cloud-connectivity/node-install-command.ts";
import { AuthorizationConnectionRegistry } from "../auth/authorization-connections.ts";
import { registerBrowserRelayRoutes } from "./browser-relay-routes.ts";
import { BrowserAccessService } from "../instances/browser-access-service.ts";
import { ControlPlaneAgentAggregator } from "../agents/agent-aggregator.ts";
import { decodeCloudRelayRequestBody } from "./relay-request-body.ts";
import {
  CLOUD_ENVIRONMENT_VARIABLES,
  configuredCloudEnvironmentVariables,
  isTrustedCloudServiceOrigin,
  resolveCloudDiscovery,
  resolveCloudEnvironment,
  type CloudEnvironment,
} from "../../../../../shared/cloud-environments.cjs";
import { CloudEndpointResolver } from "../../../../../shared/cloud-discovery.cjs";
import { createControlPlaneDeviceTrustStore } from "../device-trust/repository.ts";
import { CloudDeviceTrustService, type CloudDeviceTrustActor } from "../device-trust/service.ts";
import { TrustedDeviceSessionRegistry } from "../device-trust/trusted-device-sessions.ts";
import { registerDeviceTrustRoutes } from "./device-trust-routes.ts";

export type CreateControlPlaneAppOptions = {
  dataDir?: string;
  staticDir?: string;
  logger?: FastifyServerOptions["logger"];
  service?: ControlPlaneServiceOptions;
  auth?: ControlPlaneAuthOptions;
  operationApprovalPolicy?: OperationApprovalPolicy;
  proxyOrigin?: string;
  cloudServiceOrigin?: string;
  cloudServiceOrigins?: string[];
  allowNonProductionCloudOrigin?: boolean;
  cloudConnectivityEnabled?: boolean;
  cloudAccountFetch?: typeof fetch;
  cloudDiscovery?: CloudEndpointResolver;
  cloudDiscoveryFetch?: typeof fetch;
  cloudConnectivityLifecycle?: (state: CloudConnectivityService) => CloudConnectivityLifecycle;
  publishCloudBindingChallenge?: (challenge: ReturnType<CloudConnectivityService["createChallenge"]>) => Promise<void>;
};

const CLOUD_INTERNAL_ACTOR_HEADER = "x-task-handoff-cloud-internal-actor";

export type RunControlPlaneServerOptions = CreateControlPlaneAppOptions & {
  host: string;
  port: number;
};

export const ControlPlaneHttpErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean().optional(),
  requestId: z.string().trim().min(1).optional(),
}).strict();

export const ControlPlaneHttpErrorResponseSchema = z.object({
  error: ControlPlaneHttpErrorSchema,
}).strict();

// The selected cloud environment decides which service origin this build trusts.
// `allowNonProduction` remains an explicit development escape hatch for ad-hoc
// local clouds; it never widens what a production process accepts.
export function trustedCloudServiceOrigin(value: string | undefined, options: { production?: boolean; allowNonProduction?: boolean; environment?: CloudEnvironment } = {}) {
  // A production process always keeps the production environment, even when a
  // non-production environment was requested through configuration.
  const configured = options.environment ?? resolveCloudEnvironment();
  const environment = options.production === true && configured.id !== "production"
    ? resolveCloudEnvironment("production")
    : configured;
  if (options.allowNonProduction === true && options.production !== true) return new URL(value || environment.serviceOrigin).origin;
  const origin = new URL(value || environment.serviceOrigin).origin;
  if (!isTrustedCloudServiceOrigin(environment, origin)) throw Object.assign(new Error("Non-production cloud service origin is not trusted by this build."), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  return origin;
}

/**
 * Coordinator transports may use any host under the environment's Coordinator
 * suffixes. The canonical origin remains first and authoritative; alternates
 * are ordered fallbacks only.
 */
export function trustedCloudCoordinatorOrigins(
  values: readonly string[] | undefined,
  canonical: string,
  options: { production?: boolean; allowNonProduction?: boolean; environment?: CloudEnvironment } = {},
) {
  const configured = options.environment ?? resolveCloudEnvironment();
  const environment = options.production === true && configured.id !== "production"
    ? resolveCloudEnvironment("production")
    : configured;
  const coordinatorHostSuffixes = environment.coordinatorHostSuffixes;
  const origins = new Set<string>();
  for (const value of [canonical, ...(values ?? [])]) {
    let url: URL;
    try { url = new URL(value); } catch { throw coordinatorOriginError("Coordinator service origin is invalid."); }
    if (!options.production && options.allowNonProduction === true) {
      origins.add(url.origin);
      continue;
    }
    const suffixValid = coordinatorHostSuffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
    const secureTransport = url.protocol === "https:"
      || (environment.allowInsecureRelay === true && url.protocol === "http:");
    if (!secureTransport || !suffixValid || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
      throw coordinatorOriginError("Coordinator service origin is not trusted by this build.");
    }
    origins.add(url.origin);
  }
  return [...origins];
}

function defaultStaticDir() {
  return path.resolve(process.cwd(), "packages", "control-plane-ui", "dist");
}

function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function configuredCoordinatorOrigins(value: string | undefined) {
  if (!value?.trim()) return [] as string[];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((origin) => typeof origin !== "string")) throw coordinatorOriginError("Coordinator service origins must be a string array.");
    return parsed as string[];
  }
  return trimmed.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function coordinatorOriginError(message: string) {
  return Object.assign(new Error(message), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
}

function controlPlaneDiagnosticLogsEnabled() {
  return envFlag(process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS);
}

function nodeStateProjection(node: Node & {
  connectionPhase?: "connecting" | "handshaking" | "healthy" | "reconnecting" | "suspect" | "offline";
  connectionDiagnostics?: {
    pingRttMs?: number;
    pingRttP95Ms?: number;
    consecutiveReconnects: number;
    nextRetryAt?: string;
  };
}) {
  return NodeStateProjectionEventSchema.parse({
    nodeId: node.id,
    status: node.status,
    health: node.health,
    lastSeenAt: node.lastSeenAt ?? null,
    connectionPhase: node.connectionPhase ?? null,
    connectionDiagnostics: node.connectionDiagnostics ?? null,
    proxyState: node.proxyState ?? null,
  });
}

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function marketCatalogOptionsFromEnv(warn: (message: string) => void = (message) => console.warn(message)): ControlPlaneServiceOptions["marketCatalog"] {
  const configuredUrl = process.env.TASK_HANDOFF_MARKET_CATALOG_URL?.trim();
  const disabled = configuredUrl !== undefined && ["", "0", "off", "false", "disabled"].includes(configuredUrl.toLowerCase());
  if (disabled) return undefined;

  // The issued catalog is authoritative for every repository it references, so
  // the signature is the integrity boundary. Without a key the remote catalog
  // stays off and the control plane keeps using the bundled snapshot.
  const publicKey = optionalEnv("TASK_HANDOFF_MARKET_CATALOG_PUBLIC_KEY");
  if (!publicKey) {
    if (configuredUrl) warn("TASK_HANDOFF_MARKET_CATALOG_PUBLIC_KEY is not set; the remote market catalog stays disabled and the bundled catalog is used.");
    return undefined;
  }

  const refreshInterval = process.env.TASK_HANDOFF_MARKET_REFRESH_INTERVAL;
  const refreshSeconds = refreshInterval === undefined ? undefined : Number(refreshInterval);
  return {
    url: configuredUrl || DEFAULT_MARKET_CATALOG_URL,
    publicKey,
    keyId: optionalEnv("TASK_HANDOFF_MARKET_CATALOG_KEY_ID"),
    allowedRepositoryPrefixes: optionalEnv("TASK_HANDOFF_MARKET_ALLOWED_REPOSITORIES")?.split(",").map((entry) => entry.trim()).filter(Boolean),
    refreshIntervalMs: refreshSeconds === undefined
      ? DEFAULT_MARKET_CATALOG_REFRESH_INTERVAL_MS
      : (Number.isFinite(refreshSeconds) && refreshSeconds > 0 ? refreshSeconds * 1000 : 0),
  };
}

const packageVersion = packageVersionResolver("@task-handoff/control-plane");

function buildInfo(): BuildInfo {
  return {
    component: "control-plane",
    packageName: "@task-handoff/control-plane",
    packageVersion: packageVersion(),
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    buildId: optionalEnv("TASK_HANDOFF_BUILD_ID"),
    builtAt: optionalEnv("TASK_HANDOFF_BUILT_AT"),
    gitCommit: optionalEnv("TASK_HANDOFF_GIT_COMMIT"),
    imageRef: optionalEnv("TASK_HANDOFF_IMAGE_REF"),
    imageDigest: optionalEnv("TASK_HANDOFF_IMAGE_DIGEST"),
  };
}

const STATIC_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function staticFilePath(staticDir: string, relativePath: string) {
  const resolvedRoot = path.resolve(staticDir);
  const resolvedFile = path.resolve(resolvedRoot, relativePath);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    return undefined;
  }
  return fs.existsSync(resolvedFile) && fs.statSync(resolvedFile).isFile() ? resolvedFile : undefined;
}

function sendStaticFile(reply: FastifyReply, staticDir: string, relativePath: string) {
  const filePath = staticFilePath(staticDir, relativePath);
  if (!filePath) {
    return reply.code(404).send({
      error: {
        code: "STATIC_FILE_NOT_FOUND",
        message: `${relativePath} was not found in the Control Plane UI static directory.`,
      },
    });
  }
  reply.header("cache-control", "no-store");
  reply.type(STATIC_MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream");
  return reply.send(fs.createReadStream(filePath));
}

const CONTROL_PLANE_INTERNAL_ERROR_CODE = "CONTROL_PLANE_INTERNAL_ERROR";
const CONTROL_PLANE_INTERNAL_ERROR_MESSAGE = "The Control Plane could not complete the request.";

function requestCorrelationId(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

export function controlPlaneErrorPayload(error: unknown, options: { requestId?: unknown } = {}) {
  const requestId = requestCorrelationId(options.requestId);
  if (error instanceof z.ZodError) {
    return {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
      ...(requestId ? { requestId } : {}),
    };
  }
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const requestedStatusCode = typeof record.statusCode === "number" && record.statusCode >= 400 && record.statusCode <= 599
    ? record.statusCode
    : 500;
  const retryable = typeof record.retryable === "boolean" ? { retryable: record.retryable } : {};
  if (requestedStatusCode >= 500) {
    // Driver errors, query text, bind values, and upstream response bodies can
    // contain credentials or sensitive resource identifiers. Their internal
    // code, message, and details remain server-log-only.
    return {
      statusCode: requestedStatusCode,
      code: CONTROL_PLANE_INTERNAL_ERROR_CODE,
      message: CONTROL_PLANE_INTERNAL_ERROR_MESSAGE,
      ...retryable,
      ...(requestId ? { requestId } : {}),
    };
  }
  return {
    statusCode: requestedStatusCode,
    code: typeof record.code === "string" ? record.code : "CONTROL_PLANE_ERROR",
    message: error instanceof Error ? error.message : String(error),
    ...(record.details && typeof record.details === "object" && !Array.isArray(record.details) ? { details: record.details } : {}),
    ...retryable,
    ...(typeof record.retryAfterSeconds === "number" ? { retryAfterSeconds: record.retryAfterSeconds } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function disabledAuthActor(): ControlPlaneActor {
  return { type: "system", reason: "auth-disabled" };
}

function isPublicUiPath(url: string) {
  const path = url.split("?")[0] || "/";
  return !path.startsWith("/api/") && path !== "/api" && !path.startsWith("/instances/") && path !== "/instances";
}

type RequestSessionCredential = {
  token: string | undefined;
  source: "cookie" | "bearer";
  clientTypes: readonly ControlPlaneSessionClientType[];
};

/**
 * Credentials resolve by source, never by session ID shape: cookies only match web sessions,
 * Bearer tokens match machine sessions and can be narrowed per route (for example mobile-only).
 */
function requestSessionCredential(
  request: FastifyRequest,
  options: { allowCookie?: boolean; bearerClientTypes?: readonly ControlPlaneSessionClientType[] } = {},
): RequestSessionCredential {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    return { token: match?.[1], source: "bearer", clientTypes: options.bearerClientTypes ?? ["mobile", "cli"] };
  }
  return {
    token: request.cookies[CONTROL_PLANE_SESSION_COOKIE],
    source: "cookie",
    clientTypes: options.allowCookie === false ? [] : ["web"],
  };
}

async function actorForRequest(auth: ControlPlaneAuth, credential: RequestSessionCredential): Promise<ControlPlaneActor | undefined> {
  if (!auth.enabled()) {
    // disabled 模式下只有 bearer 形式的本地信任 CLI 会话按真实用户归属；
    // cookie 与匿名请求保持既有全权 system actor 语义，避免旧 Web 会话意外收窄权限。
    return credential.source === "bearer"
      ? auth.disabledModeAuthorization(credential.token, credential.clientTypes)
      : undefined;
  }
  return auth.authorizationForSessionToken(credential.token, credential.clientTypes);
}

function controlPlanePublicOrigin(service: ControlPlaneService, request: FastifyRequest) {
  const configured = service.getSettings().publicBaseUrl?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Ignore malformed public base URLs and fall back to the request host.
    }
  }
  const host = request.headers.host?.trim();
  if (host) {
    try {
      return new URL(`http://${host}`).origin;
    } catch {
      // Ignore malformed Host headers below.
    }
  }
  return "http://127.0.0.1";
}

function cliAuthorizationDecisionGuard(service: ControlPlaneService) {
  return async (request: FastifyRequest) => {
    if (request.headers.authorization !== undefined || !request.cookies[CONTROL_PLANE_SESSION_COOKIE]) {
      throw Object.assign(new Error("CLI authorization decisions require a Control Plane web session."), { code: "CONTROL_PLANE_AUTH_REQUIRED", statusCode: 401 });
    }
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method.toUpperCase())) return;
    const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw Object.assign(new Error("CLI authorization decisions require a JSON request body."), { code: "CLI_AUTHORIZATION_ORIGIN_INVALID", statusCode: 415 });
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite !== "same-origin") {
      throw Object.assign(new Error("CLI authorization decisions must originate from the Control Plane web UI."), { code: "CLI_AUTHORIZATION_ORIGIN_INVALID", statusCode: 403 });
    }
    if (request.headers.origin !== controlPlanePublicOrigin(service, request)) {
      throw Object.assign(new Error("CLI authorization decisions must originate from the Control Plane web UI."), { code: "CLI_AUTHORIZATION_ORIGIN_INVALID", statusCode: 403 });
    }
  };
}

function cliApprover(request: FastifyRequest) {
  const actor = controlPlaneRequestActor(request);
  if (!actor || actor.type !== "user") {
    throw Object.assign(new Error("Sign in to decide CLI authorization requests."), { code: "CONTROL_PLANE_AUTH_REQUIRED", statusCode: 401 });
  }
  return { userId: actor.userId, identityId: actor.identityId };
}

export { cloudEventAllowed, cloudOwnerOnlyRoute, cloudRelayRouteReachable, routeAuthorization } from "./cloud-relay-authorization.ts";

function requestLogSerializer(request: FastifyRequest) {
  return {
    id: request.id,
    method: request.method,
    url: request.url.split("?")[0],
    host: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

export async function createControlPlaneApp(options: CreateControlPlaneAppOptions = {}) {
  const paths = controlPlaneStorePaths(options.dataDir);
  const app = Fastify({
    logger: options.logger === false
      ? false
      : options.logger && typeof options.logger === "object"
        ? options.logger
        : { serializers: { req: requestLogSerializer } },
  });
  await app.register(compress, {
    encodings: ["br", "gzip", "deflate"],
    globalDecompression: false,
    threshold: 1024,
  });
  const database = await createControlPlaneDatabase(paths, options.auth?.database);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  await importLegacyP0Json(database, secrets, paths, {
    onWarning: (warning) => app.log.warn(warning, "legacy Control Plane P0 persistence archive deferred"),
  });
  await migrateLegacyIdentityProviderSecrets(database, secrets, paths);
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  const events = new ControlPlaneEventBus();
  const configuredApprovalPolicy = options.operationApprovalPolicy ?? (process.env.TASK_HANDOFF_OPERATION_APPROVAL_POLICY
    ? JSON.parse(process.env.TASK_HANDOFF_OPERATION_APPROVAL_POLICY) as unknown : {});
  const operationApprovals = new OperationApprovals(events, configuredApprovalPolicy);
  app.addHook("onClose", async () => operationApprovals.close());
  const authorizationConnections = new AuthorizationConnectionRegistry();
  const browserAccess = new BrowserAccessService();
  const cloudConnectivityEnabled = options.cloudConnectivityEnabled ?? process.env.TASK_HANDOFF_CLOUD_CONNECTIVITY_ENABLED !== "0";
  let diagnosticLogsEnabled = controlPlaneDiagnosticLogsEnabled();
  const diagnosticLogger = createControlPlaneDiagnosticLogger(paths.logsDir, () => diagnosticLogsEnabled, app.log);
  const nodeConnectionRuntime = new NodeConnectionRuntime();
  const service = new ControlPlaneService(paths, {
    ...options.service,
    database,
    secrets,
    logger: diagnosticLogger,
    nodeConnectionRuntime,
    onFleetStateChanged: (state) => {
      options.service?.onFleetStateChanged?.(state);
      events.publish("node.fleet.updated", state, {
        topic: state.resource === "instances" ? "instances" : state.resource === "models" ? "models" : "node.runtime",
        scope: { nodeId: state.nodeId },
      });
    },
  });
  nodeConnectionRuntime.onChange((observation) => {
    // Deletion and an in-flight connection observation can race. The
    // `node.deleted` event is authoritative, so a stale observation must never
    // turn into an uncaught NODE_NOT_FOUND failure.
    if (!service.nodes.get(observation.nodeId)) return;
    events.publish(
      "node.connection.updated",
      nodeStateProjection(service.requirePublicNode(observation.nodeId)),
      {
        topic: "node.state",
        scope: { nodeId: observation.nodeId },
      },
    );
  });
  const trustedDeviceSessions = new TrustedDeviceSessionRegistry();
  let cloudDeviceTrust: CloudDeviceTrustService | undefined;
  const auth = new ControlPlaneAuth(paths, {
    ...options.auth,
    onUserAuthorizationChanged: (change) => {
      events.invalidateUserAuthorization(change.userId, change.authorizationRevision);
      authorizationConnections.invalidate(change.userId, change.authorizationRevision);
      options.auth?.onUserAuthorizationChanged?.(change);
    },
  }, { repository: database, secrets });
  const identity = new ControlPlaneIdentityService(
    paths.identitySigningPath,
    () => service.proxyPrivateStore.controlPlaneId(),
    (message, details) => app.log.warn(details, message),
  );
  cloudDeviceTrust = new CloudDeviceTrustService(
    createControlPlaneDeviceTrustStore(database),
    (roleId, repository) => auth.users.roleAuthorization(roleId, repository),
    {
      closePinSessions: (pin, reason) => trustedDeviceSessions.closePin(pin.id, pin.authorizationRevision, reason),
      closeAllSessions: (reason) => trustedDeviceSessions.closeAll(reason),
      onChanged: ({ bindingId, revision }) => {
        events.publish("device-trust.changed", { bindingId, revision }, { topic: "device-trust" });
      },
    },
  );
  const configuredCloudVariables = configuredCloudEnvironmentVariables(process.env);
  const cloudEnvironment = resolveCloudEnvironment(configuredCloudVariables[CLOUD_ENVIRONMENT_VARIABLES.environment]);
  const cloudServiceOrigin = trustedCloudServiceOrigin(options.cloudServiceOrigin || configuredCloudVariables[CLOUD_ENVIRONMENT_VARIABLES.serviceOrigin], {
    production: process.env.NODE_ENV === "production",
    allowNonProduction: options.allowNonProductionCloudOrigin === true,
    environment: cloudEnvironment,
  });
  const configuredCloudDiscovery = resolveCloudDiscovery(cloudEnvironment, configuredCloudVariables);
  const cloudDiscovery = options.cloudDiscovery ?? (configuredCloudDiscovery && !options.cloudServiceOrigin
    ? new CloudEndpointResolver({
        config: configuredCloudDiscovery,
        fallbackOrigin: configuredCloudDiscovery.fallbackOrigin,
        fetchImpl: options.cloudDiscoveryFetch ?? options.cloudAccountFetch ?? globalThis.fetch,
        cachePath: path.join(paths.dataDir, "cloud-discovery.json"),
      })
    : undefined);
  if (cloudDiscovery) await cloudDiscovery.initialize();
  const cloudServiceOrigins = trustedCloudCoordinatorOrigins(
    options.cloudServiceOrigins ?? configuredCoordinatorOrigins(configuredCloudVariables[CLOUD_ENVIRONMENT_VARIABLES.serviceOrigins]),
    cloudServiceOrigin,
    {
      production: process.env.NODE_ENV === "production",
      allowNonProduction: options.allowNonProductionCloudOrigin === true,
      environment: cloudEnvironment,
    },
  );
  const cloudConnectivity = new CloudConnectivityService({ statePath: paths.cloudConnectivityPath, identity, serviceOrigin: cloudServiceOrigin });
  const cloudAccountSession = new CloudAccountSessionService({ statePath: paths.cloudAccountSessionPath, serviceOrigin: cloudServiceOrigin });
  const cloudRelayActors = new Map<string, ControlPlaneActor>();
  const cloudRelayBridge = {
    async request(actor: ControlPlaneActor, input: { path: string; method: string; headers: Record<string, string>; body?: unknown; bodyStream?: Readable; binaryResponse?: boolean }) {
      const method = String(input?.method || "GET").toUpperCase();
      const requestPath = String(input?.path || "");
      const authorization = routeAuthorization(method, requestPath);
      if (!requestPath.startsWith("/api/") || !cloudRelayRouteReachable(method, requestPath)) {
        throw Object.assign(new Error("Cloud access route is not available."), { code: "CLOUD_ROUTE_FORBIDDEN", statusCode: 403 });
      }
      if (actor.type === "cloud-account" && cloudOwnerOnlyRoute(requestPath) && actor.accessMode !== "owner") throw Object.assign(new Error("Cloud access route is not available."), { code: "CLOUD_ROUTE_FORBIDDEN", statusCode: 403 });
      if (authorization) assertCan(actor, authorization.action, authorization.resource);
      const token = crypto.randomBytes(32).toString("base64url");
      cloudRelayActors.set(token, actor);
      try {
        // A streamed body has no content-length; a stale one from the client
        // would truncate or reject the local request, so it is dropped.
        const dropped = input.bodyStream ? ["content-length"] : [];
        const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([name]) => {
          const lower = name.toLowerCase();
          return !isControlPlaneCredentialHeader(lower) && !["host", "connection", "upgrade", CLOUD_INTERNAL_ACTOR_HEADER].includes(lower) && !dropped.includes(lower);
        }).map(([name, value]) => [name, String(value)]));
        const requestBody = input.bodyStream ?? decodeCloudRelayRequestBody(input.body);
        const response = await app.inject({ method: method as any, url: requestPath, headers: { ...headers, [CLOUD_INTERNAL_ACTOR_HEADER]: token }, ...(requestBody === undefined ? {} : { payload: requestBody as any }) });
        if (input.binaryResponse && response.statusCode < 400) {
          const contentType = response.headers["content-type"];
          const filename = cloudRelayResponseFilename(response.headers["content-disposition"]);
          return {
            status: response.statusCode,
            binary: {
              bytes: new Uint8Array(response.rawPayload.buffer, response.rawPayload.byteOffset, response.rawPayload.byteLength),
              ...(typeof contentType === "string" && contentType ? { contentType } : {}),
              ...(filename ? { filename } : {}),
            },
          };
        }
        let body: unknown; try { body = response.json(); } catch { body = response.body; }
        return { status: response.statusCode, body };
      } finally { cloudRelayActors.delete(token); }
    },
    subscribe(actor: ControlPlaneActor, topics: string[], listener: (event: EventEnvelope) => void, aiSessionTransient?: AiSessionTransientSubscription, resourceMetricInstanceIds?: string[]) {
      if (actor.type !== "cloud-account") throw Object.assign(new Error("Cloud account actor required."), { code: "CLOUD_ACTOR_REQUIRED" });
      // The relay decoder supplies ["*"] when the legacy field is absent.
      // An explicit empty list means the last consumer has unsubscribed.
      const selected = new Set(topics);
      if (!selected.size) return () => undefined;
      // Resource metrics share the `instances` topic with real directory
      // changes, so they carry their own scope in the subscribe envelope. The
      // relay actor is already authorized for the whole binding; this can only
      // narrow the stream, never widen it.
      const metricScope = resourceMetricInstanceIds === undefined ? undefined : new Set(resourceMetricInstanceIds);
      // Compatibility for v0.0.21 cloud clients: absence of the additive model
      // retains topic-derived legacy demand. Current mobile clients are precise.
      const stopEvents = events.on((event) => {
        if (!acceptsResourceMetricInstance(metricScope, event)) return;
        if (!cloudEventAllowed(actor, event)) return;
        if ((selected.has("*") || selected.has(event.topic) || selected.has(event.type)) && aiSessionTransientSubscriptionAccepts(aiSessionTransient, event)) listener(event);
      });
      // Install delivery before publishing upstream demand so a synchronous
      // source replay cannot overtake this relay consumer.
      const stopTransientDemand = aiSessionTransient
        ? events.registerAiSessionTransientDemand(aiSessionTransient)
        : events.registerLegacyAiSessionTransientDemand(selected);
      const wantsResourceMetrics = selected.has("*")
        || selected.has("instances")
        || selected.has("instance.metrics.snapshot");
      const stopResourceMetricDemand = wantsResourceMetrics
        ? events.registerResourceMetricDemand(resourceMetricInstanceIds)
        : () => undefined;
      return () => {
        stopEvents();
        stopTransientDemand();
        stopResourceMetricDemand();
      };
    },
    async openTty(actor: ControlPlaneActor, input: { instanceId: string; sessionId: string }, listener: (message: any) => void) {
      const instanceId = String(input?.instanceId || ""); const sessionId = String(input?.sessionId || "");
      assertCan(actor, "proxy", { type: "instance", id: instanceId, instanceId });
      if (!instanceId || !sessionId) throw Object.assign(new Error("TTY target is required."), { code: "TTY_TARGET_REQUIRED", statusCode: 400 });
      const callbacks = new Map<string, Set<(...args: any[]) => void>>();
      const emit = (name: string, ...args: any[]) => { for (const callback of callbacks.get(name) ?? []) callback(...args); };
      let closed = false;
      const socket = {
        readyState: 1,
        on(name: string, callback: (...args: any[]) => void) { const current = callbacks.get(name) ?? new Set(); current.add(callback); callbacks.set(name, current); },
        send(raw: unknown) { try { const value = JSON.parse(String(raw)); if (value.type === "snapshot") { const snapshot = TtyStreamSnapshotMessageSchema.parse(value); listener(RelayTtySnapshotEnvelopeSchema.parse({ type: "tty-snapshot", data: snapshot.data, pendingEscape: snapshot.pendingEscape, cols: snapshot.cols, rows: snapshot.rows })); } else if (value.type === "output") listener({ type: "tty-output", data: value.data }); else if (value.type === "resize") listener({ type: "tty-resize", body: { cols: value.cols, rows: value.rows } }); else if (value.type === "exit") listener({ type: "tty-exit", code: value.code, signal: value.signal }); else if (value.type === "error") listener({ type: "tty-error" }); } catch { listener({ type: "tty-error" }); } },
        close() { if (closed) return; closed = true; emit("close"); listener({ type: "tty-closed" }); },
      };
      await service.proxyInstanceWebSocket(instanceId, socket as any, `/api/apps/sessions/${encodeURIComponent(sessionId)}/tty`, [], {});
      return { send(data: string) { if (!closed) emit("message", Buffer.from(JSON.stringify({ type: "input", data }))); }, resize(cols: number, rows: number) { if (!closed && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) emit("message", Buffer.from(JSON.stringify({ type: "resize", cols, rows }))); }, close() { socket.close(); } };
    },
  };
  // Account-bound node agents reach this Control Plane over a cloud relay
  // channel that reuses the reverse-tunnel transport verbatim. The transport
  // itself is created after the shared tunnel it delegates to, so the runtime
  // only receives a lazy resolver; the local node record stays the single
  // mapping between a cloud handle and business code.
  let cloudRelayNodeTransport: CloudRelayNodeAgentTransport | undefined;
  const nodeRelayTrace = nodeRelayTraceFromEnvironment(process.env, paths.dataDir);
  const publishCloudRelayNodeState = (nodeId: string) => events.publish("node.checked", { nodeId }, { topic: "node.state", scope: { nodeId } });
  const cloudRelayNodeRelay = {
    transport: () => cloudRelayNodeTransport,
    nodes: {
      listForClaim: () => service.listCloudRelayNodesToClaim(),
      resolve: (nodeHandle: string) => {
        const linked = service.findNodeByCloudAccountHandle(nodeHandle);
        if (linked) return { nodeId: linked.id, preserveLocalConnection: true };
        const node = service.findCloudRelayNode(nodeHandle);
        if (!node) return undefined;
        const pairing = node.auth.mode === "paired-hmac" && node.auth.keyId && node.auth.secret
          ? { keyId: node.auth.keyId, secret: node.auth.secret }
          : undefined;
        return { nodeId: node.id, ...(pairing ? { pairing } : {}) };
      },
      inspectNode: (nodeId: string) => {
        const node = service.nodes.get(nodeId);
        if (!node) return undefined;
        return {
          nodeId: node.id,
          connectionKind: node.connectionPath.kind,
          ...(node.connectionPath.kind === "cloud-relay" ? { nodeHandle: node.connectionPath.nodeHandle } : {}),
        };
      },
      linkNode: async (nodeId: string, nodeHandle: string) => { await service.linkNodeToCloudAccount(nodeId, nodeHandle); },
      ensure: (input: { nodeHandle: string; nodeId: string; displayName?: string }) => service.ensureCloudRelayNode(input),
      savePairing: async (nodeId: string, pairing: { keyId: string; secret: string }) => { await service.saveCloudRelayNodePairing(nodeId, pairing); },
      connected: async (nodeId: string) => { await service.setCloudRelayNodeConnection(nodeId, true); publishCloudRelayNodeState(nodeId); },
      disconnected: async (nodeId: string, input: { reason: string }) => { await service.setCloudRelayNodeConnection(nodeId, false, input.reason); publishCloudRelayNodeState(nodeId); },
    },
  };
  const cloudConnectivityRuntime = new CloudConnectivityBackgroundRuntime({
    state: cloudConnectivity, accountSession: cloudAccountSession, identity, relayBridge: cloudRelayBridge,
    deviceTrust: cloudDeviceTrust,
    trustedDeviceSessions,
    roleCatalog: () => auth.users.roleCatalog(),
    logger: { info: (data, message) => app.log.info(data, message), warn: (data, message) => app.log.warn(data, message) },
    fetch: options.cloudAccountFetch, relayTrace: relayTraceFromEnvironment(process.env, paths.dataDir),
    cloudRelaySessionsPath: paths.cloudRelaySessionsPath, coordinatorOrigins: cloudServiceOrigins,
    ...(cloudDiscovery ? { cloudDiscovery } : {}),
    onOriginFailover: ({ fromOrigin, toOrigin, reason }) => app.log.warn({ code: "CLOUD_COORDINATOR_ORIGIN_FAILOVER", fromOrigin, toOrigin, reason }, "cloud_coordinator_origin_failover"),
    ...(cloudConnectivityEnabled ? { nodeRelay: cloudRelayNodeRelay } : {}),
  });
  const cloudConnectivityLifecycle = options.cloudConnectivityLifecycle?.(cloudConnectivity) ?? cloudConnectivityRuntime.lifecycle;
  const publishCloudBindingChallenge = options.publishCloudBindingChallenge ?? ((challenge: ReturnType<CloudConnectivityService["createChallenge"]>) => cloudConnectivityRuntime.publishBindingChallenge(challenge));
  const imagePullProgress = new ImagePullProgressProjector(events);
  const gitProvisioningProgress = new GitProvisioningProgressProjector(events);
  // A recovered Session snapshot has no tunnel behind it, so its scope is rebuilt from the
  // instance it belongs to. Without this the bus derives a scope from the payload alone,
  // which drops the nodeId every tunnel-forwarded Session event carries.
  const publishRecoveredSessionEvent = (event: { type: string; payload: unknown }) => {
    const meta = (event.payload as { meta?: { instanceId?: unknown } } | undefined)?.meta;
    const instanceId = typeof meta?.instanceId === "string" && meta.instanceId ? meta.instanceId : undefined;
    if (!instanceId) return events.publish(event.type, event.payload);
    const nodeId = service.nodeIdForInstance(instanceId);
    return events.publish(event.type, event.payload, { scope: { instanceId, ...(nodeId ? { nodeId } : {}) } });
  };
  const aiSessionAggregator = new ControlPlaneAiSessionAggregator({
    bootstrap: () => service.bootstrapAiSessionsFromInstances(),
    logger: diagnosticLogger,
    recoverDelta: (instanceId, streamId, sinceRevision) => service.recoverAiSessionDelta(instanceId, streamId, sinceRevision),
    recoverSnapshot: (instanceId) => service.recoverAiSessionSnapshot(instanceId),
    onRecoveredEvent: publishRecoveredSessionEvent,
  });
  const storySessionIndex = new StorySessionIndex();
  aiSessionAggregator.onSnapshot((update) => {
    storySessionIndex.replaceInstance(update.instanceId, update.aiSessions);
  });
  const appSessionAggregator = new ControlPlaneAppSessionAggregator({
    bootstrap: () => service.bootstrapAppSessionsFromInstances(),
    logger: diagnosticLogger,
    recoverDelta: (instanceId, streamId, sinceRevision) => service.recoverAppSessionDelta(instanceId, streamId, sinceRevision),
    recoverSnapshot: (instanceId) => service.recoverAppSessionSnapshot(instanceId),
    onRecoveredEvent: publishRecoveredSessionEvent,
  });
  service.setAppSessionSnapshotProvider((options) => appSessionAggregator.list(options));
  service.setAiSessionSnapshotProvider((options) => aiSessionAggregator.list(options));
  service.setAiSessionInstanceSnapshotProvider((instanceId) => aiSessionAggregator.snapshotForInstance(instanceId));
  const agentAggregator = new ControlPlaneAgentAggregator();
  const aiSessionAttachmentCache = new AiSessionAttachmentCache(paths.dataDir, {
    onWarning: (reason) => app.log.warn(reason),
  });
  events.on((event) => {
    imagePullProgress.handle(event);
    gitProvisioningProgress.handle(event);
    if (event.type === "instance.deleted" || event.type === "instance.updated") {
      const instanceId = event.payload && typeof event.payload === "object" && "instanceId" in event.payload
        ? String((event.payload as { instanceId?: unknown }).instanceId || "")
        : "";
      if (instanceId) {
        if (event.type === "instance.deleted") {
          appSessionAggregator.removeInstance(instanceId);
          aiSessionAggregator.removeInstance(instanceId);
          storySessionIndex.removeInstance(instanceId);
        }
        aiSessionAttachmentCache.removeInstance(instanceId);
      }
    }
  });
  const aiSessionAttachments = new AiSessionAttachmentStore();
  app.addHook("onClose", async () => {
    aiSessionAttachments.dispose();
  });
  const nodeAgentTunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    connectionRuntime: nodeConnectionRuntime,
    validateInstanceScope: (nodeId, instanceId) => service.nodeOwnsInstance(nodeId, instanceId),
    onInstanceLifecycle: (nodeId, lifecycle) => service.applyInstanceLifecycle(nodeId, lifecycle),
    onInstanceHeartbeat: (nodeId, heartbeat) => service.applyInstanceLifecycleHeartbeat(nodeId, heartbeat),
    onStreamsHello: (instanceId, hello) => {
      for (const descriptor of hello.streams) {
        if (descriptor.topic === "ai.sessions") aiSessionAggregator.advertiseStream(instanceId, descriptor);
        if (descriptor.topic === "app.sessions") appSessionAggregator.advertiseStream(instanceId, descriptor);
      }
    },
    onSessionEvent: (event) => event.type.startsWith("app-session.")
      ? appSessionAggregator.handleEvent(event)
      : aiSessionAggregator.handleEvent(event),
    onAgentEvent: (nodeId, type, payload) => agentAggregator.handleEvent(nodeId, type, payload),
    onCapabilitiesChanged: async (nodeId) => {
      const checked = await service.checkNode(nodeId);
      events.publish("node.checked", { nodeId: checked.id }, { topic: "node.state", scope: { nodeId: checked.id } });
    },
  });
  const explicitProxyOrigin = options.proxyOrigin || process.env.TASK_HANDOFF_CONTROL_PLANE_PROXY_ORIGIN;
  const projectProxyTarget = (nodeId: string) => {
    const node = service.nodes.get(nodeId);
    return node
      ? projectControlPlaneProxyTarget(node, nodeAgentTunnel.connected(node.id))
      : undefined;
  };
  const proxy = new ControlPlaneProxyService(
    new ControlPlaneProxyStore(paths.proxyAuthorityPath, (message, details) => app.log.warn(details, message)),
    {
      get: projectProxyTarget,
    },
    {
      proxyOrigin: explicitProxyOrigin,
      proxyOriginProvider: () => service.getSettings().publicBaseUrl,
    },
  );
  const proxyRuntime = new ControlPlaneNodeProxyRuntime();
  const proxyEventHub = new ControlPlaneProxyEventHub(events, {
    projectTarget: (targetNodeId) => {
      const target = projectProxyTarget(targetNodeId);
      return target ? publicControlPlaneProxyTarget(target) : undefined;
    },
  });
  // Only a semantic change is a reason to notify subscribers; see
  // proxyStateProjectionSignature for why.
  const publishedProxyStates = new Map<string, string>();
  const proxyStateSubscriber = new ControlPlaneProxyStateSubscriber(service, {
    fetchImpl: options.service?.fetchImpl,
    logger: diagnosticLogger,
    onStateChanged: (node) => {
      const projection = nodeStateProjection(node);
      const signature = proxyStateProjectionSignature(projection);
      if (publishedProxyStates.get(node.id) === signature) return;
      publishedProxyStates.set(node.id, signature);
      events.publish("node.proxy-state.updated", projection, { topic: "node.state", scope: { nodeId: node.id } });
    },
  });
  events.on((event) => {
    if (event.type === "node.created" || event.type === "node.updated" || event.type === "node.deleted") {
      proxyStateSubscriber.syncNow();
    }
    if (event.type === "instance.created" || event.type === "instance.updated" || event.type === "instance.deleted") {
      const instanceId = event.payload && typeof event.payload === "object" && "instanceId" in event.payload
        ? String((event.payload as { instanceId?: unknown }).instanceId || "")
        : "";
      if (instanceId) nodeAgentTunnel.invalidateInstanceScope({ instanceId });
    }
    if (event.type === "node.deleted") {
      const nodeId = event.payload && typeof event.payload === "object" && "nodeId" in event.payload
        ? String((event.payload as { nodeId?: unknown }).nodeId || "")
        : "";
      if (nodeId) {
        publishedProxyStates.delete(nodeId);
        nodeAgentTunnel.invalidateInstanceScope({ nodeId });
        const revoked = proxy.revokeTarget(nodeId);
        for (const binding of revoked.bindings) {
          proxyRuntime.closeBinding(binding.id, "Proxy target was deleted.");
          events.publish("control-plane-proxy.binding.updated", { binding }, { topic: "control-plane-proxy", scope: { nodeId } });
        }
      }
    }
  });
  service.setNodeAgentTransport(nodeAgentTunnel);
  if (cloudConnectivityEnabled) {
    cloudRelayNodeTransport = new CloudRelayNodeAgentTransport({
      tunnel: nodeAgentTunnel,
      trace: nodeRelayTrace,
      onIdentified: async (nodeId) => {
        await service.checkNode(nodeId);
        publishCloudRelayNodeState(nodeId);
      },
    });
    service.setCloudRelayNodeAgentTransport(cloudRelayNodeTransport);
  }
  await auth.init();
  await service.init();
  diagnosticLogsEnabled = service.diagnosticLogsEnabled();
  identity.init();
  cloudConnectivity.init();
  cloudAccountSession.init();
  if (cloudConnectivityEnabled) cloudConnectivityRuntime.start();
  let pairingRecoveryInFlight: Promise<void> | undefined;
  let pairingRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  let persistenceMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
  const recoverPendingPairings = () => {
    if (pairingRecoveryInFlight) return pairingRecoveryInFlight;
    const recovery = service.recoverPendingPairingRevokes().then(() => undefined);
    pairingRecoveryInFlight = recovery;
    void recovery.then(() => {
      if (pairingRecoveryInFlight === recovery) pairingRecoveryInFlight = undefined;
    }, () => {
      if (pairingRecoveryInFlight === recovery) pairingRecoveryInFlight = undefined;
    });
    return recovery;
  };
  await recoverPendingPairings().catch((error) => app.log.warn({ error }, "pending node pairing recovery failed"));
  proxy.init();
  proxyStateSubscriber.start();
  await service.syncLocalNodeConnection().catch(() => undefined);
  const chatGateway = new ControlPlaneChatGatewayRuntime(service, options.service?.fetchImpl, {
    aiSessions: aiSessionAggregator,
    logger: diagnosticLogger,
    diagnosticLogsEnabled: () => diagnosticLogsEnabled,
  });
  chatGateway.startEnabled();
  const nodeEventSubscriber = new ControlPlaneNodeEventSubscriber(service, nodeAgentTunnel, {
    safetyIntervalMs: Number(process.env.TASK_HANDOFF_EVENT_CONNECTION_SAFETY_INTERVAL_MS) || undefined,
    logger: diagnosticLogger,
    connectionRuntime: nodeConnectionRuntime,
  });
  const stopAiSessionTransientDemand = events.onAiSessionTransientDemand((demand) => {
    nodeEventSubscriber.setAiSessionTransientDemand(demand);
  });
  const stopResourceMetricDemand = events.onResourceMetricDemand((demand) => {
    nodeEventSubscriber.setResourceMetricDemand(demand);
  });
  nodeEventSubscriber.start();
  await app.register(cookie);
  await app.register(websocket, { options: TASK_HANDOFF_WEBSOCKET_SERVER_OPTIONS });
  app.addHook("onClose", async () => {
    await cloudConnectivityRuntime.stop();
    if (pairingRecoveryTimer) clearInterval(pairingRecoveryTimer);
    if (persistenceMaintenanceTimer) clearInterval(persistenceMaintenanceTimer);
    await pairingRecoveryInFlight?.catch(() => undefined);
    imagePullProgress.close();
    gitProvisioningProgress.close();
    proxyEventHub.stop();
    proxyStateSubscriber.stop();
    nodeEventSubscriber.stop();
    stopAiSessionTransientDemand();
    stopResourceMetricDemand();
    chatGateway.stopAll();
    service.dispose();
    await auth.close();
    await database.close();
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = requestCorrelationId(request.id);
    const payload = controlPlaneErrorPayload(error, { requestId });
    if (requestId) reply.header("x-request-id", requestId);
    if (payload.retryAfterSeconds !== undefined) {
      reply.header("retry-after", String(payload.retryAfterSeconds));
    }
    if (diagnosticLogsEnabled || payload.statusCode >= 500) {
      const log = payload.statusCode >= 500 ? request.log.error.bind(request.log) : request.log.warn.bind(request.log);
      const matchedRoute = request.routeOptions.url;
      log(
        {
          err: error,
          requestId,
          method: request.method,
          route: matchedRoute && matchedRoute !== "*" ? matchedRoute : request.url.split("?")[0],
          statusCode: payload.statusCode,
          errorCode: payload.code,
        },
        "control plane request failed",
      );
    }
    reply.code(payload.statusCode).send(ControlPlaneHttpErrorResponseSchema.parse({
      error: {
        code: payload.code,
        message: payload.message,
        ...(payload.details ? { details: payload.details } : {}),
        ...(payload.retryable !== undefined ? { retryable: payload.retryable } : {}),
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
      },
    }));
  });

  app.addHook("preHandler", async (request, reply) => {
    // Fastify matches percent-decoded paths, while request.url retains the raw
    // client encoding. Security decisions must use the matched route template
    // so an encoded segment such as /%61pi cannot be mistaken for a public UI
    // path after Fastify has routed it to /api.
    const matchedRoute = request.routeOptions.url;
    const securityUrl = matchedRoute && matchedRoute !== "*" ? matchedRoute : request.url;
    const authBoundary = request.routeOptions.config.controlPlaneAuthBoundary;
    const internalActorToken = request.headers[CLOUD_INTERNAL_ACTOR_HEADER];
    let cloudActor = typeof internalActorToken === "string" ? cloudRelayActors.get(internalActorToken) : undefined;
    if (cloudActor) {
      cloudRelayActors.delete(internalActorToken as string);
      setControlPlaneRequestActor(request, cloudActor);
      const authorization = routeAuthorization(request.method, securityUrl);
      if (!cloudRelayRouteReachable(request.method, securityUrl)) throw Object.assign(new Error("Cloud access route is not authorized."), { code: "CLOUD_ROUTE_FORBIDDEN", statusCode: 403 });
      if (cloudActor.type === "cloud-account" && cloudOwnerOnlyRoute(securityUrl) && cloudActor.accessMode !== "owner") throw Object.assign(new Error("Cloud access route is not authorized."), { code: "CLOUD_ROUTE_FORBIDDEN", statusCode: 403 });
      if (authorization) assertCan(cloudActor, authorization.action, authorization.resource);
      return;
    }
    // Machine routes opt out of UI sessions explicitly. Their handlers remain
    // responsible for binding credentials or paired node HMAC authentication.
    if (authBoundary === "proxy-binding" || authBoundary === "node-tunnel") {
      return;
    }
    const isPublicRoute = authBoundary === "public" || (authBoundary === "public-ui" && isPublicUiPath(request.url));
    if (!auth.enabled() || isPublicRoute) {
      const actor = await actorForRequest(auth, requestSessionCredential(request));
      setControlPlaneRequestActor(request, actor || disabledAuthActor());
      const authorization = routeAuthorization(request.method, securityUrl);
      if (authorization) {
        assertCan(actor || disabledAuthActor(), authorization.action, authorization.resource);
      }
      return;
    }
    const actor = await actorForRequest(auth, requestSessionCredential(request));
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "CONTROL_PLANE_AUTH_REQUIRED",
          message: "Sign in to access the Control Plane.",
        },
      });
    }
    setControlPlaneRequestActor(request, actor);
    if (actor.type === "user" && actor.requiresPasswordChange && securityUrl !== "/api/auth/password") {
      throw Object.assign(new Error("Change the temporary password before accessing the Control Plane."), {
        code: "AUTH_PASSWORD_CHANGE_REQUIRED",
        statusCode: 403,
      });
    }
    const authorization = routeAuthorization(request.method, securityUrl);
    if (authorization) {
      if (actor.type === "user") {
        assertCan(actor, authorization.action, authorization.resource);
        let scopes;
        try {
          scopes = await resolveRequestResourceScopes(service, request, securityUrl, authorization.resource, actor, authorization.action);
        } catch (error) {
          if (error && typeof error === "object" && (error as { statusCode?: number }).statusCode === 404) {
            throw Object.assign(new Error("The requested resource is not visible."), {
              statusCode: 404,
              code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE",
            });
          }
          throw error;
        }
        if (scopes?.length) {
          for (const scope of scopes) assertCanAccessResolvedResource(actor, authorization.action, authorization.resource, scope);
        }
      } else {
        assertCan(actor, authorization.action, authorization.resource);
      }
    }
  });

  const staticDir = path.resolve(options.staticDir || process.env.TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR || defaultStaticDir());
  if (fs.existsSync(staticDir)) {
    app.get("/assets/*", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
      const assetPath = (request.params as { "*": string })["*"];
      return sendStaticFile(reply, staticDir, path.join("assets", assetPath || ""));
    });
    app.get("/favicon.ico", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (_request, reply) => {
      const favicon = staticFilePath(staticDir, "favicon.ico");
      return favicon ? sendStaticFile(reply, staticDir, "favicon.ico") : reply.code(204).send();
    });
  }

  app.get("/api/health", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async () => ControlPlaneHealthResponseSchema.parse({
    data: {
      ok: true,
      role: "control-plane",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      build: buildInfo(),
      serverTime: new Date().toISOString(),
    },
  }));

  app.get("/api/control-plane/identity", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async () => (
    identity.publicDocument(auth.enabled() ? "required" : "disabled")
  ));

  const requireCloudConnectivityAdmin = async (request: FastifyRequest) => {
    if (!cloudConnectivityEnabled) throw Object.assign(new Error("Cloud connectivity is disabled by feature flag."), { code: "CLOUD_CONNECTIVITY_DISABLED", statusCode: 503 });
    const actor = (controlPlaneRequestActor(request) ?? await actorForRequest(auth, requestSessionCredential(request))) || disabledAuthActor();
    assertCan(actor, "manage-settings", { type: "control-plane-settings" });
    return actor;
  };

  // Availability is the local side of the split control model: the Cloud may
  // choose an owner role from this set, but only a local Control Plane operator
  // can make roles available. A cloud-account actor reaching this route through
  // the relay must not be able to widen or narrow its own authority.
  const requireLocalCloudAccessSettingsAdmin = async (request: FastifyRequest) => {
    const actor = await requireCloudConnectivityAdmin(request);
    if (actor.type !== "user" && actor.type !== "system") {
      throw Object.assign(new Error("Cloud access role availability is managed from the local Control Plane."), {
        code: "CLOUD_ACCESS_ROLES_LOCAL_ONLY",
        statusCode: 403,
      });
    }
  };

  const deviceTrustActor = (request: FastifyRequest): CloudDeviceTrustActor => {
    const actor = controlPlaneRequestActor(request);
    if (!actor || actor.type === "chat-bridge") {
      throw Object.assign(new Error("A trusted administrator is required."), {
        code: "CLOUD_DEVICE_TRUST_ADMIN_REQUIRED",
        statusCode: 403,
      });
    }
    return {
      type: actor.type === "user" ? "user" : actor.type === "cloud-account" ? "cloud-account" : "system",
      id: actor.type === "user" ? actor.userId : actor.type === "cloud-account" ? `cloud-account:${actor.accountId}` : actor.reason,
      roleIds: actor.type === "user" || actor.type === "cloud-account" ? actor.roleIds : [],
      permissionIds: actor.type === "user" || actor.type === "cloud-account" ? actor.permissionIds : [],
      ...(actor.type === "cloud-account" && actor.deviceTrustPinId ? { deviceTrustPinId: actor.deviceTrustPinId } : {}),
    };
  };

  const deviceTrustBindingId = (request: FastifyRequest) => {
    const actor = controlPlaneRequestActor(request);
    return actor?.type === "cloud-account" ? actor.bindingId : cloudConnectivity.snapshot().bindingId;
  };

  const deviceTrustRoles = async (): Promise<CloudDeviceTrustRoleOption[]> => (await auth.users.roleSummaries()).map((role) => ({
    roleId: role.id,
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    status: role.status,
    isAdmin: role.permissionIds.includes("settings:manage"),
  }));

  registerDeviceTrustRoutes(app, {
    service: cloudDeviceTrust,
    actor: deviceTrustActor,
    bindingId: deviceTrustBindingId,
    roles: deviceTrustRoles,
  });

  app.get("/api/cloud-connectivity", async (request) => {
    await requireCloudConnectivityAdmin(request);
    return { data: cloudConnectivity.snapshot() };
  });

  app.get("/api/cloud-connectivity/access-settings", async (request) => {
    await requireLocalCloudAccessSettingsAdmin(request);
    return { data: await cloudConnectivityRuntime.accessRoleSettings() };
  });

  app.patch("/api/cloud-connectivity/access-settings", async (request) => {
    await requireLocalCloudAccessSettingsAdmin(request);
    const input = UpdateControlPlaneAvailableRolesSchema.parse(request.body);
    await auth.requireRecentAuthentication(requestSessionCredential(request).token);
    return { data: await cloudConnectivityRuntime.updateCloudAvailableRoles(input) };
  });

  // Compatibility alias for Control Plane builds that still copy a one-time code by hand.
  // New builds use POST /api/cloud-connectivity/binding-requests, which never exposes the code.
  app.post("/api/cloud-connectivity/challenges", async (request, reply) => {
    await requireCloudConnectivityAdmin(request);
    reply.header("cache-control", "no-store");
    const challenge = cloudConnectivity.createChallenge();
    await publishCloudBindingChallenge(challenge);
    return { data: challenge };
  });

  app.get("/api/cloud-account", async (request) => {
    await requireCloudConnectivityAdmin(request);
    return { data: cloudAccountSession.snapshot() };
  });

  app.post("/api/cloud-account/sign-in-requests", async (request, reply) => {
    await requireCloudConnectivityAdmin(request);
    reply.header("cache-control", "no-store");
    return { data: await cloudConnectivityRuntime.beginAccountRequest({ scope: "account:sign-in" }) };
  });

  app.post("/api/cloud-account/sign-out", async (request) => {
    await requireCloudConnectivityAdmin(request);
    return { data: await cloudConnectivityRuntime.signOutAccount() };
  });

  // The binding challenge is created and registered internally; the browser only ever sees
  // the approval URL, and the Cloud Coordinator consumes the challenge server-side.
  app.post("/api/cloud-connectivity/binding-requests", async (request, reply) => {
    await requireCloudConnectivityAdmin(request);
    reply.header("cache-control", "no-store");
    const challenge = cloudConnectivity.createChallenge();
    await publishCloudBindingChallenge(challenge);
    return { data: await cloudConnectivityRuntime.beginAccountRequest({ scope: "control-plane:bind", challengeCode: challenge.challengeCode }) };
  });

  app.post("/api/cloud-connectivity/remote-access", async (request) => {
    await requireCloudConnectivityAdmin(request);
    // New clients send both scopes; the legacy `enabled` field remains the
    // device-access switch so older callers keep their exact meaning.
    const input = z.object({
      enabled: z.boolean().optional(),
      scopes: z.object({ deviceAccess: z.boolean(), nodeRelay: z.boolean() }).strict().optional(),
    }).strict().refine((value) => value.enabled !== undefined || value.scopes !== undefined, { message: "scopes or enabled is required" }).parse(request.body);
    const scopes = input.scopes ?? { deviceAccess: input.enabled === true, nodeRelay: false };
    return { data: cloudConnectivityLifecycle ? await cloudConnectivityLifecycle.setRemoteAccess(scopes) : cloudConnectivity.setScopes(scopes) };
  });

  app.post("/api/cloud-connectivity/disconnect", async (request) => {
    await requireCloudConnectivityAdmin(request);
    return { data: cloudConnectivityLifecycle ? await cloudConnectivityLifecycle.disconnect() : cloudConnectivity.beginRevocation() };
  });

  // The account node directory backs the "add node from account" flow. It is
  // read through the signed-in account session (never the binding credential)
  // and degrades to `signedIn: false` so the UI can show sign-in guidance
  // instead of an error.
  app.get("/api/cloud-connectivity/account-nodes", async (request) => {
    await requireCloudConnectivityAdmin(request);
    const nodeRelay = cloudConnectivityRuntime.nodeRelayState();
    if (!cloudConnectivityEnabled) return { data: { signedIn: false, nodeRelay, items: [] } };
    try {
      return { data: { signedIn: true, nodeRelay, items: await cloudConnectivityRuntime.listAccountNodes() } };
    } catch (error) {
      if ((error as { code?: unknown })?.code === "CLOUD_ACCOUNT_SIGNED_OUT") return { data: { signedIn: false, nodeRelay, items: [] } };
      throw error;
    }
  });

  app.post("/api/cloud-connectivity/account-nodes/:nodeHandle/claim", async (request) => {
    await requireCloudConnectivityAdmin(request);
    const nodeHandle = String((request.params as { nodeHandle?: unknown }).nodeHandle ?? "");
    const data = await cloudConnectivityRuntime.claimAccountNode(nodeHandle);
    await service.setCloudRelayNodeClaimEnabled(nodeHandle, true);
    return { data };
  });

  // Revoking one claim leaves every other Control Plane's channel untouched.
  app.delete("/api/cloud-connectivity/account-nodes/:nodeHandle/claim", async (request) => {
    await requireCloudConnectivityAdmin(request);
    const nodeHandle = String((request.params as { nodeHandle?: unknown }).nodeHandle ?? "");
    // Persist the operator's intent before the remote call. A later restart
    // must not silently reclaim a node that was explicitly unbound, even if
    // the Coordinator is temporarily unreachable during this request.
    await service.setCloudRelayNodeClaimEnabled(nodeHandle, false);
    return { data: await cloudConnectivityRuntime.revokeAccountNodeClaim(nodeHandle) };
  });

  // Two commands from one token: the cloud-rendered CLI bind for a machine that
  // already runs a node agent, and the installer command for a machine with
  // nothing deployed yet. Both are shown once; only the token id is retained.
  app.post("/api/cloud-connectivity/node-binding-tokens", async (request, reply) => {
    await requireCloudConnectivityAdmin(request);
    reply.header("cache-control", "no-store");
    const input = z.object({ displayName: z.string().trim().max(120).optional() }).strict().parse(request.body ?? {});
    const issued = await cloudConnectivityRuntime.issueNodeBindingToken(input.displayName ? { displayName: input.displayName } : {});
    const bindingToken = typeof issued.bindingToken === "string" ? issued.bindingToken : "";
    const installCommand = bindingToken
      ? nodeRelayInstallCommand({
        controlPlaneUrl: controlPlanePublicOrigin(service, request),
        cloudOrigin: cloudConnectivity.snapshot().serviceOrigin,
        bindingToken,
      })
      : "";
    // `command` (already rendered cloud-side) is the CLI bind; the install
    // command is rendered here because only this Control Plane serves the
    // installer. The plaintext token is never stored or echoed again.
    return { data: { tokenId: issued.tokenId, expiresAt: issued.expiresAt, command: issued.command, installCommand } };
  });

  app.delete("/api/cloud-connectivity/node-binding-tokens/:tokenId", async (request) => {
    await requireCloudConnectivityAdmin(request);
    const tokenId = String((request.params as { tokenId?: unknown }).tokenId ?? "");
    return { data: await cloudConnectivityRuntime.cancelNodeBindingToken(tokenId) };
  });

  // Guided binding (path one): a signed-in Control Plane hands one of its
  // already-managed nodes a one-time binding token over the existing tunnel.
  // The node redeems it directly with the cloud; this Control Plane only
  // delivers the command, so it gains no privilege and no registry field. This
  // path deliberately omits the onboarding hint: publishing an existing node
  // must not auto-claim a relay channel back into this Control Plane.
  app.post("/api/nodes/:id/cloud-relay-binding", async (request) => {
    await requireCloudConnectivityAdmin(request);
    const nodeId = String((request.params as { id?: unknown }).id ?? "");
    const node = service.requireNode(nodeId);
    const cloudAccountId = cloudConnectivity.snapshot().accountId;
    const finalize = async (status: { bound: boolean; nodeHandle?: string; accountId?: string }, token?: { tokenId: string; expiresAt: string }) => {
      const nodeHandle = status.nodeHandle;
      if (!status.bound || !nodeHandle) {
        throw Object.assign(new Error("The node did not return its cloud account handle."), { statusCode: 502, code: "CLOUD_NODE_BINDING_HANDLE_UNAVAILABLE" });
      }
      if (status.accountId && cloudAccountId && status.accountId !== cloudAccountId) {
        throw Object.assign(new Error("This node is already bound to a different cloud account."), { statusCode: 409, code: "CLOUD_NODE_BOUND_TO_ANOTHER_ACCOUNT" });
      }
      const linked = await service.linkNodeToCloudAccount(nodeId, nodeHandle);
      // A node that already exists locally must keep its original connection.
      // Drop any relay claim and duplicate record created by older releases.
      await cloudConnectivityRuntime.revokeAccountNodeClaim(nodeHandle).catch((error) => {
        request.log.warn({ nodeId, nodeHandle, code: (error as { code?: unknown })?.code }, "cloud node claim cleanup skipped");
      });
      for (const duplicateId of linked.duplicateNodeIds) {
        await service.deleteNode(duplicateId).catch((error) => {
          request.log.warn({ nodeId, duplicateId, nodeHandle, code: (error as { code?: unknown })?.code }, "duplicate cloud relay node cleanup skipped");
        });
      }
      events.publish("node.cloud-relay.bound", { nodeId, ...(token ? { tokenId: token.tokenId } : {}) });
      return { data: { ...status, nodeHandle, ...(token ? { tokenId: token.tokenId, expiresAt: token.expiresAt } : {}) } };
    };

    // Older UI builds may already have bound this node and left a cloud-relay
    // duplicate behind. Treat the bind action as idempotent so one click can
    // restore the original connection and converge the records.
    const current = await service.getNodeCloudRelayStatus(nodeId).catch(() => undefined);
    if (current?.bound && current.nodeHandle) return await finalize(current);

    const issued = await cloudConnectivityRuntime.issueNodeBindingToken({ displayName: node.name, onboarding: false });
    const bindingToken = typeof issued.bindingToken === "string" ? issued.bindingToken : "";
    if (!bindingToken) {
      throw Object.assign(new Error("The cloud did not return a binding token."), { statusCode: 502, code: "CLOUD_NODE_BINDING_TOKEN_UNAVAILABLE" });
    }
    let result;
    try {
      result = await service.bindNodeCloudRelay(nodeId, {
        cloudOrigin: cloudConnectivity.snapshot().serviceOrigin,
        bindingToken,
        ...(node.name ? { displayName: node.name } : {}),
      });
    } catch (error) {
      // Delivery failed (node offline, older node agent, ...): cancel the
      // one-time token so it cannot linger, and leave every local record as is.
      await cloudConnectivityRuntime.cancelNodeBindingToken(issued.tokenId).catch(() => undefined);
      throw error;
    }
    return await finalize(result, issued);
  });

  app.get("/api/cloud-connectivity/node-relay", async (request) => {
    await requireCloudConnectivityAdmin(request);
    return { data: cloudConnectivityRuntime.nodeRelayState() };
  });

  // Relay payload capture is opt-in through its own flag and lands in its own JSONL files,
  // never in the log stream; this route only reports whether it is on and where it writes.
  app.get("/api/control-plane/relay-trace", async () => ({ data: cloudConnectivityRuntime.relayTrace.status() }));
  app.get("/api/control-plane/node-relay-trace", async (request) => {
    await requireCloudConnectivityAdmin(request);
    return { data: nodeRelayTrace.status() };
  });
  app.get("/api/session-streams/diagnostics", async () => ({
    data: {
      aiSessions: aiSessionAggregator.diagnostics(),
      aiSessionActions: service.aiSessionActionDiagnostics(),
      appSessions: appSessionAggregator.diagnostics(),
      nodeConnections: {
        ...nodeEventSubscriber.diagnostics(),
        runtime: nodeConnectionRuntime.diagnostics(),
      },
      eventAuthorization: events.authorizationDiagnostics(),
      browserRelay: browserAccess.diagnostics(),
    },
  }));

  app.get("/install-node-agent.sh", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.type("text/x-shellscript; charset=utf-8");
    return nodeAgentInstallScript();
  });

  app.get("/api/events", { websocket: true }, async (socket, request) => {
    const eventQuery = request.query as { aiSessionTransient?: string; resourceMetricsScope?: string; instanceId?: string };
    const eventInstanceId = typeof eventQuery.instanceId === "string" ? eventQuery.instanceId.trim() : "";
    const actor = controlPlaneRequestActor(request);
    const visibleInstances = actor?.type === "user"
      ? (await service.listControlledInstances()).filter((instance) => instanceScopeAllows(actor.nodeScope, actor.instanceScope, instance.id, instance.nodeId))
      : undefined;
    const visibleInstanceIds = visibleInstances ? new Set(visibleInstances.map((instance) => instance.id)) : undefined;
    if (eventInstanceId && visibleInstanceIds && !visibleInstanceIds.has(eventInstanceId)) {
      socket.close(4003, "The requested event scope is not visible.");
      return;
    }
    const pendingFrames: string[] = [];
    let handshakeSent = false;
    const gatedSocket = {
      get readyState() { return socket.readyState; },
      get bufferedAmount() { return socket.bufferedAmount; },
      OPEN: socket.OPEN,
      send(value: string) {
        if (handshakeSent) socket.send(value);
        else pendingFrames.push(value);
      },
      ping() {
        socket.ping();
      },
      on(event: "close" | "message", listener: (value?: unknown) => void) {
        socket.on(event, listener);
      },
      close(code?: number, reason?: string) {
        socket.close(code, reason);
      },
    };
    events.connect(gatedSocket, {
      instanceIds: eventInstanceId ? [eventInstanceId] : undefined,
      expectsTransientSubscription: eventQuery.aiSessionTransient === "1",
      expectsMetricSubscription: eventQuery.resourceMetricsScope === "1",
      ...(actor?.type === "user" || actor?.type === "cloud-account" ? {
        authorization: {
          userId: actor.type === "user" ? actor.userId : `cloud-account:${actor.accountId}`,
          ...(requestSessionCredential(request).source === "cookie" ? { webSession: true as const } : {}),
          authorizationRevision: actor.authorizationRevision,
          permissionIds: actor.permissionIds,
          ...(actor.type === "user" && actor.nodeScope.kind === "selected" ? {
            allowedNodeIds: new Set(actor.nodeScope.nodeIds),
          } : {}),
          ...(actor.type === "user" && (actor.instanceScope?.kind === "selected" || actor.nodeScope.kind === "selected") ? {
            allowedInstanceIds: visibleInstanceIds,
          } : {}),
        },
      } : {}),
    });
    const [aiStreams, appStreams] = await Promise.all([
      aiSessionAggregator.streamDescriptors(),
      appSessionAggregator.streamDescriptors(),
    ]);
    events.send(socket, SessionStreamsHelloEventType, {
      protocolVersion: SESSION_STREAM_PROTOCOL_VERSION,
      streams: [...aiStreams, ...appStreams].filter((stream) => (
        (!visibleInstanceIds || visibleInstanceIds.has(stream.instanceId))
        && (!eventInstanceId || stream.instanceId === eventInstanceId)
      )),
    });
    handshakeSent = true;
    for (const frame of pendingFrames) socket.send(frame);
    for (const snapshot of imagePullProgress.snapshots().filter((entry) => (
      (!visibleInstanceIds || visibleInstanceIds.has(entry.instanceId))
      && (!eventInstanceId || entry.instanceId === eventInstanceId)
    ))) {
      events.send(socket, ImagePullTerminalEventType.Snapshot, snapshot, {
        topic: "instances",
        scope: { instanceId: snapshot.instanceId },
      });
    }
    for (const snapshot of gitProvisioningProgress.snapshots().filter((entry) => (
      (!visibleInstanceIds || visibleInstanceIds.has(entry.instanceId))
      && (!eventInstanceId || entry.instanceId === eventInstanceId)
    ))) {
      events.send(socket, GitProvisioningTerminalEventType.Snapshot, snapshot, {
        topic: "instances",
        scope: { instanceId: snapshot.instanceId },
      });
    }
  });

  app.get("/api/auth/session", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request) => {
    // A relayed cloud account has no local session; report the official account
    // as the authenticated principal so relay profiles behave like signed-in clients.
    const actor = controlPlaneRequestActor(request);
    if (actor?.type === "cloud-account") {
      return { data: { ...await auth.state(), authenticated: true, authorization: cloudAccountAuthorization(actor) } };
    }
    const credential = requestSessionCredential(request);
    return { data: await auth.currentSession(credential.token, credential.clientTypes) };
  });
  app.post("/api/auth/bootstrap-admin", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    const user = await auth.bootstrapAdmin(request.body);
    return reply.code(201).send({ data: user });
  });
  app.post("/api/auth/login", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    const result = await auth.login(request.body, { sourceId: request.ip });
    reply.setCookie(CONTROL_PLANE_SESSION_COOKIE, result.sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expires: new Date(result.expiresAt),
    });
    return { data: { user: result.user } };
  });
  app.post("/api/auth/mobile/login", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request) => ({
    data: await auth.loginMobile(request.body, { sourceId: request.ip }),
  }));
  app.patch("/api/auth/password", async (request, reply) => {
    const result = await auth.changePassword(request.cookies[CONTROL_PLANE_SESSION_COOKIE], request.body);
    reply.setCookie(CONTROL_PLANE_SESSION_COOKIE, result.sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expires: new Date(result.expiresAt),
    });
    return { data: { user: result.user } };
  });
  app.post("/api/auth/step-up", async (request) => {
    const credential = requestSessionCredential(request, { bearerClientTypes: ["web"] });
    return { data: await auth.stepUp(credential.token, request.body) };
  });
  app.post("/api/auth/mobile/logout", async (request) => {
    const credential = requestSessionCredential(request, { allowCookie: false, bearerClientTypes: ["mobile"] });
    return { data: await auth.logoutSession(credential.token, credential.clientTypes) };
  });
  app.post("/api/auth/mobile/renew", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const credential = requestSessionCredential(request, { allowCookie: false, bearerClientTypes: ["mobile"] });
    const renewed = await auth.renewSession(credential.token, credential.clientTypes);
    return renewed ? { data: renewed } : reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to renew the mobile session." },
    });
  });
  app.get("/api/auth/mobile/sessions", async (request, reply) => {
    const credential = requestSessionCredential(request, { bearerClientTypes: ["mobile"] });
    const sessions = await auth.mobileSessions(credential.token, credential.clientTypes);
    return sessions ? { data: sessions } : reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to access mobile sessions." },
    });
  });
  app.delete("/api/auth/mobile/sessions/:id", async (request, reply) => {
    const params = z.object({ id: z.string().trim().min(1) }).parse(request.params);
    const credential = requestSessionCredential(request, { bearerClientTypes: ["mobile"] });
    const revoked = await auth.revokeMobileSession(credential.token, params.id, credential.clientTypes);
    return revoked === undefined ? reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to revoke mobile sessions." },
    }) : { data: { revoked } };
  });
  app.post("/api/auth/logout", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    const credential = requestSessionCredential(request);
    const result = await auth.logoutSession(credential.token, credential.clientTypes);
    reply.clearCookie(CONTROL_PLANE_SESSION_COOKIE, { path: "/" });
    return { data: result };
  });

  // CLI sign-in: the web session only approves the request; the CLI token is minted at exchange time.
  const cliDecisionGuard = cliAuthorizationDecisionGuard(service);
  app.post("/api/auth/cli/authorize", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request) => ({
    data: await auth.createCliAuthorization(request.body, { publicOrigin: controlPlanePublicOrigin(service, request), sourceId: request.ip }),
  }));
  app.post("/api/auth/cli/token", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request) => ({
    data: await auth.exchangeCliToken(request.body, { sourceId: request.ip }),
  }));
  // 本地信任会话：仅 authentication disabled 的桌面控制面板、且来源为 loopback 时可用。
  app.post("/api/auth/cli/local", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request) => ({
    data: await auth.createLocalCliSession(request.body, {
      remoteAddress: request.socket.remoteAddress,
      sourceId: request.ip,
    }),
  }));
  app.get("/api/auth/cli/requests/:requestId", { preHandler: cliDecisionGuard }, async (request) => (
    ControlPlaneCliAuthorizationRequestDetailResponseSchema.parse({
      data: auth.cliAuthorizationRequest(z.object({ requestId: z.string().trim().min(1) }).parse(request.params).requestId),
    })
  ));
  app.get("/api/auth/cli/requests", { preHandler: cliDecisionGuard }, async (request) => (
    ControlPlaneCliAuthorizationRequestDetailResponseSchema.parse({
      data: auth.cliAuthorizationRequestByUserCode(z.object({ userCode: z.string().trim().min(1).max(40) }).parse(request.query).userCode),
    })
  ));
  app.post("/api/auth/cli/requests/:requestId/approve", { preHandler: cliDecisionGuard }, async (request) => (
    ControlPlaneCliAuthorizationApprovalResponseSchema.parse({
      data: await auth.approveCliAuthorization(
        z.object({ requestId: z.string().trim().min(1) }).parse(request.params).requestId,
        cliApprover(request),
      ),
    })
  ));
  app.post("/api/auth/cli/requests/:requestId/deny", { preHandler: cliDecisionGuard }, async (request) => (
    ControlPlaneCliAuthorizationDenialResponseSchema.parse({
      data: await auth.denyCliAuthorization(
        z.object({ requestId: z.string().trim().min(1) }).parse(request.params).requestId,
        cliApprover(request),
      ),
    })
  ));
  app.post("/api/auth/cli/logout", async (request) => {
    const credential = requestSessionCredential(request, { allowCookie: false, bearerClientTypes: ["cli"] });
    return { data: await auth.logoutSession(credential.token, credential.clientTypes) };
  });
  app.post("/api/auth/cli/renew", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const credential = requestSessionCredential(request, { allowCookie: false, bearerClientTypes: ["cli"] });
    const renewed = await auth.renewSession(credential.token, credential.clientTypes);
    return renewed ? { data: renewed } : reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to renew the CLI session." },
    });
  });
  app.get("/api/auth/cli/sessions", async (request, reply) => {
    // The web UI manages the signed-in user's own CLI clients through its web session;
    // thctl continues to use its dedicated CLI bearer token.
    const credential = requestSessionCredential(request, { bearerClientTypes: ["cli"] });
    const sessions = await auth.cliSessions(credential.token, credential.clientTypes, { remoteAddress: request.socket.remoteAddress });
    return sessions ? { data: sessions } : reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to access CLI sessions." },
    });
  });
  app.delete("/api/auth/cli/sessions/:id", async (request, reply) => {
    const params = z.object({ id: z.string().trim().min(1) }).parse(request.params);
    const credential = requestSessionCredential(request, { bearerClientTypes: ["cli"] });
    const revoked = await auth.revokeCliSession(credential.token, params.id, credential.clientTypes, { remoteAddress: request.socket.remoteAddress });
    return revoked === undefined ? reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to revoke CLI sessions." },
    }) : { data: { revoked } };
  });

  app.get("/api/access/me", async (request, reply) => {
    const actor = controlPlaneRequestActor(request);
    if (actor?.type === "cloud-account") return { data: cloudAccountAuthorization(actor) };
    const credential = requestSessionCredential(request);
    const access = await auth.currentAccess(credential.token, credential.clientTypes, { remoteAddress: request.socket.remoteAddress });
    return access ? { data: access } : reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to read Control Plane access." },
    });
  });

  registerControlPlaneUserRoutes(app, auth, operationApprovals, {
    onRoleCatalogChanged: async () => {
      // Device pins resolve their permissions from this local role catalog.
      // Close live sessions before the next handshake establishes whether the
      // approved role still exists or changed.
      await cloudDeviceTrust?.closeAllSessions("local-role-catalog-changed");
      await cloudConnectivityRuntime.notifyAccessRoleCatalogChanged();
    },
  });
  registerControlPlaneGitCredentialRoutes(app, service, auth, operationApprovals);

  app.get("/api/control-plane/status", async () => ({
    data: {
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      build: buildInfo(),
      storage: paths,
    },
  }));
  app.get("/api/control-plane/settings", async () => ({ data: service.getSettings() }));
  app.patch("/api/control-plane/settings", async (request) => {
    const settings = service.updateSettings(request.body || {});
    diagnosticLogsEnabled = settings.diagnosticLogs;
    return { data: settings };
  });
  app.get("/api/control-plane/diagnostic-logs/export", async (_request, reply) => {
    const archive = await createDiagnosticLogsArchive({
      dataDir: paths.dataDir,
      nodeAgentDataDir: process.env.TASK_HANDOFF_DESKTOP_NODE_AGENT_DATA_DIR || process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR,
      diagnosticLogsEnabled,
    });
    reply.header("content-type", "application/gzip");
    reply.header("content-disposition", `attachment; filename="${archive.filename}"`);
    return reply.send(archive.stream);
  });

  app.post("/api/ai-session-attachments", { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    try {
      return reply.code(201).send({ data: aiSessionAttachments.upload(request.body) });
    } catch (error) {
      return reply.code(400).send({
        error: {
          code: "AI_SESSION_ATTACHMENT_INVALID",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  registerControlPlaneManagementRoutes({
    app,
    service,
    events,
    operationApprovals,
    auth,
    appSessionAggregator,
    aiSessionAggregator,
    chatGateway,
    aiSessionAttachments,
    aiSessionAttachmentCache,
    nodeAgentTunnel,
    nodeEventSubscriber,
    agentAggregator,
    errorPayload: controlPlaneErrorPayload,
    onInstanceDeleted: async (instanceId) => {
      if (!auth.enabled()) return;
      const affectedUserIds = await auth.users.removeInstanceFromAccessScopes(instanceId);
      for (const userId of affectedUserIds) await auth.notifyAuthorizationChanged(userId);
    },
  });
  registerOperationApprovalRoutes(app, auth, operationApprovals, cliAuthorizationDecisionGuard(service));

  registerNodeProxyRoutes({
    app,
    authority: proxy,
    resolveTarget: (targetNodeId) => {
      const node = service.requireNode(targetNodeId);
      return { node, transport: service.resolveNodeAgentTransport(node) };
    },
    projectTarget: projectProxyTarget,
    runtime: proxyRuntime,
    eventHub: proxyEventHub,
    onBindingRevoked: (binding) => events.publish("control-plane-proxy.binding.updated", {
      binding,
      audit: { action: "binding.revoke", actor: `control-plane:${binding.sourceControlPlaneId}` },
    }, { topic: "control-plane-proxy", scope: { nodeId: binding.targetNodeId } }),
  });
  registerControlPlaneProxyManagementRoutes({
    app,
    service,
    proxy,
    runtime: proxyRuntime,
    events,
    syncNodeEvents: () => nodeEventSubscriber.syncNow(),
    actorId: async (request) => {
      const actor = await actorForRequest(auth, requestSessionCredential(request));
      if (!actor) return "system:unknown";
      if (actor.type === "user") return `user:${actor.userId}`;
      if (actor.type === "system") return `system:${actor.reason}`;
      if (actor.type === "cloud-account") return `cloud-account:${actor.ownerAccountId}:${actor.accountId}:${actor.shareGrantId ?? "owner"}:${actor.deviceSessionId}`;
      return `chat-bridge:${actor.bridgeId}`;
    },
  });

  registerInstanceProxyRoutes({ app, service, auth, authorizationConnections });
  registerBrowserRelayRoutes({ app, service, auth, authorizationConnections, events, browserAccess });

  app.get("*", { config: PUBLIC_CONTROL_PLANE_UI_ROUTE }, async (_request, reply) =>
    fs.existsSync(staticDir)
      ? sendStaticFile(reply, staticDir, "index.html")
      : reply.code(404).send({
          error: {
            code: "CONTROL_PLANE_UI_NOT_BUILT",
            message: "Control plane API is running, but the Web UI static directory was not found.",
          },
        }),
  );

  pairingRecoveryTimer = setInterval(() => {
    void recoverPendingPairings().catch((error) => app.log.warn({ error }, "pending node pairing recovery failed"));
  }, 30_000);
  pairingRecoveryTimer.unref();
  persistenceMaintenanceTimer = setInterval(() => {
    service.runPersistenceMaintenance();
    void importLegacyP0Json(database, secrets, paths, {
      onWarning: (warning) => app.log.warn(warning, "legacy Control Plane P0 persistence archive deferred"),
    }).catch((error) => app.log.warn({ error }, "legacy Control Plane P0 persistence archive retry failed"));
  }, DEFAULT_MAINTENANCE_INTERVAL_MS);
  persistenceMaintenanceTimer.unref();
  return app;
}

function cloudRelayResponseFilename(disposition: unknown) {
  if (typeof disposition !== "string") return undefined;
  const raw = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1]?.trim();
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Desktop waits for the Control Plane's HTTP listener, and a cold packaged
// launch can spend a long time loading modules before that listener exists.
// These breadcrumbs are written before the app logger exists, so they go
// straight to stdout, which Desktop prefixes with [control-plane].
function createControlPlaneStartupReporter(startedAt = Date.now()) {
  return (phase: string, details: Record<string, unknown> = {}) => {
    try {
      process.stdout.write(`${JSON.stringify({
        level: 30,
        time: Date.now(),
        pid: process.pid,
        ...details,
        elapsedMs: Date.now() - startedAt,
        msg: `control plane ${phase}`,
      })}\n`);
    } catch {
      // Startup breadcrumbs must never fail the boot.
    }
  };
}

export async function runControlPlaneServer(options: RunControlPlaneServerOptions) {
  const startup = createControlPlaneStartupReporter();
  startup("starting", { host: options.host, port: options.port, version: process.env.TASK_HANDOFF_VERSION || "" });
  const paths = controlPlaneStorePaths(options.dataDir);
  const lock = acquireControlPlaneSingletonLock(defaultControlPlaneSingletonLockPath(), {
    dataDir: paths.dataDir,
    host: options.host,
    port: options.port,
  });
  startup("singleton lease acquired", { lockPath: lock.lockPath });
  try {
    const app = await createControlPlaneApp({
      ...options,
      service: {
        ...options.service,
        marketCatalog: options.service?.marketCatalog ?? marketCatalogOptionsFromEnv(),
      },
    });
    app.addHook("onClose", async () => {
      lock.release();
    });
    await app.listen({ host: options.host, port: options.port });
    startup("http listener ready", { host: options.host, port: options.port });
    // systemd stops the service with SIGTERM. Close through Fastify so onClose
    // hooks run, including the cloud control socket. Exiting without this makes
    // a rapid restart look like a second live identity to the Coordinator and
    // can quarantine the Control Plane as a clone conflict.
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      startup("stopping", { signal });
      const forceExit = setTimeout(() => process.exit(0), 5_000);
      forceExit.unref();
      try { await app.close(); } catch { /* the process is exiting regardless */ }
      clearTimeout(forceExit);
      process.exit(0);
    };
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
  } catch (error) {
    lock.release();
    startup("startup failed", { error: error instanceof Error ? error.message : String(error) });
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw Object.assign(
        new Error(`Control plane port ${options.host}:${options.port} is already in use.`),
        { statusCode: 409, code: "CONTROL_PLANE_PORT_IN_USE", cause: error },
      );
    }
    throw error;
  }
}
