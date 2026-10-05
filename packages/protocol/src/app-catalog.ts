import { z } from "zod";
import { parseResponse } from "./response-validation.ts";

export const APP_CATALOG_MAX_ITEMS = 256;

const AppCatalogIdSchema = z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/);
// 与实例侧 custom.json 校验保持一致：command 是单个可执行名或路径，避免 shell 注入面。
const AppCatalogCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/\s/.test(value) && !/[;&|<>`$]/.test(value), "Command must be a single executable path or name.");

/** 自定义 App 的完整可编辑定义；读写在 CP 与实例之间原样往返。 */
export const AppCatalogItemSchema = z
  .object({
    id: AppCatalogIdSchema,
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["tty", "gui", "web"]),
    description: z.string().max(500).optional(),
    command: AppCatalogCommandSchema,
    args: z.array(z.string().max(1024)).max(64).optional(),
    cwd: z.string().max(512).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).optional(),
    display: z
      .object({
        width: z.number().int().min(320).max(7680).optional(),
        height: z.number().int().min(240).max(4320).optional(),
        depth: z.union([z.literal(16), z.literal(24), z.literal(32)]).optional(),
      })
      .strict()
      .optional(),
    defaultDisplayTarget: z
      .object({
        mode: z.enum(["isolated", "shared"]),
        id: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
        autoCreate: z.boolean().optional(),
      })
      .strict()
      .optional(),
    automation: z
      .object({
        type: z.literal("cdp"),
        portArg: z.string().optional(),
        endpointPath: z.string().optional(),
      })
      .strict()
      .optional(),
    web: z
      .object({
        portArg: z.string().optional(),
        readyPath: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** 实例目录里的完整定义，只用于 CP 侧消费后投影。 */
export const InstanceAppCatalogItemsSchema = z.array(AppCatalogItemSchema).max(APP_CATALOG_MAX_ITEMS);

/** 公开读取模型：调用方选择或安装 App 所需的最小字段。 */
export const InstanceAppCatalogEntrySchema = z
  .object({
    id: AppCatalogIdSchema,
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["tty", "gui", "web"]),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const InstanceAppCatalogSchema = z
  .object({ items: z.array(InstanceAppCatalogEntrySchema).max(APP_CATALOG_MAX_ITEMS) })
  .strict();

export function projectInstanceAppCatalog(input: unknown): z.infer<typeof InstanceAppCatalogSchema> {
  const items = parseResponse(InstanceAppCatalogItemsSchema, input);
  return InstanceAppCatalogSchema.parse({
    items: items.map(({ id, name, kind, description }) => ({
      id,
      name,
      kind,
      ...(description ? { description } : {}),
    })),
  });
}

export const CustomAppCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(AppCatalogItemSchema).max(APP_CATALOG_MAX_ITEMS),
  })
  .strict();

export const CustomAppCatalogUpdateInputSchema = z
  .object({ items: z.array(AppCatalogItemSchema).max(APP_CATALOG_MAX_ITEMS) })
  .strict();

export type AppCatalogItem = z.infer<typeof AppCatalogItemSchema>;
export type InstanceAppCatalogEntry = z.infer<typeof InstanceAppCatalogEntrySchema>;
export type InstanceAppCatalog = z.infer<typeof InstanceAppCatalogSchema>;
export type CustomAppCatalog = z.infer<typeof CustomAppCatalogSchema>;
export type CustomAppCatalogUpdateInput = z.infer<typeof CustomAppCatalogUpdateInputSchema>;
