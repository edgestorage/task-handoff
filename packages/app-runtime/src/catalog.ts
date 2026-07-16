import { z } from "zod";
import { DomainStore } from "@task-handoff/core/storage/domain-store";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import type { InstanceAppInventory, InstanceAppInventoryItem } from "@task-handoff/protocol/control-plane";
import { detectManagedApp } from "./managed-apps";
import type { AppCatalogItem, InstallRecipe, ManagedAppDefinition } from "./types";
import fs from "node:fs";
import path from "node:path";

function envFlag(name: string, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function modelArgs(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return ["--model", value];
    }
  }
  return [];
}

function claudePermissionArgs() {
  return envFlag("TASK_HANDOFF_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS") || envFlag("TASK_HANDOFF_CLAUDE_SKIP_PERMISSIONS")
    ? ["--dangerously-skip-permissions"]
    : [];
}

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

const CustomCatalogSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  items: z.array(AppCatalogItemSchema).default([]),
}).strict().superRefine((catalog, context) => {
  const builtinIds = new Set(builtinAppCatalog({ includeOptional: true }).map((app) => app.id));
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

export type CustomCatalog = z.infer<typeof CustomCatalogSchema>;

const CWD_SELECTABLE_APP_IDS = new Set(["terminal-tty", "codex", "claude"]);
const ALL_MANAGED_PLATFORMS = ["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos"] as const;

function managedApp(launcher: AppCatalogItem, recipes: InstallRecipe[] = [{ type: "bundled", platforms: [...ALL_MANAGED_PLATFORMS] }]): ManagedAppDefinition {
  return {
    launcher,
    detection: [{ type: "launcher-executable", versionArgs: ["--version"] }],
    distribution: { recipes },
  };
}

const CORE_BUILTIN_MANAGED_APPS: ManagedAppDefinition[] = [
  managedApp({
    id: "terminal-tty",
    name: "Terminal",
    kind: "tty",
    description: "Interactive shell in the task workspace.",
    command: process.env.SHELL || "/bin/bash",
  }),
  managedApp({
    id: "codex",
    name: "Codex",
    kind: "tty",
    description: "OpenAI Codex CLI in the task workspace.",
    command: process.env.TASK_HANDOFF_CODEX_COMMAND || "codex",
  }),
  managedApp({
    id: "claude",
    name: "Claude",
    kind: "tty",
    description: "Claude Code CLI in the task workspace.",
    command: process.env.TASK_HANDOFF_CLAUDE_COMMAND || "claude",
  }),
  managedApp({
    id: "terminal-gui",
    name: "GUI Terminal",
    kind: "gui",
    description: "xterm terminal in an isolated virtual desktop with VNC access.",
    command: process.env.TASK_HANDOFF_XTERM_COMMAND || "xterm",
    args: ["-geometry", "120x32"],
    display: {
      width: 1024,
      height: 768,
      depth: 24,
    },
  }, [{ type: "system-package", platforms: ["linux"], installer: "apt", packages: ["xterm"], privilege: "passwordless-sudo" }]),
  managedApp({
    id: "chromium",
    name: "Browser",
    kind: "gui",
    description: "Chromium browser with VNC and CDP endpoints.",
    command: process.env.TASK_HANDOFF_CHROMIUM_COMMAND || "chromium",
    args: ["about:blank"],
    display: {
      width: 1440,
      height: 900,
      depth: 24,
    },
    automation: {
      type: "cdp",
      portArg: "--remote-debugging-port={port}",
    },
  }, [{ type: "system-package", platforms: ["linux"], installer: "apt", packages: ["chromium", "chromium-sandbox"], privilege: "passwordless-sudo" }]),
  managedApp({
    id: "vscode-web",
    name: "VS Code",
    kind: "web",
    description: "VS Code Web in the task workspace.",
    command: process.env.TASK_HANDOFF_VSCODE_WEB_COMMAND || "code-server",
    args: [
      "--auth",
      "none",
      "--bind-addr",
      "127.0.0.1:{port}",
      "--disable-telemetry",
      "--user-data-dir",
      "{sessionDir}/user-data",
      "--extensions-dir",
      "{sessionDir}/extensions",
      "{cwd}",
    ],
    web: {
      readyPath: "/",
    },
  }),
];

function optionalBuiltinManagedApps(): ManagedAppDefinition[] {
  return [
    managedApp({
      id: "cc-switch",
      name: "CC Switch",
      kind: "gui",
      description: "CC Switch desktop app in an isolated virtual desktop.",
      command: process.env.TASK_HANDOFF_CC_SWITCH_COMMAND || "cc-switch",
      display: {
        width: 1440,
        height: 900,
        depth: 24,
      },
    }),
  ];
}

function withRuntimeEnvArgs(app: AppCatalogItem): AppCatalogItem {
  if (app.id === "codex") {
    return { ...app, command: process.env.TASK_HANDOFF_CODEX_COMMAND || app.command, args: modelArgs("TASK_HANDOFF_CODEX_MODEL", "CODEX_MODEL") };
  }
  if (app.id === "claude") {
    return { ...app, command: process.env.TASK_HANDOFF_CLAUDE_COMMAND || app.command, args: [...claudePermissionArgs(), ...modelArgs("TASK_HANDOFF_CLAUDE_MODEL", "CLAUDE_MODEL")] };
  }
  if (app.id === "terminal-tty") {
    return { ...app, command: process.env.SHELL || app.command };
  }
  if (app.id === "terminal-gui") {
    return { ...app, command: process.env.TASK_HANDOFF_XTERM_COMMAND || app.command };
  }
  if (app.id === "chromium") {
    return { ...app, command: process.env.TASK_HANDOFF_CHROMIUM_COMMAND || app.command };
  }
  if (app.id === "vscode-web") {
    return { ...app, command: process.env.TASK_HANDOFF_VSCODE_WEB_COMMAND || app.command };
  }
  return app;
}

export function builtinAppCatalog(options: { includeOptional?: boolean } = {}) {
  return builtinManagedAppDefinitions(options).map((definition) => definition.launcher);
}

export function builtinManagedAppDefinitions(options: { includeOptional?: boolean } = {}) {
  return [
    ...CORE_BUILTIN_MANAGED_APPS,
    ...(options.includeOptional || envFlag("TASK_HANDOFF_ENABLE_CC_SWITCH") ? optionalBuiltinManagedApps() : []),
  ].map((definition) => ({
    ...definition,
    launcher: withRuntimeEnvArgs(definition.launcher),
    detection: definition.detection.map((rule) => ({ ...rule, versionArgs: rule.versionArgs ? [...rule.versionArgs] : undefined })),
    distribution: { recipes: definition.distribution.recipes.map((recipe) => ({ ...recipe })) },
  }));
}

export function detectBuiltinManagedApps(options: { includeOptional?: boolean } = {}) {
  return builtinManagedAppDefinitions(options).map((definition) => ({
    definition,
    detection: detectManagedApp(definition),
  }));
}

export function builtinManagedAppDefinition(appId: string, options: { includeOptional?: boolean } = {}) {
  return builtinManagedAppDefinitions(options).find((definition) => definition.launcher.id === appId);
}

export function publicManagedAppDefinitions(options: { includeOptional?: boolean } = {}) {
  return builtinManagedAppDefinitions(options).map((definition) => ({
    id: definition.launcher.id,
    name: definition.launcher.name,
    kind: definition.launcher.kind,
    description: definition.launcher.description,
    recipeTypes: [...new Set(definition.distribution.recipes.map((recipe) => recipe.type))],
  }));
}

export const BUILTIN_APP_CATALOG: AppCatalogItem[] = builtinAppCatalog({ includeOptional: true });

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
  private inventoryCache?: { fingerprint: string; items: InstanceAppInventoryItem[] };

  constructor(paths: TaskHandoffStoragePaths) {
    this.customStore = new DomainStore<CustomCatalog>(path.join(paths.appCatalogDir, "custom.json"), {
      schema: CustomCatalogSchema,
      defaultValue: () => ({ schemaVersion: 1, items: [] }),
      sanitize: sanitizeCustomCatalog,
    });
  }

  list() {
    const merged = new Map<string, AppCatalogItem>();
    for (const app of builtinAppCatalog()) {
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
    const builtin = builtinAppCatalog().map((app) => ({ app, source: "builtin" as const }));
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
            supportsCwdSelection: CWD_SELECTABLE_APP_IDS.has(app.id),
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
      const recovered = recoverCustomCatalog(this.customStore.path());
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
    this.customStore.save(CustomCatalogSchema.parse(value));
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

function recoverCustomCatalog(filePath: string): CustomCatalog | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (!Array.isArray(source.items)) return undefined;
    const builtinIds = new Set(builtinAppCatalog({ includeOptional: true }).map((app) => app.id));
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
