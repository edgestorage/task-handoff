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
import { ManagedNodeApps, managedNodePackageBin } from "./managed-node-apps";
import { resolveExecutable } from "@task-handoff/core/core/executable-resolver";

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

export function executablePath(command: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  return resolveExecutable(command, { env, cwd })?.executable;
}

type AppResolutionOptions = {
  env?: NodeJS.ProcessEnv;
  managedAppRoot?: string;
  managedAppIds?: ReadonlySet<string>;
};

type ResolvedCatalogApp = {
  app: AppCatalogItem;
  executable?: string;
};

export function resolveApp(app: AppCatalogItem, baseEnv: NodeJS.ProcessEnv = process.env, options: AppResolutionOptions = {}): ResolvedCatalogApp {
  const command = app.command?.trim();
  if (!command) return { app };
  const env = { ...baseEnv, ...app.env };
  const managedId = options.managedAppIds?.has(app.id) ? app.id : options.managedAppIds?.has(command) ? command : undefined;
  const managed = Boolean(options.managedAppRoot && managedId);
  if (managed) {
    const bin = managedNodePackageBin(options.managedAppRoot!, managedId!);
    const candidate = path.join(bin, managedId!);
    const resolution = resolveExecutable(candidate, { env, cwd: app.cwd });
    const managedEnv = {
      ...app.env,
      PATH: [bin, env.PATH].filter(Boolean).join(path.delimiter),
    };
    if (!resolution) return { app: { ...app, command: candidate, env: managedEnv } };
    return {
      app: {
        ...app,
        command: resolution.executable,
        env: { ...managedEnv, ...resolution.env },
      },
      executable: resolution.executable,
    };
  }
  const resolution = resolveExecutable(command, { env, cwd: app.cwd });
  if (!resolution) return { app };
  return {
    app: {
      ...app,
      command: resolution.executable,
      env: { ...app.env, ...resolution.env },
    },
    executable: resolution.executable,
  };
}

export function resolveAppExecutable(app: AppCatalogItem, baseEnv: NodeJS.ProcessEnv = process.env, options: AppResolutionOptions = {}): AppCatalogItem {
  return resolveApp(app, baseEnv, options).app;
}

export function isAppAvailable(app: AppCatalogItem, options: AppResolutionOptions = {}) {
  return Boolean(resolveApp(app, options.env || process.env, options).executable);
}

const APP_CATALOG_LIST_CACHE_MS = 30_000;

export class AppCatalogRepository {
  private readonly customStore: DomainStore<CustomCatalog>;
  private readonly customCatalogSchema: ReturnType<typeof customCatalogSchema>;
  private readonly managedAppIds: ReadonlySet<string>;
  readonly managedNodeApps?: ManagedNodeApps;
  private inventoryCache?: { fingerprint: string; items: InstanceAppInventoryItem[] };
  // Executable resolution probes PATH/Homebrew/npm candidates with accessSync.
  // Shared-resource ensure runs on every OpenCode request, so keep the resolved
  // catalog warm instead of re-probing every executable on each request.
  private listCache?: { expiresAt: number; items: AppCatalogItem[] };

  constructor(
    paths: TaskHandoffStoragePaths,
    private readonly registry: ManagedAppRegistry = builtinManagedAppRegistry,
    private readonly options: { managedAppRoot?: string } = {},
  ) {
    this.customCatalogSchema = customCatalogSchema(registry);
    this.customStore = new DomainStore<CustomCatalog>(path.join(paths.appCatalogDir, "custom.json"), {
      schema: this.customCatalogSchema,
      defaultValue: () => ({ schemaVersion: 1, items: [] }),
      sanitize: sanitizeCustomCatalog,
    });
    if (options.managedAppRoot) this.managedNodeApps = new ManagedNodeApps(options.managedAppRoot, registry.definitions({ includeOptional: true }));
    this.managedAppIds = new Set(registry.definitions({ includeOptional: true })
      .filter((definition) => definition.distribution.recipes.some((recipe) => recipe.type === "node-package" && recipe.managed === true))
      .map((definition) => definition.launcher.id));
  }

  private resolveCatalogApp(app: AppCatalogItem, source: "builtin" | "custom", env: NodeJS.ProcessEnv = process.env): ResolvedCatalogApp {
    return resolveApp(app, env, {
      managedAppRoot: this.options.managedAppRoot,
      managedAppIds: this.managedAppIds,
    });
  }

  private resolvedEntries(env: NodeJS.ProcessEnv = process.env) {
    const merged = new Map<string, { app: AppCatalogItem; source: "builtin" | "custom"; executable?: string }>();
    for (const { launcher: app } of this.registry.launchableDefinitions()) {
      const resolved = this.resolveCatalogApp(app, "builtin", env);
      merged.set(app.id, { ...resolved, source: "builtin" });
    }
    const custom = this.safeCustom();
    for (const app of custom.data?.items || []) {
      const resolved = this.resolveCatalogApp(app, "custom", env);
      merged.set(app.id, { ...resolved, source: "custom" });
    }
    return merged;
  }

  list() {
    const now = Date.now();
    if (this.listCache && this.listCache.expiresAt > now) return this.listCache.items;
    const items = [...this.resolvedEntries().values()].map(({ app }) => app);
    this.listCache = { expiresAt: now + APP_CATALOG_LIST_CACHE_MS, items };
    return items;
  }

  available() {
    return [...this.resolvedEntries().values()].filter(({ executable }) => Boolean(executable)).map(({ app }) => app);
  }

  inventory(observedAt = new Date().toISOString()): InstanceAppInventory {
    const custom = this.safeCustom();
    const resolved = [...this.resolvedEntries().values()];
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
            supportsProfiles: source === "builtin"
              ? this.registry.provider(app.id)?.capabilities?.supportsProfiles === true
              : this.registry.runtimeProvider(app)?.capabilities?.supportsProfiles === true,
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
    return this.resolvedEntries().get(appId)?.app;
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
    this.listCache = undefined;
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
