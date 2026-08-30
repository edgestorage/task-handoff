import { z } from "zod";
import { ControlPlaneIdentityProviderSummarySchema } from "@task-handoff/protocol/control-plane-access";
import { nowIso as now } from "@task-handoff/core/core/time";
import { createId } from "../../shared/persistence/store.ts";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import type { ControlPlaneUserRepository } from "./database/repository.ts";
import { externalIdentityProviderAdapter } from "./external-identity-providers.ts";
import { ControlPlaneSecretBox } from "./secret-box.ts";
import type { ControlPlaneUserService } from "./user-service.ts";
import type { IdentityProviderRecord } from "./user-records.ts";

const ProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["oidc", "github"]),
  status: z.enum(["enabled", "disabled"]).optional(),
  loginPolicy: z.enum(["existing-only", "admin-approved-create"]).optional(),
  issuer: z.string().url().optional(),
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().min(1).max(10_000),
  callbackUrl: z.string().url(),
}).strict().superRefine((provider, context) => {
  if (provider.kind === "oidc" && !provider.issuer) context.addIssue({ code: "custom", path: ["issuer"], message: "OIDC provider requires issuer." });
});

const ProviderUpdateInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(["oidc", "github"]).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
  loginPolicy: z.enum(["existing-only", "admin-approved-create"]).optional(),
  issuer: z.string().url().optional(),
  clientId: z.string().trim().min(1).max(500).optional(),
  clientSecret: z.string().min(1).max(10_000).optional(),
  callbackUrl: z.string().url().optional(),
}).strict().refine((input) => Object.values(input).some((value) => value !== undefined), {
  message: "At least one provider field must be updated.",
});

function identityNamespace(kind: IdentityProviderRecord["kind"], issuer?: string) {
  if (kind === "github") return "github";
  return `oidc:${new URL(issuer!).toString().replace(/\/$/, "")}`;
}

export class ControlPlaneIdentityProviderService {
  private readonly users: ControlPlaneUserService;
  private readonly secrets: ControlPlaneSecretBox;
  private readonly fetchImplementation: typeof fetch;

  constructor(paths: ControlPlaneStorePaths, users: ControlPlaneUserService, options: { fetch?: typeof fetch } = {}) {
    this.users = users;
    this.secrets = new ControlPlaneSecretBox(paths.identityProviderEncryptionKeyPath);
    this.fetchImplementation = options.fetch || fetch;
  }

  init() {
    this.secrets.init();
  }

  async list() {
    return (await this.users.store.providers.list()).map((provider) => this.publicProvider(provider));
  }

  async create(input: unknown) {
    const parsed = ProviderInputSchema.parse(input);
    externalIdentityProviderAdapter(parsed.kind);
    await this.validateConfiguration(parsed);
    const timestamp = now();
    return this.publicProvider(await this.users.store.providers.put({
      id: createId("idp"),
      name: parsed.name,
      kind: parsed.kind,
      status: parsed.status || "disabled",
      loginPolicy: parsed.loginPolicy || "existing-only",
      issuer: parsed.issuer,
      clientId: parsed.clientId,
      clientSecretCiphertext: this.secrets.seal(parsed.clientSecret),
      callbackUrl: parsed.callbackUrl,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  async update(providerId: string, input: unknown) {
    const parsed = ProviderUpdateInputSchema.parse(input);
    const current = await this.users.store.providers.get(providerId);
    if (!current) throw Object.assign(new Error("Identity provider was not found."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_NOT_FOUND", statusCode: 404 });
    const kind = parsed.kind || current.kind;
    const issuer = parsed.issuer === undefined ? current.issuer : parsed.issuer;
    if (kind === "oidc" && !issuer) throw Object.assign(new Error("OIDC provider requires issuer."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_ISSUER_REQUIRED", statusCode: 400 });
    externalIdentityProviderAdapter(kind);
    await this.assertIdentityNamespaceChangeAllowed(current, kind, issuer, this.users.store);
    const { clientSecret, ...updates } = parsed;
    await this.validateConfiguration({
      name: updates.name || current.name,
      kind,
      status: updates.status || current.status,
      loginPolicy: updates.loginPolicy || current.loginPolicy,
      issuer,
      clientId: updates.clientId || current.clientId,
      clientSecret: clientSecret || await this.clientSecret(providerId),
      callbackUrl: updates.callbackUrl || current.callbackUrl,
    });
    return this.users.store.transaction(async (repository) => {
      const latest = await repository.providers.get(providerId);
      if (!latest) throw Object.assign(new Error("Identity provider was not found."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_NOT_FOUND", statusCode: 404 });
      const nextKind = parsed.kind || latest.kind;
      const nextIssuer = parsed.issuer === undefined ? latest.issuer : parsed.issuer;
      await this.assertIdentityNamespaceChangeAllowed(latest, nextKind, nextIssuer, repository);
      await this.users.assertProviderStatusChangeAllowed(providerId, updates.status || latest.status, repository);
      return this.publicProvider(await repository.providers.put({
        ...latest,
        ...updates,
        kind: nextKind,
        issuer: nextIssuer,
        clientSecretCiphertext: clientSecret ? this.secrets.seal(clientSecret) : latest.clientSecretCiphertext,
        updatedAt: now(),
      }));
    });
  }

  async remove(providerId: string) {
    const current = await this.users.store.providers.get(providerId);
    if (!current) return false;
    if (await this.users.store.identities.existsForProvider(providerId)) {
      throw Object.assign(new Error("Identity provider is referenced by login identities."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_IN_USE", statusCode: 409 });
    }
    return this.users.store.providers.delete(providerId);
  }

  async clientSecret(providerId: string) {
    const provider = await this.users.store.providers.get(providerId);
    if (!provider) throw Object.assign(new Error("Identity provider was not found."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_NOT_FOUND", statusCode: 404 });
    return this.secrets.open(provider.clientSecretCiphertext);
  }

  private async validateConfiguration(provider: z.infer<typeof ProviderInputSchema>) {
    if (provider.kind !== "oidc") return;
    const issuer = provider.issuer!.replace(/\/$/, "");
    const response = await this.fetchImplementation(`${issuer}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw Object.assign(new Error("OIDC discovery failed."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_UNAVAILABLE", statusCode: 400 });
    const discovery = z.object({
      issuer: z.string().url(),
      authorization_endpoint: z.string().url(),
      token_endpoint: z.string().url(),
      jwks_uri: z.string().url(),
    }).passthrough().parse(await response.json());
    if (discovery.issuer.replace(/\/$/, "") !== issuer) {
      throw Object.assign(new Error("OIDC discovery issuer does not match configured issuer."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_ISSUER_MISMATCH", statusCode: 400 });
    }
  }

  private async assertIdentityNamespaceChangeAllowed(
    current: IdentityProviderRecord,
    kind: IdentityProviderRecord["kind"],
    issuer: string | undefined,
    repository: Pick<ControlPlaneUserRepository, "identities" | "approvals">,
  ) {
    if (identityNamespace(current.kind, current.issuer) === identityNamespace(kind, issuer)) return;
    const referenced = await repository.identities.existsForProvider(current.id)
      || await repository.approvals.hasActivePendingForProvider(current.id, now());
    if (!referenced) return;
    throw Object.assign(new Error("Identity provider kind and issuer cannot change while identities or pending approvals reference it."), {
      code: "CONTROL_PLANE_IDENTITY_PROVIDER_NAMESPACE_IMMUTABLE",
      statusCode: 409,
    });
  }

  private publicProvider(provider: IdentityProviderRecord) {
    return ControlPlaneIdentityProviderSummarySchema.parse({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      status: provider.status,
      loginPolicy: provider.loginPolicy,
      issuer: provider.issuer,
      clientId: provider.clientId,
      callbackUrl: provider.callbackUrl,
      clientSecretConfigured: Boolean(provider.clientSecretCiphertext),
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    });
  }
}
