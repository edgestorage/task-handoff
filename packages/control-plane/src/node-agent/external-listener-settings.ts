import { z } from "zod";
import {
  NodeAgentExternalListenerConfigSchema,
  type NodeAgentExternalListenerConfig,
} from "@task-handoff/protocol/control-plane";
import { JsonFile } from "../shared/persistence/store.ts";
import type { NodeAgentStorePaths } from "./persistence/paths.ts";

const NodeAgentRuntimeSettingsSchema = z.object({
  version: z.literal(1),
  externalListener: NodeAgentExternalListenerConfigSchema,
}).strict();

export type NodeAgentRuntimeSettings = z.infer<typeof NodeAgentRuntimeSettingsSchema>;

export function externalListenerHost(bindScope: NodeAgentExternalListenerConfig["bindScope"]) {
  return bindScope === "all-ipv4" ? "0.0.0.0" as const : "127.0.0.1" as const;
}

export function bootstrapExternalListener(host: string, port: number): NodeAgentExternalListenerConfig {
  return NodeAgentExternalListenerConfigSchema.parse({
    bindScope: host.trim() === "0.0.0.0" ? "all-ipv4" : "loopback",
    port,
  });
}

function sanitizeStoredSettings(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const listener = source.externalListener && typeof source.externalListener === "object" && !Array.isArray(source.externalListener)
    ? source.externalListener as Record<string, unknown>
    : {};
  const unknownTopLevel = Object.keys(source).filter((key) => key !== "version" && key !== "externalListener");
  const unknownListener = Object.keys(listener).filter((key) => key !== "bindScope" && key !== "port");
  if (unknownTopLevel.length || unknownListener.length) {
    console.warn(JSON.stringify({
      message: "unknown stored node agent runtime setting fields were ignored",
      filePath: "runtime-settings.json",
      fields: [...unknownTopLevel, ...unknownListener.map((key) => `externalListener.${key}`)],
    }));
  }
  return {
    version: source.version,
    externalListener: {
      bindScope: listener.bindScope,
      port: listener.port,
    },
  };
}

export function createRuntimeSettingsFile(
  paths: NodeAgentStorePaths,
  defaults: NodeAgentExternalListenerConfig,
) {
  return new JsonFile<NodeAgentRuntimeSettings>(paths.settingsPath, () => ({ version: 1, externalListener: defaults }), {
    schema: NodeAgentRuntimeSettingsSchema,
    sanitize: sanitizeStoredSettings,
  });
}
