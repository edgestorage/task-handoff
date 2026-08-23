import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  GitCredentialHttpsResolveRequestSchema,
  GitCredentialHttpsResolveResponseSchema,
  GitCredentialSshAgentRequestSchema,
  GitCredentialSshAgentResponseSchema,
  GitCredentialSshPrepareRequestSchema,
  GitCredentialSshPrepareResponseSchema,
  NodeGitCredentialAuthorizationSetSchema,
  NodeGitCredentialPayloadSchema,
} from "@task-handoff/protocol/managed-git-credentials";
import type { NodeAgentState } from "../state.ts";
import { NodeGitCredentialRuntimeBroker } from "./runtime-broker.ts";

const CredentialParamsSchema = z.object({ credentialId: z.string().trim().min(1).max(120) }).strict();
const InstanceParamsSchema = z.object({ id: z.string().trim().min(1).max(120) }).strict();
const InvocationParamsSchema = InstanceParamsSchema.extend({ invocationId: z.string().trim().min(1).max(120) }).strict();

function bearerToken(headers: Record<string, unknown>) {
  const authorization = headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
}

export function registerNodeGitCredentialRoutes(app: FastifyInstance, state: NodeAgentState) {
  const broker = new NodeGitCredentialRuntimeBroker(state.gitCredentials);
  app.addHook("onClose", async () => broker.close());

  app.put("/api/node-agent/git-credentials/:credentialId", async (request) => {
    const params = CredentialParamsSchema.parse(request.params);
    const payload = NodeGitCredentialPayloadSchema.parse(request.body);
    if (payload.credential.id !== params.credentialId) {
      throw Object.assign(new Error("Credential payload identity mismatch."), { code: "GIT_CREDENTIAL_IDENTITY_MISMATCH", statusCode: 409 });
    }
    return { data: state.gitCredentials.putPayload(payload).credential };
  });

  app.delete("/api/node-agent/git-credentials/:credentialId", async (request) => ({
    data: { deleted: state.gitCredentials.removePayload(CredentialParamsSchema.parse(request.params).credentialId) },
  }));

  app.get("/api/node-agent/instances/:id/git-credential-authorizations", async (request) => {
    const { id } = InstanceParamsSchema.parse(request.params);
    state.requireInstance(id);
    return { data: state.gitCredentials.getAuthorizationSet(id) };
  });

  app.put("/api/node-agent/instances/:id/git-credential-authorizations", async (request) => {
    const { id } = InstanceParamsSchema.parse(request.params);
    state.requireInstance(id);
    const desired = NodeGitCredentialAuthorizationSetSchema.parse(request.body);
    if (desired.instanceId !== id) {
      throw Object.assign(new Error("Git credential authorization identity mismatch."), { code: "GIT_CREDENTIAL_AUTHORIZATION_IDENTITY_MISMATCH", statusCode: 409 });
    }
    return { data: state.gitCredentials.putAuthorizationSet(desired) };
  });

  app.post("/api/node-agent/instances/:id/git-credentials/https", async (request) => {
    const { id } = InstanceParamsSchema.parse(request.params);
    state.authenticateInstance(id, bearerToken(request.headers));
    const input = GitCredentialHttpsResolveRequestSchema.parse(request.body);
    return { data: GitCredentialHttpsResolveResponseSchema.parse(broker.resolveHttps(id, input.remoteUrl)) };
  });

  app.post("/api/node-agent/instances/:id/git-credentials/ssh/prepare", async (request) => {
    const { id } = InstanceParamsSchema.parse(request.params);
    state.authenticateInstance(id, bearerToken(request.headers));
    const input = GitCredentialSshPrepareRequestSchema.parse(request.body);
    return { data: GitCredentialSshPrepareResponseSchema.parse(await broker.prepareSsh(id, input.remoteUrl)) };
  });

  app.post("/api/node-agent/instances/:id/git-credentials/ssh/agent", async (request) => {
    const { id } = InstanceParamsSchema.parse(request.params);
    state.authenticateInstance(id, bearerToken(request.headers));
    const input = GitCredentialSshAgentRequestSchema.parse(request.body);
    return { data: GitCredentialSshAgentResponseSchema.parse(await broker.exchangeAgentFrame(id, input.invocationId, input.frame)) };
  });

  app.delete("/api/node-agent/instances/:id/git-credentials/ssh/:invocationId", async (request) => {
    const { id, invocationId } = InvocationParamsSchema.parse(request.params);
    state.authenticateInstance(id, bearerToken(request.headers));
    return { data: { deleted: broker.release(invocationId, id) } };
  });
}
