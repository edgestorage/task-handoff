import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { z } from "zod";
import {
  controlPlaneIdentitySigningInput,
  supportsControlPlaneCliSessions,
  ControlPlanePublicIdentityDocumentSchema,
  type ControlPlanePublicIdentityPayload,
} from "@task-handoff/protocol/control-plane-access";
import { createControlPlaneClient, type ControlPlaneClient, type ControlPlaneClientTransport } from "@task-handoff/control-plane-client";
import type { CliProfile, CliProfileStore } from "./config.ts";
import { ThctlError, CLI_EXIT_CODES, networkError, protocolError, serverError } from "./errors.ts";

const CLOCK_SKEW_MS = 60_000;
/** Ed25519 SPKI 前缀；Node 不能直接从裸公钥构造 KeyObject，这里补 DER 头。 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    retryable: z.boolean().optional(),
  }).loose(),
}).loose();

export function requestUrl(origin: string, route: string) {
  if (!route.startsWith("/") || route.startsWith("//")) {
    throw protocolError("Control Plane routes must be same-origin absolute paths.", { route });
  }
  const url = new URL(route, origin);
  if (url.origin !== origin) {
    throw protocolError("A thctl request cannot leave its verified Control Plane origin.", { route, origin });
  }
  return url.toString();
}

export function verifyControlPlaneIdentityPayload(
  document: z.infer<typeof ControlPlanePublicIdentityDocumentSchema>,
  now = Date.now(),
) {
  const { payload, signature } = document.data;
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (issuedAt > now + CLOCK_SKEW_MS || expiresAt <= now || expiresAt <= issuedAt) {
    throw new ThctlError("CLI_IDENTITY_STALE", "The Control Plane identity document is expired or its clock is invalid.", CLI_EXIT_CODES.identity);
  }
  const publicKeyBytes = Buffer.from(payload.publicKey.value, "base64url");
  const digest = createHash("sha256").update(publicKeyBytes).digest("base64url");
  if (`sha256:${digest}` !== payload.publicKey.fingerprint) {
    throw new ThctlError("CLI_IDENTITY_FINGERPRINT_INVALID", "The Control Plane public key fingerprint is invalid.", CLI_EXIT_CODES.identity);
  }
  let key;
  try {
    key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]), format: "der", type: "spki" });
  } catch {
    throw new ThctlError("CLI_IDENTITY_KEY_INVALID", "The Control Plane public key is not a valid Ed25519 key.", CLI_EXIT_CODES.identity);
  }
  const message = Buffer.from(controlPlaneIdentitySigningInput(payload), "utf8");
  if (!verifySignature(null, message, key, Buffer.from(signature, "base64url"))) {
    throw new ThctlError("CLI_IDENTITY_SIGNATURE_INVALID", "The Control Plane identity signature is invalid.", CLI_EXIT_CODES.identity);
  }
  return payload;
}

export type ThctlTransportOptions = {
  origin: string;
  fetchImpl: typeof fetch;
  sessionToken?: () => string | undefined;
  onUnauthorized?: () => void;
};

/** 所有网络访问都经过共享 client；这里只实现 transport 接口（凭证注入与错误归一）。 */
export function createThctlTransport(options: ThctlTransportOptions): ControlPlaneClientTransport {
  return {
    async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      const token = options.sessionToken?.();
      if (token) headers.set("authorization", `Bearer ${token}`);
      let response: Response;
      try {
        response = await options.fetchImpl(requestUrl(options.origin, path), { ...init, headers, redirect: "error" });
      } catch (error) {
        if (error instanceof ThctlError) throw error;
        throw networkError(`Could not reach ${options.origin}: ${error instanceof Error ? error.message : String(error)}`, { origin: options.origin });
      }
      const text = await response.text().catch(() => "");
      let body: unknown;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw protocolError("The Control Plane returned a non-JSON response.", { status: response.status, path });
        }
      }
      if (!response.ok) {
        const envelope = ErrorEnvelopeSchema.safeParse(body);
        if (response.status === 401) options.onUnauthorized?.();
        if (!envelope.success) {
          throw serverError(response.status, `HTTP_${response.status}`, `Control Plane request failed with HTTP ${response.status}.`, { path });
        }
        const { code, message, details, retryable } = envelope.data.error;
        throw serverError(response.status, code, message, { ...details, ...(retryable === undefined ? {} : { retryable }), path });
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw protocolError("The Control Plane response does not match the expected protocol schema.", {
          path,
          issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })),
        });
      }
      return parsed.data;
    },
  };
}

export type VerifiedControlPlaneIdentity = {
  payload: ControlPlanePublicIdentityPayload;
  origin: string;
};

export async function fetchControlPlaneIdentity(origin: string, fetchImpl: typeof fetch): Promise<VerifiedControlPlaneIdentity> {
  const transport = createThctlTransport({ origin, fetchImpl });
  const client = createControlPlaneClient(transport);
  let document: z.infer<typeof ControlPlanePublicIdentityDocumentSchema>;
  try {
    document = await client.auth.identity();
  } catch (error) {
    if (error instanceof ThctlError && error.exitCode === CLI_EXIT_CODES.notFound) {
      throw new ThctlError(
        "CLI_IDENTITY_UNAVAILABLE",
        `${origin} did not return a Control Plane identity document. Check the address and that the Control Plane is running.`,
        CLI_EXIT_CODES.identity,
      );
    }
    throw error;
  }
  return { payload: verifyControlPlaneIdentityPayload(document), origin };
}

export function assertProfileIdentity(profile: CliProfile, identity: VerifiedControlPlaneIdentity) {
  const { payload } = identity;
  if (profile.origin !== identity.origin) {
    throw new ThctlError("CLI_PROFILE_ORIGIN_CHANGED", `Profile \`${profile.label}\` points at ${profile.origin}, not ${identity.origin}.`, CLI_EXIT_CODES.identity);
  }
  if (profile.controlPlaneId !== payload.controlPlaneId || profile.fingerprint !== payload.publicKey.fingerprint) {
    throw new ThctlError(
      "CLI_IDENTITY_CHANGED",
      `The Control Plane identity for \`${profile.label}\` changed. Run \`thctl profile trust ${profile.label} --yes\` after verifying the new fingerprint ${payload.publicKey.fingerprint}.`,
      CLI_EXIT_CODES.identity,
      {
        profile: profile.label,
        expectedControlPlaneId: profile.controlPlaneId,
        expectedFingerprint: profile.fingerprint,
        actualControlPlaneId: payload.controlPlaneId,
        actualFingerprint: payload.publicKey.fingerprint,
      },
    );
  }
}

export function assertCliCapability(profile: CliProfile, identity: VerifiedControlPlaneIdentity) {
  if (!supportsControlPlaneCliSessions(identity.payload.capabilities)) {
    throw new ThctlError(
      "CLI_CAPABILITY_MISSING",
      `The Control Plane at ${profile.origin} does not declare the \`cliSessions\` capability. Upgrade it to the release that ships the Control Plane CLI endpoints.`,
      CLI_EXIT_CODES.capability,
      { profile: profile.label, origin: profile.origin, protocolVersion: identity.payload.protocolVersion },
    );
  }
}

export type ThctlConnection = {
  profile: CliProfile;
  identity: VerifiedControlPlaneIdentity;
  client: ControlPlaneClient;
  store: CliProfileStore;
};

export async function connectToControlPlane(options: {
  store: CliProfileStore;
  profile: CliProfile;
  fetchImpl: typeof fetch;
  withSession?: boolean;
}) {
  const { store, profile, fetchImpl } = options;
  const identity = await fetchControlPlaneIdentity(profile.origin, fetchImpl);
  assertProfileIdentity(profile, identity);
  assertCliCapability(profile, identity);
  const secrets = store.secrets();
  const credential = options.withSession === false ? undefined : secrets.read(profile.label);
  if (options.withSession !== false && !credential) {
    throw new ThctlError(
      "CLI_NOT_AUTHENTICATED",
      `No CLI session stored for \`${profile.label}\`. Run \`thctl login\`.`,
      CLI_EXIT_CODES.notAuthenticated,
      { profile: profile.label },
    );
  }
  const transport = createThctlTransport({
    origin: profile.origin,
    fetchImpl,
    sessionToken: credential ? () => secrets.read(profile.label)?.sessionToken : undefined,
    onUnauthorized: credential ? () => secrets.remove(profile.label) : undefined,
  });
  const refreshed = refreshProfileSnapshot(profile, identity);
  const client = createControlPlaneClient(transport);
  return { profile: refreshed, identity, client, store } satisfies ThctlConnection;
}

/** 身份快照只在协议版本或 capability 变化时写回，避免每条命令都改配置。 */
export function refreshProfileSnapshot(profile: CliProfile, identity: VerifiedControlPlaneIdentity) {
  const protocolVersion = identity.payload.protocolVersion;
  const capabilities = identity.payload.capabilities;
  const changed = profile.protocolVersion !== protocolVersion
    || JSON.stringify(profile.capabilities ?? null) !== JSON.stringify(capabilities ?? null);
  if (!changed) return profile;
  const now = new Date().toISOString();
  return {
    ...profile,
    protocolVersion,
    capabilities,
    lastUsedAt: now,
    updatedAt: now,
  };
}
