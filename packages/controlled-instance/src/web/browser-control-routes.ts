import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  EmbeddedBrowserCreationClaimSchema,
  EmbeddedBrowserCreationDeclineSchema,
  EmbeddedBrowserCreationViewSchema,
  EmbeddedBrowserSourceDeltaSchema,
  EmbeddedBrowserSourceRegistrationRequestSchema,
  EmbeddedBrowserSourceRegistrationViewSchema,
  EmbeddedBrowserSourceSnapshotCommitSchema,
  EmbeddedBrowserSourceSnapshotSchema,
} from "@task-handoff/protocol/embedded-browser-control";
import { BrowserControlError, type BrowserControlService } from "./browser-control";
import type { BrowserControlRelayContext, BrowserControlRelayRegistry } from "./browser-control-relay";

const CONTROL_PLANE_HEADER = "x-task-handoff-control-plane-id";
const USER_HEADER = "x-task-handoff-user-id";
const PUBLIC_ROUTE = { config: { taskHandoffAuth: "public" as const } };
const RELAY_DETACH_TIMEOUT_MS = 3_000;

type RegisterBrowserControlRoutesOptions = {
  app: FastifyInstance;
  service: BrowserControlService;
  relay: BrowserControlRelayRegistry;
  registrationToken?: string;
};

function sameToken(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function bearerToken(request: FastifyRequest) {
  return request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function headerValue(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim();
}

export function browserProxyContext(request: FastifyRequest, registrationToken: string | undefined): BrowserControlRelayContext {
  const expected = registrationToken?.trim();
  if (!expected) {
    throw new BrowserControlError("BROWSER_CONTROL_UNSUPPORTED", "Browser control requires a managed instance registration token.", 503);
  }
  if (!sameToken(bearerToken(request), expected)) {
    throw new BrowserControlError("BROWSER_AUTHORIZATION_REQUIRED", "The managed instance proxy credential is required.", 403);
  }
  const panelId = headerValue(request, CONTROL_PLANE_HEADER);
  const userId = headerValue(request, USER_HEADER);
  if (!panelId || !userId || panelId.length > 240 || userId.length > 240) {
    throw new BrowserControlError("BROWSER_AUTHORIZATION_REQUIRED", "The verified Control Plane context is required.", 403);
  }
  return { panelId, userId };
}

function requireSourceOwner(request: FastifyRequest, service: BrowserControlService, registrationToken: string | undefined, sourceRef: string) {
  const context = browserProxyContext(request, registrationToken);
  const owner = service.sourceOwner(sourceRef);
  if (!owner || owner.panelId !== context.panelId || owner.ownerRef !== context.userId) {
    throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.", 404);
  }
  return context;
}

function sendBrowserError(reply: FastifyReply, error: unknown) {
  if (error instanceof BrowserControlError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  if (error && typeof error === "object" && "issues" in error) {
    return reply.code(400).send({ error: { code: "BROWSER_REQUEST_INVALID", message: error instanceof Error ? error.message : String(error) } });
  }
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : 500;
  return reply.code(statusCode).send({
    error: {
      code: typeof record.code === "string" ? record.code : "BROWSER_CONTROL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function parseBody<T>(schema: { parse: (value: unknown) => T }, body: unknown): T {
  return schema.parse(body ?? {});
}

async function detachWithTimeout(promise: Promise<unknown>) {
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RELAY_DETACH_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}

export function registerBrowserControlRoutes(options: RegisterBrowserControlRoutesOptions) {
  const { app, service, relay, registrationToken } = options;

  app.post("/api/browser-control/sources", { ...PUBLIC_ROUTE, bodyLimit: 256 * 1024 }, async (request, reply) => {
    try {
      const context = browserProxyContext(request, registrationToken);
      const body = parseBody(EmbeddedBrowserSourceRegistrationRequestSchema, request.body);
      const source = service.registerSource({
        panelId: context.panelId,
        ownerRef: context.userId,
        displayName: body.displayName,
        ...(body.hostLabel ? { hostLabel: body.hostLabel } : {}),
        publisherRef: body.publisherRef,
        ...(body.rendererHostBinding ? { rendererHostBinding: body.rendererHostBinding } : {}),
        pageHost: body.pageHost,
        pageHostCapabilities: body.pageHostCapabilities,
      });
      return {
        data: EmbeddedBrowserSourceRegistrationViewSchema.parse({
          source,
          registryEpoch: service.registryEpochValue(),
          registryRevision: service.registryRevisionValue(),
        }),
      };
    } catch (error) {
      return sendBrowserError(reply, error);
    }
  });

  app.put<{ Params: { sourceRef: string } }>("/api/browser-control/sources/:sourceRef/snapshot", { ...PUBLIC_ROUTE, bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    try {
      requireSourceOwner(request, service, registrationToken, request.params.sourceRef);
      const body = parseBody(EmbeddedBrowserSourceSnapshotSchema, request.body);
      if (body.sourceRef !== request.params.sourceRef) {
        throw new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "Snapshot sourceRef does not match the request path.", 400);
      }
      service.commitSnapshot(body);
      const binding = service.sourceBinding(body.sourceRef, body.generation);
      return {
        data: EmbeddedBrowserSourceSnapshotCommitSchema.parse({
          registryEpoch: binding.registryEpoch,
          registryRevision: binding.registryRevision,
          sourceRevision: binding.sourceRevision,
        }),
      };
    } catch (error) {
      return sendBrowserError(reply, error);
    }
  });

  app.post<{ Params: { sourceRef: string } }>("/api/browser-control/sources/:sourceRef/deltas", { ...PUBLIC_ROUTE, bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    try {
      requireSourceOwner(request, service, registrationToken, request.params.sourceRef);
      const body = parseBody(EmbeddedBrowserSourceDeltaSchema, request.body);
      if (body.sourceRef !== request.params.sourceRef) {
        throw new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "Delta sourceRef does not match the request path.", 400);
      }
      return { data: service.commitDelta(body) };
    } catch (error) {
      return sendBrowserError(reply, error);
    }
  });

  app.delete<{ Params: { sourceRef: string } }>("/api/browser-control/sources/:sourceRef", PUBLIC_ROUTE, async (request, reply) => {
    try {
      requireSourceOwner(request, service, registrationToken, request.params.sourceRef);
      service.revokeSource(request.params.sourceRef, "source-revoked");
      return { data: null };
    } catch (error) {
      return sendBrowserError(reply, error);
    }
  });

  app.get("/api/browser-control/creation-requests", PUBLIC_ROUTE, async (request, reply) => {
    try {
      const context = browserProxyContext(request, registrationToken);
      return { data: service.listCreationApprovalsForSourceOwner(context.panelId, context.userId) };
    } catch (error) {
      return sendBrowserError(reply, error);
    }
  });

  app.get("/api/browser-control/access", PUBLIC_ROUTE, async (request, reply) => {
    try {
      browserProxyContext(request, registrationToken);
      return { data: service.access() };
    } catch (error) {
      return sendBrowserError(reply, error);
    }
  });

  app.post("/api/browser-control/access", PUBLIC_ROUTE, async (request, reply) => {
    try {
      browserProxyContext(request, registrationToken);
      return { data: service.grantInstanceAccess() };
    } catch (error) {
      return sendBrowserError(reply, error);
    }
  });

  app.delete("/api/browser-control/access", PUBLIC_ROUTE, async (request, reply) => {
    try {
      browserProxyContext(request, registrationToken);
      const targets = service.leaseTargetsAll();
      await Promise.all(targets.map(({ sessionRef, leaseRef }) => {
        try {
          const target = service.leaseCommandTarget(sessionRef, leaseRef);
          return detachWithTimeout(relay.targetDetach({
            leaseRef: target.lease.leaseRef,
            tabRef: target.lease.tabRef,
            sourceRef: target.lease.sourceRef,
            generation: target.lease.generation,
            reason: "instance-access-revoked",
          }));
        } catch {
          return Promise.resolve();
        }
      }));
      return { data: { revokedLeases: service.revokeInstanceAccess() } };
    } catch (error) {
      return sendBrowserError(reply, error);
    }
  });

  app.post<{ Params: { sourceRef: string; creationRef: string } }>(
    "/api/browser-control/sources/:sourceRef/creation-requests/:creationRef/claim",
    { ...PUBLIC_ROUTE, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      try {
        requireSourceOwner(request, service, registrationToken, request.params.sourceRef);
        const body = parseBody(EmbeddedBrowserCreationClaimSchema, request.body);
        if (body.sourceRef !== request.params.sourceRef) {
          throw new BrowserControlError("BROWSER_CREATION_CONFLICT", "Creation claim sourceRef does not match the request path.", 400);
        }
        service.claimCreation(request.params.sourceRef, request.params.creationRef, body.expectedRevision);
        const creating = service.markCreationCreating(request.params.sourceRef, request.params.creationRef);
        const generation = service.sourceGeneration(request.params.sourceRef);
        if (generation === undefined) {
          throw new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "Browser source disconnected before creation dispatch.", 409);
        }
        try {
          await relay.tabsOpen({
            creationRef: creating.creationRef,
            sourceRef: request.params.sourceRef,
            generation,
            url: creating.requestedUrl,
            ...(creating.title ? { title: creating.title } : {}),
          });
        } catch (error) {
          service.failCreation(request.params.sourceRef, request.params.creationRef, error instanceof Error ? error.message : String(error));
          throw error;
        }
        return { data: EmbeddedBrowserCreationViewSchema.parse(creating) };
      } catch (error) {
        return sendBrowserError(reply, error);
      }
    },
  );

  app.post<{ Params: { sourceRef: string; creationRef: string } }>(
    "/api/browser-control/sources/:sourceRef/creation-requests/:creationRef/decline",
    { ...PUBLIC_ROUTE, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      try {
        requireSourceOwner(request, service, registrationToken, request.params.sourceRef);
        const body = parseBody(EmbeddedBrowserCreationDeclineSchema, request.body);
        if (body.sourceRef !== request.params.sourceRef) {
          throw new BrowserControlError("BROWSER_CREATION_CONFLICT", "Creation decline sourceRef does not match the request path.", 400);
        }
        return {
          data: EmbeddedBrowserCreationViewSchema.parse(service.declineCreation(
            request.params.sourceRef,
            request.params.creationRef,
            body.expectedRevision,
          )),
        };
      } catch (error) {
        return sendBrowserError(reply, error);
      }
    },
  );

  app.get("/api/browser-control/relay", {
    ...PUBLIC_ROUTE,
    websocket: true,
    preValidation: async (request, reply) => {
      try {
        browserProxyContext(request, registrationToken);
      } catch (error) {
        return sendBrowserError(reply, error);
      }
    },
  }, (socket, request) => {
    try {
      relay.attach(socket as never, browserProxyContext(request, registrationToken));
    } catch (error) {
      try { socket.close(1008, error instanceof Error ? error.message.slice(0, 123) : "Browser control authorization failed."); } catch { /* Already closed. */ }
    }
  });
}
