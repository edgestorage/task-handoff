import { z } from "zod";
import {
  NodeAgentExternalListenerConfigSchema,
  NodeAgentModelRelayConfigSchema,
  NodeAgentModelRelayImagePruningSchema,
  type NodeAgentExternalListenerConfig,
  type NodeAgentModelRelayImagePruningConfig,
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
  wslRuntime: z.object({ enabled: z.boolean() }).strict().optional(),
}).strict();

export type NodeAgentRuntimeSettings = z.infer<typeof NodeAgentRuntimeSettingsSchema>;

/**
 * D14：`wsl` runtime 的发布门控。默认关闭，必须由节点级设置或环境变量显式开启；环境变量优先，
 * 便于测试机临时开启而不改写持久化配置。返回 `undefined` 表示未显式配置（按默认关闭处理）。
 */
export function parseWslRuntimeEnabledEnv(value: string | undefined): boolean | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function wslRuntimePublishEnabled(
  settings: Pick<NodeAgentRuntimeSettings, "wslRuntime">,
  env: NodeJS.ProcessEnv = process.env,
) {
  const fromEnv = parseWslRuntimeEnabledEnv(env.TASK_HANDOFF_WSL_RUNTIME_ENABLED);
  if (fromEnv !== undefined) return fromEnv;
  return settings.wslRuntime?.enabled === true;
}

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
  const wslRuntime = source.wslRuntime;
  const unknownTopLevel = Object.keys(source).filter((key) => key !== "version" && key !== "externalListener" && key !== "modelRelay" && key !== "wslRuntime");
  const unknownListener = Object.keys(listener).filter((key) => key !== "bindScope" && key !== "port");
  let modelRelay: {
    enabled: boolean;
    unknownModelPolicy?: NodeAgentModelRelayUnknownModelPolicy;
    imagePruning?: NodeAgentModelRelayImagePruningConfig;
  } | undefined;
  let relayWarning: string | undefined;
  if (relay !== undefined) {
    if (relay && typeof relay === "object" && !Array.isArray(relay) && typeof (relay as Record<string, unknown>).enabled === "boolean") {
      const value = relay as Record<string, unknown>;
      const unknownRelay = Object.keys(value).filter((key) => key !== "enabled" && key !== "unknownModelPolicy" && key !== "imagePruning");
      const storedPolicy = value.unknownModelPolicy;
      const invalidPolicy = storedPolicy !== undefined && storedPolicy !== "passthrough" && storedPolicy !== "reject";
      const parsedImagePruning = value.imagePruning === undefined
        ? undefined
        : NodeAgentModelRelayImagePruningSchema.safeParse(value.imagePruning);
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
      if (parsedImagePruning && !parsedImagePruning.success) {
        console.warn(JSON.stringify({
          message: "invalid stored node agent model relay image pruning was ignored",
          filePath: "runtime-settings.json",
          field: "modelRelay.imagePruning",
        }));
      }
      modelRelay = {
        enabled: value.enabled as boolean,
        ...(storedPolicy === "passthrough" || storedPolicy === "reject" ? { unknownModelPolicy: storedPolicy } : {}),
        ...(parsedImagePruning?.success ? { imagePruning: parsedImagePruning.data } : {}),
      };
    } else {
      // Missing or malformed values normalize to disabled. Dropping the field
      // (instead of writing false) keeps a malformed historical file from
      // being reported as an explicitly persisted switch.
      relayWarning = relay && typeof relay === "object" && !Array.isArray(relay) ? "enabled" : "modelRelay";
    }
  }
  // D14 publish gate follows the same additive pattern as modelRelay: a valid boolean marks the
  // switch as persisted, while a malformed value is dropped instead of being reported as an
  // explicit `{ enabled: false }`.
  let normalizedWslRuntime: { enabled: boolean } | undefined;
  let wslRuntimeWarning = false;
  if (wslRuntime !== undefined) {
    if (wslRuntime && typeof wslRuntime === "object" && !Array.isArray(wslRuntime) && typeof (wslRuntime as Record<string, unknown>).enabled === "boolean") {
      const value = wslRuntime as Record<string, unknown>;
      const unknownWsl = Object.keys(value).filter((key) => key !== "enabled");
      if (unknownWsl.length) {
        console.warn(JSON.stringify({
          message: "unknown stored node agent runtime setting fields were ignored",
          filePath: "runtime-settings.json",
          fields: unknownWsl.map((key) => `wslRuntime.${key}`),
        }));
      }
      normalizedWslRuntime = { enabled: value.enabled as boolean };
    } else {
      wslRuntimeWarning = true;
    }
  }
  if (unknownTopLevel.length || unknownListener.length) {
    console.warn(JSON.stringify({
      message: "unknown stored node agent runtime setting fields were ignored",
      filePath: "runtime-settings.json",
      fields: [...unknownTopLevel, ...unknownListener.map((key) => `externalListener.${key}`)],
    }));
  }
  if (wslRuntimeWarning) {
    console.warn(JSON.stringify({
      message: "invalid stored node agent wsl runtime setting was normalized to disabled",
      filePath: "runtime-settings.json",
      field: "wslRuntime.enabled",
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
    ...(normalizedWslRuntime ? { wslRuntime: normalizedWslRuntime } : {}),
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
