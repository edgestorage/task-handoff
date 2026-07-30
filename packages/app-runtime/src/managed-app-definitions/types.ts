import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import type { AppCatalogItem, AppLaunchOptions, AppSession, ManagedAppDefinition } from "../types";

export type ManagedAppProviderContext = {
  env: NodeJS.ProcessEnv;
};

export type ManagedAppProviderCapabilities = {
  supportsCwdSelection?: boolean;
  supportsAiSessionResume?: boolean;
};

export type ManagedAppRuntimeHost = {
  paths: TaskHandoffStoragePaths;
  allocatePort(kind: "vnc" | "websockify" | "web" | "cdp"): number;
  hasCommand(command: string, env?: NodeJS.ProcessEnv, cwd?: string): boolean;
  spawnLogged(command: string, args: string[], env: NodeJS.ProcessEnv, logDir: string, logName: string, cwd?: string): ChildProcessWithoutNullStreams;
  stopProcessTree(child: ChildProcessWithoutNullStreams, signal?: NodeJS.Signals): void;
  waitForUnixSocket(socketPath: string, timeoutMs: number, getError?: () => Error | undefined): void;
  patchSession(sessionId: string, patch: { ai: AppSession["ai"] }): void;
};

export type ManagedAppTtyLaunchInput = {
  app: AppCatalogItem;
  sessionId: string;
  sessionDir: string;
  logDir: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  catalogArgs: string[];
  launchArgs: string[];
  resumeArgs: string[];
};

export type ManagedAppPreparedTtyLaunch = {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  ttyMode?: NonNullable<AppSession["tty"]>["mode"];
  ai?: AppSession["ai"];
  lifecycle?: {
    processExited?(): void;
    spawnFailed?(): void;
    stop?(): void;
  };
};

export type ManagedAppGuiLaunchInput = {
  app: AppCatalogItem;
  sessionDir: string;
  automationPort: number;
  launchArgs: string[];
  defaultArgs: string[];
};

export type ManagedAppWebLaunchInput = {
  app: AppCatalogItem;
  sessionDir: string;
  cwd: string;
  port: number;
  launch: AppLaunchOptions;
};

export type ManagedAppSharedResourceInfo = {
  kind: string;
  status: "running";
  details: Record<string, unknown>;
};

export type ManagedAppSharedResource = {
  ensure(input: { app: AppCatalogItem; cwd: string; env: NodeJS.ProcessEnv }): ManagedAppSharedResourceInfo;
  acquire(command: string, cwd: string, env: NodeJS.ProcessEnv, consumerId: string): ManagedAppSharedResourceInfo;
  release(consumerId: string): void;
  info(): ManagedAppSharedResourceInfo | undefined;
  projectSessionAi?(): AppSession["ai"];
};

export type ManagedAppRuntimeExtension = {
  prepareTtyLaunch?(input: ManagedAppTtyLaunchInput): ManagedAppPreparedTtyLaunch;
  prepareGuiArgs?(input: ManagedAppGuiLaunchInput): string[];
  prepareWebSession?(input: ManagedAppWebLaunchInput): void;
  managedEnvironmentChanged?(): void;
  stopAll?(): void;
  sharedResource?: ManagedAppSharedResource;
};

export interface ManagedAppProvider {
  readonly id: string;
  readonly optional?: boolean;
  readonly capabilities?: ManagedAppProviderCapabilities;
  aiSessionResumeArgs?(providerSessionId: string): string[];
  matchesRuntime?(app: AppCatalogItem): boolean;
  createRuntime?(host: ManagedAppRuntimeHost): ManagedAppRuntimeExtension;
  enabled?(context: ManagedAppProviderContext): boolean;
  definition(context: ManagedAppProviderContext): ManagedAppDefinition;
}

export type ManagedAppRegistryOptions = {
  includeOptional?: boolean;
  env?: NodeJS.ProcessEnv;
};
