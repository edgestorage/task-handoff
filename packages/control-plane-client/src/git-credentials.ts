import { z } from "zod";
import {
  GitCredentialListResponseSchema,
  GitCredentialPublicSchema,
  InstanceGitCredentialAssignmentSchema,
} from "@task-handoff/protocol/managed-git-credentials";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { jsonRequest } from "./json-request.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();
const DeletedSchema = z.object({ deleted: z.boolean() }).strict();
const RevokedSchema = z.object({ revoked: z.boolean() }).strict();
const AssignmentInputSchema = z.object({ credentialId: z.string().trim().min(1).max(120) }).strict();

export function createControlPlaneGitCredentialsApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const credentialPath = (credentialId: string) => `/api/git-credentials/${encodeURIComponent(credentialId)}`;
  const assignmentsPath = (instanceId: string) => `/api/controlled-instances/${encodeURIComponent(instanceId)}/git-credential-assignments`;
  return {
    listCredentials(signal?: AbortSignal) {
      return requestData("/api/git-credentials", GitCredentialListResponseSchema, { signal });
    },
    getCredential(credentialId: string, signal?: AbortSignal) {
      return requestData(credentialPath(credentialId), GitCredentialPublicSchema, { signal });
    },
    createCredential(input: unknown) {
      return requestData("/api/git-credentials", GitCredentialPublicSchema, jsonRequest("POST", input));
    },
    updateCredential(credentialId: string, input: unknown) {
      return requestData(credentialPath(credentialId), GitCredentialPublicSchema, jsonRequest("PATCH", input));
    },
    removeCredential(credentialId: string) {
      return requestData(credentialPath(credentialId), DeletedSchema, jsonRequest("DELETE"));
    },
    listInstanceAssignments(instanceId: string, signal?: AbortSignal) {
      return requestData(assignmentsPath(instanceId), z.array(InstanceGitCredentialAssignmentSchema), { signal });
    },
    assignToInstance(instanceId: string, input: unknown) {
      const parsed = AssignmentInputSchema.parse(input);
      return requestData(assignmentsPath(instanceId), InstanceGitCredentialAssignmentSchema, jsonRequest("POST", parsed));
    },
    unassignFromInstance(instanceId: string, credentialId: string) {
      return requestData(`${assignmentsPath(instanceId)}/${encodeURIComponent(credentialId)}`, RevokedSchema, jsonRequest("DELETE"));
    },
  };
}

export type ControlPlaneGitCredentialsApi = ReturnType<typeof createControlPlaneGitCredentialsApi>;
