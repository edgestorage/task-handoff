import { z } from "zod";

const PrivateModelProtocolSchema = z.enum([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
]);

export const InstancePrivateModelCatalogSchema = z.object({
  protocolVersion: z.literal("2026-08-27"),
  instanceId: z.string().trim().min(1).max(120),
  entities: z.array(z.object({
    id: z.string().trim().min(1).max(120),
    endpoint: z.string().trim().min(1).max(2048),
    key: z.string().trim().min(1).max(4096),
    protocols: z.array(PrivateModelProtocolSchema).min(1).max(3),
    modelNames: z.array(z.object({
      name: z.string().trim().min(1).max(240),
      order: z.number().int().min(0).max(1_000_000),
    }).strip()).min(1).max(256),
  }).strip()).max(64),
  updatedAt: z.string().datetime(),
}).strip();

export type InstancePrivateModelCatalog = z.infer<typeof InstancePrivateModelCatalogSchema>;

export function sanitizeInstancePrivateModelCatalog(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return {
    protocolVersion: source.protocolVersion,
    instanceId: source.instanceId,
    entities: Array.isArray(source.entities) ? source.entities.map((entity) => {
      if (!entity || typeof entity !== "object" || Array.isArray(entity)) return entity;
      const item = entity as Record<string, unknown>;
      return {
        id: item.id,
        endpoint: item.endpoint,
        key: item.key,
        protocols: item.protocols,
        modelNames: Array.isArray(item.modelNames) ? item.modelNames.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
          const name = entry as Record<string, unknown>;
          return { name: name.name, order: name.order };
        }) : item.modelNames,
      };
    }) : source.entities,
    updatedAt: source.updatedAt,
  };
}

export function parseInstancePrivateModelCatalog(input: unknown) {
  return InstancePrivateModelCatalogSchema.parse(sanitizeInstancePrivateModelCatalog(input));
}
