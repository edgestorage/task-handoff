import { z } from "zod";

const PrivateModelProtocolSchema = z.enum([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
]);

// Compatibility for v0.0.34: this released private catalog projects upstream
// endpoint, key and names directly into the instance.
export const INSTANCE_PRIVATE_MODEL_CATALOG_DIRECT_PROTOCOL_VERSION = "2026-08-27";
// Node-agent relay projection: the instance only receives external names and
// derived route base URLs; upstream secrets stay on the node.
export const INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION = "2026-10-02";

const PrivateModelNameEntrySchema = z.object({
  // Stable model identity. `name` stays the mutable display label: renaming an
  // entry must never change which model a session or client refers to.
  upstreamName: z.string().trim().min(1).max(240).optional(),
  name: z.string().trim().min(1).max(240),
  order: z.number().int().min(0).max(1_000_000),
}).strip();

const PrivateModelCatalogEntityBase = {
  id: z.string().trim().min(1).max(120),
  protocols: z.array(PrivateModelProtocolSchema).min(1).max(3),
  modelNames: z.array(PrivateModelNameEntrySchema).min(1).max(256),
};

export const InstancePrivateModelCatalogDirectSchema = z.object({
  protocolVersion: z.literal(INSTANCE_PRIVATE_MODEL_CATALOG_DIRECT_PROTOCOL_VERSION),
  instanceId: z.string().trim().min(1).max(120),
  entities: z.array(z.object({
    ...PrivateModelCatalogEntityBase,
    endpoint: z.string().trim().min(1).max(2048),
    key: z.string().trim().min(1).max(4096),
  }).strip()).max(64),
  updatedAt: z.string().datetime(),
}).strip();

export const InstancePrivateModelRelayCatalogSchema = z.object({
  protocolVersion: z.literal(INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION),
  instanceId: z.string().trim().min(1).max(120),
  entities: z.array(z.object({
    ...PrivateModelCatalogEntityBase,
    // One derived relay route per declared protocol. The instance credential
    // is already provisioned by node-agent and is never repeated here.
    routes: z.array(z.object({
      protocol: PrivateModelProtocolSchema,
      baseUrl: z.string().trim().min(1).max(2048),
    }).strip()).min(1).max(3),
  }).strip().superRefine((entity, context) => {
    const seen = new Set<string>();
    for (const [index, route] of entity.routes.entries()) {
      if (seen.has(route.protocol)) {
        context.addIssue({ code: "custom", path: ["routes", index, "protocol"], message: `Duplicate relay route for ${route.protocol}.` });
      }
      seen.add(route.protocol);
    }
  })).max(64),
  updatedAt: z.string().datetime(),
}).strip();

/**
 * Discriminated union of every private catalog version this boundary can
 * consume. Readers sanitize unknown fields first and then parse with this
 * schema; an unknown protocolVersion is a structured failure, never a silent
 * fallback to another projection.
 */
export const InstancePrivateModelCatalogSchema = z.discriminatedUnion("protocolVersion", [
  InstancePrivateModelCatalogDirectSchema,
  InstancePrivateModelRelayCatalogSchema,
]);

export type InstancePrivateModelCatalogDirect = z.infer<typeof InstancePrivateModelCatalogDirectSchema>;
export type InstancePrivateModelRelayCatalog = z.infer<typeof InstancePrivateModelRelayCatalogSchema>;
export type InstancePrivateModelCatalog = z.infer<typeof InstancePrivateModelCatalogSchema>;

export function directInstancePrivateModelCatalog(catalog: InstancePrivateModelCatalog | undefined) {
  return catalog?.protocolVersion === INSTANCE_PRIVATE_MODEL_CATALOG_DIRECT_PROTOCOL_VERSION ? catalog : undefined;
}

export type PrivateModelNameEntryLike = { name: string; upstreamName?: string };

/**
 * Stable identity of one exposed model name. `name` is a mutable display label;
 * the upstream model name is what the provider (or the node relay in front of
 * it) actually receives, so clients and sessions key on it and renaming the
 * label never changes which model is selected. Entries written before the field
 * existed fall back to the label itself.
 */
export function modelNameEntryIdentity(entry: PrivateModelNameEntryLike) {
  return entry.upstreamName?.trim() || entry.name.trim();
}

/**
 * True when `model` refers to `entry`. Both the stable identity and the display
 * label are accepted so clients configured before the identity split keep
 * working; callers that need a unique target resolve identity matches first.
 */
export function modelNameEntryMatches(entry: PrivateModelNameEntryLike, model: string) {
  return modelNameEntryIdentity(entry) === model || entry.name === model;
}

/**
 * Resolve the single entry a client-reported `model` refers to. The stable
 * identity is tried first so a renamed display label cannot shadow another
 * model. Duplicate identities describe the same upstream model, so the first
 * (order-sorted) entry wins; duplicate display labels stay ambiguous and
 * resolve to nothing.
 */
export function selectModelNameEntry<T extends PrivateModelNameEntryLike>(entries: readonly T[], model: string): T | undefined {
  const byIdentity = entries.find((entry) => modelNameEntryIdentity(entry) === model);
  if (byIdentity) return byIdentity;
  const byName = entries.filter((entry) => entry.name === model);
  return byName.length === 1 ? byName[0] : undefined;
}

export function relayInstancePrivateModelCatalog(catalog: InstancePrivateModelCatalog | undefined) {
  return catalog?.protocolVersion === INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION ? catalog : undefined;
}

/**
 * Provider base URL for one entity/protocol in either catalog version. Direct
 * catalogs expose the upstream endpoint; relay catalogs expose the node-derived
 * route, so consumers never need version-specific branching of their own.
 */
export function instancePrivateModelCatalogBaseUrl(
  catalog: InstancePrivateModelCatalog | undefined,
  entityId: string,
  protocol: z.infer<typeof PrivateModelProtocolSchema>,
) {
  const relay = relayInstancePrivateModelCatalog(catalog);
  if (relay) {
    return relay.entities.find((entity) => entity.id === entityId)?.routes.find((route) => route.protocol === protocol)?.baseUrl;
  }
  return directInstancePrivateModelCatalog(catalog)?.entities.find((entity) => entity.id === entityId)?.endpoint;
}

const PrivateModelCatalogEntitySummarySchema = z.object({
  id: z.string().trim().min(1).max(120),
  protocols: z.array(PrivateModelProtocolSchema).min(1).max(3),
  modelNames: z.array(PrivateModelNameEntrySchema).min(1).max(256),
}).strip();

export const InstancePrivateModelCatalogSummarySchema = z.object({
  protocolVersion: z.union([
    z.literal(INSTANCE_PRIVATE_MODEL_CATALOG_DIRECT_PROTOCOL_VERSION),
    z.literal(INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION),
  ]),
  instanceId: z.string().trim().min(1).max(120),
  updatedAt: z.string().datetime(),
  entities: z.array(PrivateModelCatalogEntitySummarySchema).max(64),
}).strip();

export type InstancePrivateModelCatalogSummary = z.infer<typeof InstancePrivateModelCatalogSummarySchema>;

/**
 * Catalog identity projection for cross-boundary diagnostics. Credential
 * material never leaves the runtime that owns it; comparing which models an
 * instance resolved only needs entity identities, protocols and names.
 */
export function summarizeInstancePrivateModelCatalog(catalog: InstancePrivateModelCatalog): InstancePrivateModelCatalogSummary {
  return InstancePrivateModelCatalogSummarySchema.parse({
    protocolVersion: catalog.protocolVersion,
    instanceId: catalog.instanceId,
    updatedAt: catalog.updatedAt,
    entities: catalog.entities.map((entity) => ({
      id: entity.id,
      protocols: entity.protocols,
      modelNames: entity.modelNames,
    })),
  });
}

export function sanitizeInstancePrivateModelCatalog(input: unknown, onWarning?: (warning: { field: string }) => void) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const relay = source.protocolVersion === INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION;
  return {
    protocolVersion: source.protocolVersion,
    instanceId: source.instanceId,
    entities: Array.isArray(source.entities) ? source.entities.map((entity, entityIndex) => {
      if (!entity || typeof entity !== "object" || Array.isArray(entity)) return entity;
      const item = entity as Record<string, unknown>;
      const base = {
        id: item.id,
        protocols: item.protocols,
        modelNames: Array.isArray(item.modelNames) ? item.modelNames.map((entry, entryIndex) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
          const name = entry as Record<string, unknown>;
          for (const key of Object.keys(name)) {
            if (key !== "name" && key !== "upstreamName" && key !== "order") onWarning?.({ field: `entities[${entityIndex}].modelNames[${entryIndex}].${key}` });
          }
          return {
            ...(typeof name.upstreamName === "string" ? { upstreamName: name.upstreamName } : {}),
            name: name.name,
            order: name.order,
          };
        }) : item.modelNames,
      };
      if (relay) {
        return {
          ...base,
          routes: Array.isArray(item.routes) ? item.routes.map((route, routeIndex) => {
            if (!route || typeof route !== "object" || Array.isArray(route)) return route;
            const value = route as Record<string, unknown>;
            for (const key of Object.keys(value)) {
              if (key !== "protocol" && key !== "baseUrl") onWarning?.({ field: `entities[${entityIndex}].routes[${routeIndex}].${key}` });
            }
            return { protocol: value.protocol, baseUrl: value.baseUrl };
          }) : item.routes,
        };
      }
      for (const key of Object.keys(item)) {
        if (key !== "id" && key !== "endpoint" && key !== "key" && key !== "protocols" && key !== "modelNames") {
          onWarning?.({ field: `entities[${entityIndex}].${key}` });
        }
      }
      return {
        ...base,
        endpoint: item.endpoint,
        key: item.key,
      };
    }) : source.entities,
    updatedAt: source.updatedAt,
  };
}

export function parseInstancePrivateModelCatalog(input: unknown) {
  return InstancePrivateModelCatalogSchema.parse(sanitizeInstancePrivateModelCatalog(input));
}
