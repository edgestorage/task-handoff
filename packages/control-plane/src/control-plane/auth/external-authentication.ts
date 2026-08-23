import crypto from "node:crypto";
import { z } from "zod";
import { nowIso as now } from "@task-handoff/core/core/time";
import { createId } from "../../shared/persistence/store.ts";
import { externalIdentityProviderAdapter } from "./external-identity-providers.ts";
import type { ControlPlaneIdentityProviderService } from "./identity-provider-service.ts";
import { OidcDiscoverySchema, verifyOidcIdToken } from "./oidc.ts";
import type { ControlPlaneUserAuthentication } from "./user-authentication.ts";
import type { ControlPlaneUserService } from "./user-service.ts";
import type { IdentityProviderRecord } from "./user-records.ts";

const FLOW_TTL_MS = 10 * 60 * 1000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

type ExternalLoginFlow = {
  providerId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
  clientType: "web" | "mobile";
};

function randomValue(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function form(input: Record<string, string>) {
  return new URLSearchParams(input).toString();
}

export class ControlPlaneExternalAuthentication {
  private readonly flows = new Map<string, ExternalLoginFlow>();
  private readonly fetchImplementation: typeof fetch;
  private readonly users: ControlPlaneUserService;
  private readonly sessions: ControlPlaneUserAuthentication;
  private readonly providers: ControlPlaneIdentityProviderService;

  constructor(
    users: ControlPlaneUserService,
    sessions: ControlPlaneUserAuthentication,
    providers: ControlPlaneIdentityProviderService,
    options: { fetch?: typeof fetch } = {},
  ) {
    this.users = users;
    this.sessions = sessions;
    this.providers = providers;
    this.fetchImplementation = options.fetch || fetch;
  }

  async begin(providerId: string, clientType: "web" | "mobile" = "web") {
    this.pruneFlows();
    const provider = await this.users.store.providers.get(providerId);
    if (!provider || provider.status !== "enabled") throw Object.assign(new Error("Identity provider is unavailable."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_UNAVAILABLE", statusCode: 404 });
    const flow: ExternalLoginFlow = {
      providerId,
      state: randomValue(),
      nonce: randomValue(),
      codeVerifier: randomValue(48),
      expiresAt: Date.now() + FLOW_TTL_MS,
      clientType,
    };
    this.flows.set(flow.state, flow);
    const authorizationUrl = provider.kind === "oidc"
      ? await this.oidcAuthorizationUrl(provider, flow)
      : this.githubAuthorizationUrl(provider, flow);
    return { authorizationUrl, expiresAt: new Date(flow.expiresAt).toISOString() };
  }

  async callback(input: { state: string; code: string }) {
    const parsed = z.object({ state: z.string().trim().min(32), code: z.string().trim().min(1) }).strict().parse(input);
    const flow = this.flows.get(parsed.state);
    this.flows.delete(parsed.state);
    if (!flow || flow.expiresAt <= Date.now()) throw Object.assign(new Error("External login callback is invalid or expired."), { code: "AUTH_EXTERNAL_FLOW_INVALID", statusCode: 401 });
    const provider = await this.users.store.providers.get(flow.providerId);
    if (!provider || provider.status !== "enabled") throw Object.assign(new Error("Identity provider is unavailable."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_UNAVAILABLE", statusCode: 401 });
    const claims = provider.kind === "oidc"
      ? await this.exchangeOidc(provider, flow, parsed.code)
      : await this.exchangeGitHub(provider, flow, parsed.code);
    const identity = await this.users.store.identities.findByProviderSubject(provider.id, claims.subject);
    if (identity) return { kind: "session" as const, ...await this.sessions.createSessionForIdentity(identity.id, flow.clientType) };
    if (provider.loginPolicy === "existing-only") {
      throw Object.assign(new Error("External identity is not bound to a Control Plane user."), { code: "AUTH_EXTERNAL_IDENTITY_NOT_BOUND", statusCode: 403 });
    }
    const existing = await this.users.store.approvals.findActivePending(provider.id, claims.subject, now());
    if (existing) return { kind: "pending-approval" as const, approvalId: existing.id, expiresAt: existing.expiresAt };
    const timestamp = now();
    const approval = await this.users.store.approvals.put({
      id: createId("identity_approval"),
      providerId: provider.id,
      subject: claims.subject,
      verifiedEmail: claims.verifiedEmail,
      displayName: claims.displayName,
      status: "pending",
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { kind: "pending-approval" as const, approvalId: approval.id, expiresAt: approval.expiresAt };
  }

  private async oidcAuthorizationUrl(provider: IdentityProviderRecord, flow: ExternalLoginFlow) {
    const discovery = await this.discovery(provider.issuer!);
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: provider.clientId,
      redirect_uri: provider.callbackUrl,
      scope: "openid profile email",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: pkceChallenge(flow.codeVerifier),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  private githubAuthorizationUrl(provider: IdentityProviderRecord, flow: ExternalLoginFlow) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: provider.callbackUrl,
      scope: "read:user user:email",
      state: flow.state,
      code_challenge: pkceChallenge(flow.codeVerifier),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  private async exchangeOidc(provider: IdentityProviderRecord, flow: ExternalLoginFlow, code: string) {
    const discovery = await this.discovery(provider.issuer!);
    const response = await this.fetchImplementation(discovery.token_endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: provider.callbackUrl,
        client_id: provider.clientId,
        client_secret: await this.providers.clientSecret(provider.id),
        code_verifier: flow.codeVerifier,
      }),
    });
    if (!response.ok) throw Object.assign(new Error("OIDC token exchange failed."), { code: "AUTH_EXTERNAL_TOKEN_EXCHANGE_FAILED", statusCode: 401 });
    const tokens = z.object({ id_token: z.string().trim().min(1) }).passthrough().parse(await response.json());
    const jwksResponse = await this.fetchImplementation(discovery.jwks_uri, { headers: { accept: "application/json" } });
    if (!jwksResponse.ok) throw Object.assign(new Error("OIDC signing keys are unavailable."), { code: "AUTH_EXTERNAL_KEYS_UNAVAILABLE", statusCode: 401 });
    const claims = verifyOidcIdToken({
      token: tokens.id_token,
      jwks: await jwksResponse.json(),
      issuer: provider.issuer!,
      clientId: provider.clientId,
      nonce: flow.nonce,
    });
    return externalIdentityProviderAdapter("oidc").normalizeClaims(claims);
  }

  private async exchangeGitHub(provider: IdentityProviderRecord, flow: ExternalLoginFlow, code: string) {
    const tokenResponse = await this.fetchImplementation("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: provider.clientId,
        client_secret: await this.providers.clientSecret(provider.id),
        code,
        redirect_uri: provider.callbackUrl,
        code_verifier: flow.codeVerifier,
      }),
    });
    if (!tokenResponse.ok) throw Object.assign(new Error("GitHub token exchange failed."), { code: "AUTH_EXTERNAL_TOKEN_EXCHANGE_FAILED", statusCode: 401 });
    const { access_token: accessToken } = z.object({ access_token: z.string().trim().min(1) }).passthrough().parse(await tokenResponse.json());
    const userResponse = await this.fetchImplementation("https://api.github.com/user", { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}` } });
    if (!userResponse.ok) throw Object.assign(new Error("GitHub identity lookup failed."), { code: "AUTH_EXTERNAL_IDENTITY_LOOKUP_FAILED", statusCode: 401 });
    const user = await userResponse.json() as Record<string, unknown>;
    const emailResponse = await this.fetchImplementation("https://api.github.com/user/emails", { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}` } });
    if (emailResponse.ok) {
      const emails = z.array(z.object({ email: z.string().email(), primary: z.boolean(), verified: z.boolean() }).passthrough()).safeParse(await emailResponse.json());
      const verified = emails.success ? emails.data.find((entry) => entry.primary && entry.verified) : undefined;
      if (verified) user.email = verified.email;
    }
    return externalIdentityProviderAdapter("github").normalizeClaims(user);
  }

  private async discovery(issuer: string) {
    const normalized = issuer.replace(/\/$/, "");
    const response = await this.fetchImplementation(`${normalized}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
    if (!response.ok) throw Object.assign(new Error("OIDC discovery failed."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_UNAVAILABLE", statusCode: 401 });
    const discovery = OidcDiscoverySchema.parse(await response.json());
    if (discovery.issuer.replace(/\/$/, "") !== normalized) throw Object.assign(new Error("OIDC issuer mismatch."), { code: "AUTH_EXTERNAL_ISSUER_MISMATCH", statusCode: 401 });
    return discovery;
  }

  private pruneFlows() {
    const timestamp = Date.now();
    for (const [state, flow] of this.flows) if (flow.expiresAt <= timestamp) this.flows.delete(state);
  }
}
