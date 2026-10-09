import { z } from "zod";
import {
  NodeAgentExternalListenerConfigSchema,
  NodeAgentModelRelayConfigSchema,
  type NodeAgentExternalListenerConfig,
  type NodeAgentModelRelayUnknownModelPolicy,
} from "@task-handoff/protocol/control-plane";
import { JsonFile } from "../shared/persistence/store.ts";
import type { NodeAgentStorePaths } from "./persistence/paths.ts";

/**
 * Version 1 node-agent runtime settings. Domains are additive: older files
 * without `modelRelay` stay readable and normalize to the default-on relay
 * switch, which is why the field is optional instead of defaulted in the
 * schema. The presence of a valid boolean is what marks the switch as
 * persisted; a schema default would make a never-written setting
 * indistinguishable from an explicit `{ enabled: false }`.
 */
const NodeAgentRuntimeSettingsSchema = z.object({
  version: z.literal(1),
  externalListener: NodeAgentExternalListenerConfigSchema,
  modelRelay: NodeAgentModelRelayConfigSchema.optional(),
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
  const relay = source.modelRelay;
  const unknownTopLevel = Object.keys(source).filter((key) => key !== "version" && key !== "externalListener" && key !== "modelRelay");
  const unknownListener = Object.keys(listener).filter((key) => key !== "bindScope" && key !== "port");
  let modelRelay: { enabled: boolean; unknownModelPolicy?: NodeAgentModelRelayUnknownModelPolicy } | undefined;
  let relayWarning: string | undefined;
  if (relay !== undefined) {
    if (relay && typeof relay === "object" && !Array.isArray(relay) && typeof (relay as Record<string, unknown>).enabled === "boolean") {
      const value = relay as Record<string, unknown>;
      const unknownRelay = Object.keys(value).filter((key) => key !== "enabled" && key !== "unknownModelPolicy");
      const storedPolicy = value.unknownModelPolicy;
      const invalidPolicy = storedPolicy !== undefined && storedPolicy !== "passthrough" && storedPolicy !== "reject";
      if (unknownRelay.length) {
        console.warn(JSON.stringify({
          message: "unknown stored node agent runtime setting fields were ignored",
          filePath: "runtime-settings.json",
          fields: unknownRelay.map((key) => `modelRelay.${key}`),
        }));
      }
      if (invalidPolicy) {
        // Invalid policies fall back to the default passthrough behavior
        // instead of disabling the whole relay switch.
        console.warn(JSON.stringify({
          message: "invalid stored node agent model relay unknown model policy was normalized to passthrough",
          filePath: "runtime-settings.json",
          field: "modelRelay.unknownModelPolicy",
        }));
      }
      modelRelay = {
        enabled: value.enabled as boolean,
        ...(storedPolicy === "passthrough" || storedPolicy === "reject" ? { unknownModelPolicy: storedPolicy } : {}),
      };
    } else {
      // Missing or malformed values normalize to disabled. Dropping the field
      // (instead of writing false) keeps a malformed historical file from
      // being reported as an explicitly persisted switch.
      relayWarning = relay && typeof relay === "object" && !Array.isArray(relay) ? "enabled" : "modelRelay";
    }
  }
  if (unknownTopLevel.length || unknownListener.length) {
    console.warn(JSON.stringify({
      message: "unknown stored node agent runtime setting fields were ignored",
      filePath: "runtime-settings.json",
      fields: [...unknownTopLevel, ...unknownListener.map((key) => `externalListener.${key}`)],
    }));
  }
  if (relayWarning) {
    console.warn(JSON.stringify({
      message: "invalid stored node agent model relay setting was normalized to disabled",
      filePath: "runtime-settings.json",
      field: relayWarning === "modelRelay" ? "modelRelay" : "modelRelay.enabled",
    }));
  }
  return {
    version: source.version,
    externalListener: {
      bindScope: listener.bindScope,
      port: listener.port,
    },
    ...(modelRelay ? { modelRelay } : {}),
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
