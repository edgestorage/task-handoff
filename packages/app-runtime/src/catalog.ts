import { z } from "zod";
import { DomainStore } from "@task-handoff/core/storage/domain-store";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import type { AppCatalogItem } from "./types";
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
  kind: z.enum(["tty", "gui"]),
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
    })
    .optional(),
  defaultDisplayTarget: z
    .object({
      mode: z.enum(["isolated", "shared"]),
      id: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
      autoCreate: z.boolean().optional(),
    })
    .optional(),
  automation: z
    .object({
      type: z.literal("cdp"),
      portArg: z.string().optional(),
      endpointPath: z.string().optional(),
    })
    .optional(),
});

const CustomCatalogSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  items: z.array(AppCatalogItemSchema).default([]),
}).superRefine((catalog, context) => {
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

const CORE_BUILTIN_APP_CATALOG: AppCatalogItem[] = [
  {
    id: "terminal-tty",
    name: "Terminal",
    kind: "tty",
    description: "Interactive shell in the task workspace.",
    command: process.env.SHELL || "/bin/bash",
  },
  {
    id: "codex",
    name: "Codex",
    kind: "tty",
    description: "OpenAI Codex CLI in the task workspace.",
    command: process.env.TASK_HANDOFF_CODEX_COMMAND || "codex",
  },
  {
    id: "claude",
    name: "Claude",
    kind: "tty",
    description: "Claude Code CLI in the task workspace.",
    command: process.env.TASK_HANDOFF_CLAUDE_COMMAND || "claude",
  },
  {
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
  },
  {
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
  },
  {
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
  },
];

function optionalBuiltinAppCatalog(): AppCatalogItem[] {
  return [
    {
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
    },
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
  return [
    ...CORE_BUILTIN_APP_CATALOG.map(withRuntimeEnvArgs),
    ...(options.includeOptional || envFlag("TASK_HANDOFF_ENABLE_CC_SWITCH") ? optionalBuiltinAppCatalog().map(withRuntimeEnvArgs) : []),
  ];
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

  constructor(paths: TaskHandoffStoragePaths) {
    this.customStore = new DomainStore<CustomCatalog>(path.join(paths.appCatalogDir, "custom.json"), {
      schema: CustomCatalogSchema,
      defaultValue: () => ({ schemaVersion: 1, items: [] }),
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
      return {
        data: undefined,
        error: {
          code: "APP_CATALOG_INVALID",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  saveCustom(value: unknown) {
    this.customStore.save(CustomCatalogSchema.parse(value));
    return this.customStore.load();
  }

  customPath() {
    return this.customStore.path();
  }
}
