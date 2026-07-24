import { z } from "zod";
import { DomainStore } from "@task-handoff/core/storage/domain-store";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import type { InstanceAppInventory, InstanceAppInventoryItem } from "@task-handoff/protocol/control-plane";
import {
  builtinAppCatalog,
  builtinManagedAppRegistry,
} from "./managed-app-definitions";
import type { ManagedAppRegistry } from "./managed-app-definitions/registry";
import type { AppCatalogItem } from "./types";
import fs from "node:fs";
import path from "node:path";

export {
  BUILTIN_APP_CATALOG,
  builtinAppCatalog,
  builtinManagedAppDefinition,
  builtinManagedAppDefinitions,
  builtinManagedAppRegistry,
  detectBuiltinManagedApps,
  publicManagedAppDefinitions,
} from "./managed-app-definitions";

const CommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/\s/.test(value) && !/[;&|<>`$]/.test(value), "Command must be a single executable path or name.");

const AppCatalogItemSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["tty", "gui", "web"]),
  description: z.string().max(500).optional(),
  command: CommandSchema,
  args: z.array(z.string().max(1024)).max(64).default([]).optional(),
  cwd: z.string().max(512).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).optional(),
  display: z
    .object({
      width: z.number().int().min(320).max(7680).optional(),
      height: z.number().int().min(240).max(4320).optional(),
      depth: z.union([z.literal(16), z.literal(24), z.literal(32)]).optional(),
    }).strict()
    .optional(),
  defaultDisplayTarget: z
    .object({
      mode: z.enum(["isolated", "shared"]),
      id: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
      autoCreate: z.boolean().optional(),
    }).strict()
    .optional(),
  automation: z
    .object({
      type: z.literal("cdp"),
      portArg: z.string().optional(),
      endpointPath: z.string().optional(),
    }).strict()
    .optional(),
  web: z
    .object({
      portArg: z.string().optional(),
      readyPath: z.string().optional(),
    })
    .strict()
    .optional(),
}).strict();

const CustomCatalogBaseSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  items: z.array(AppCatalogItemSchema).default([]),
}).strict();

function customCatalogSchema(registry: ManagedAppRegistry) {
  return CustomCatalogBaseSchema.superRefine((catalog, context) => {
    const builtinIds = new Set(registry.definitions({ includeOptional: true }).map(({ launcher }) => launcher.id));
    const seen = new Set<string>();
    for (const [index, item] of catalog.items.entries()) {
      if (builtinIds.has(item.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "id"],
          message: "Custom apps cannot override built-in app ids.",
        });
      }
      if (seen.has(item.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "id"],
          message: "Custom app ids must be unique.",
        });
      }
      seen.add(item.id);
    }
  });
}

export type CustomCatalog = z.infer<typeof CustomCatalogBaseSchema>;

function isExecutable(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function executablePath(command: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  const executableCandidate = (candidate: string) => {
    for (const extension of extensions) {
      const withExtension = process.platform === "win32" && !path.extname(candidate)
        ? `${candidate}${extension}`
        : candidate;
      if (isExecutable(withExtension)) return withExtension;
    }
    return undefined;
  };

  if (path.isAbsolute(command)) return executableCandidate(command);
  if (command.includes("/") || command.includes("\\")) {
    return executableCandidate(path.resolve(cwd, command));
  }

  for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const resolved = executableCandidate(path.join(directory, command));
    if (resolved) return resolved;
  }
  return undefined;
}

export function isAppAvailable(app: AppCatalogItem) {
  const command = app.command?.trim();
  return Boolean(command && executablePath(command, { ...process.env, ...app.env }, app.cwd));
}

export class AppCatalogRepository {
  private readonly customStore: DomainStore<CustomCatalog>;
  private readonly customCatalogSchema: ReturnType<typeof customCatalogSchema>;
  private inventoryCache?: { fingerprint: string; items: InstanceAppInventoryItem[] };

  constructor(paths: TaskHandoffStoragePaths, private readonly registry: ManagedAppRegistry = builtinManagedAppRegistry) {
    this.customCatalogSchema = customCatalogSchema(registry);
    this.customStore = new DomainStore<CustomCatalog>(path.join(paths.appCatalogDir, "custom.json"), {
      schema: this.customCatalogSchema,
      defaultValue: () => ({ schemaVersion: 1, items: [] }),
      sanitize: sanitizeCustomCatalog,
    });
  }

  list() {
    const merged = new Map<string, AppCatalogItem>();
    for (const { launcher: app } of this.registry.definitions()) {
      merged.set(app.id, app);
    }
    const custom = this.safeCustom();
    if (custom.data) {
      for (const app of custom.data.items) {
        merged.set(app.id, app);
      }
    }
    return Array.from(merged.values());
  }

  available() {
    return this.list().filter(isAppAvailable);
  }

  inventory(observedAt = new Date().toISOString()): InstanceAppInventory {
    const builtin = this.registry.definitions().map(({ launcher: app }) => ({ app, source: "builtin" as const }));
    const custom = this.safeCustom();
    const merged = new Map<string, { app: AppCatalogItem; source: "builtin" | "custom" }>();
    for (const entry of builtin) merged.set(entry.app.id, entry);
    for (const app of custom.data?.items || []) merged.set(app.id, { app, source: "custom" });

    const resolved = [...merged.values()].map(({ app, source }) => ({
      app,
      source,
      executable: app.command?.trim() ? executablePath(app.command.trim(), { ...process.env, ...app.env }, app.cwd) : undefined,
    }));
    const fingerprint = JSON.stringify(resolved.map(({ app, source, executable }) => ({
      id: app.id,
      name: app.name,
      kind: app.kind,
      source,
      executable,
      automation: app.automation?.type,
      cwd: app.cwd,
    })));
    if (!this.inventoryCache || this.inventoryCache.fingerprint !== fingerprint) {
      this.inventoryCache = {
        fingerprint,
        items: resolved.map(({ app, source, executable }): InstanceAppInventoryItem => ({
          id: app.id,
          name: app.name,
          kind: app.kind,
          source,
          availability: executable ? "available" : "missing-dependency",
          capabilities: {
            automation: app.automation?.type,
            supportsCwdSelection: source === "builtin"
              ? this.registry.provider(app.id)?.capabilities?.supportsCwdSelection === true
              : false,
          },
          diagnosticCode: executable ? undefined : "APP_EXECUTABLE_NOT_FOUND",
        })),
      };
    }
    return {
      items: this.inventoryCache.items,
      observedAt,
      issues: custom.error
        ? [{ code: "APP_CATALOG_INVALID", message: "Custom app catalog could not be read completely; valid catalog entries remain available." }]
        : [],
    };
  }

  find(appId: string) {
    return this.list().find((app) => app.id === appId);
  }

  custom() {
    return this.customStore.load();
  }

  safeCustom() {
    try {
      return { data: this.customStore.load(), error: undefined };
    } catch (error: unknown) {
      const recovered = recoverCustomCatalog(this.customStore.path(), this.registry);
      return {
        data: recovered,
        error: {
          code: "APP_CATALOG_INVALID",
          message: "Custom app catalog is invalid.",
        },
      };
    }
  }

  saveCustom(value: unknown) {
    this.customStore.save(this.customCatalogSchema.parse(value));
    this.inventoryCache = undefined;
    return this.customStore.load();
  }

  customPath() {
    return this.customStore.path();
  }
}

function sanitizeCustomCatalog(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return {
    schemaVersion: source.schemaVersion,
    items: Array.isArray(source.items) ? source.items.map(sanitizeCustomCatalogItem) : source.items,
  };
}

function sanitizeCustomCatalogItem(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return {
    ...pickFields(source, ["id", "name", "kind", "description", "command", "args", "cwd", "env"]),
    display: pickFields(source.display, ["width", "height", "depth"]),
    defaultDisplayTarget: pickFields(source.defaultDisplayTarget, ["mode", "id", "autoCreate"]),
    automation: pickFields(source.automation, ["type", "portArg", "endpointPath"]),
    web: pickFields(source.web, ["portArg", "readyPath"]),
  };
}

function recoverCustomCatalog(filePath: string, registry: ManagedAppRegistry): CustomCatalog | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (!Array.isArray(source.items)) return undefined;
    const builtinIds = new Set(registry.definitions({ includeOptional: true }).map(({ launcher }) => launcher.id));
    const seen = new Set<string>();
    const items: CustomCatalog["items"] = [];
    for (const candidate of source.items) {
      const parsed = AppCatalogItemSchema.safeParse(sanitizeCustomCatalogItem(candidate));
      if (!parsed.success || builtinIds.has(parsed.data.id) || seen.has(parsed.data.id)) continue;
      seen.add(parsed.data.id);
      items.push(parsed.data);
    }
    return { schemaVersion: 1, items };
  } catch {
    return undefined;
  }
}

function pickFields(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
}
