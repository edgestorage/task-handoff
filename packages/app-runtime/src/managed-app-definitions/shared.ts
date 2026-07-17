import type { ManagedAppDefinition, ManagedAppRecipePlatform } from "../types";

export const ALL_MANAGED_PLATFORMS: ManagedAppRecipePlatform[] = [
  "linux",
  "darwin",
  "win32",
  "freebsd",
  "openbsd",
  "aix",
  "sunos",
];

export function bundledDistribution(): ManagedAppDefinition["distribution"] {
  return { recipes: [{ type: "bundled", platforms: [...ALL_MANAGED_PLATFORMS] }] };
}

export function launcherDetection(): ManagedAppDefinition["detection"] {
  return [{ type: "launcher-executable", versionArgs: ["--version"] }];
}

export function envFlag(env: NodeJS.ProcessEnv, name: string, fallback = false) {
  const raw = env[name];
  return raw === undefined || raw === "" ? fallback : ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function modelArgs(env: NodeJS.ProcessEnv, ...names: string[]) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return ["--model", value];
  }
  return [];
}
