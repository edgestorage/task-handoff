/**
 * Runtime capability 默认值的唯一真源（openspec change refactor-runtime-adapter-registry，D4）。
 *
 * 归一化 MUST 与重构前逐字段一致：`local` 追加既有默认集合；docker 与未知类型不新增字段
 * （今天的 docker runtime capability 只有 adapter `check()` 注入的子域）。消费侧 MUST 以
 * capability query 为唯一权威，未声明的能力一律 fail closed 为不支持。
 */

export const LOCAL_RUNTIME_CAPABILITY_DEFAULTS = {
  requiresImage: false,
  supportsControlledInstanceApi: true,
  supportsContainerLifecycle: false,
  supportsAppSessions: true,
  supportsHostSessions: true,
  artifactKind: "none",
  isolation: "none",
} as const;

/** 按 runtime 类型返回需要追加的 capability 默认值；不存在的类型返回空（不新增字段）。 */
export function runtimeCapabilityDefaults(type: string): Record<string, unknown> {
  if (type === "local") return { ...LOCAL_RUNTIME_CAPABILITY_DEFAULTS };
  return {};
}

/** 按类型归一化 capability：类型默认值覆盖已存储值（与重构前的 local 行为一致）。 */
export function normalizeRuntimeCapabilities(type: string, capabilities: Record<string, unknown> = {}) {
  return { ...capabilities, ...runtimeCapabilityDefaults(type) };
}

type RuntimeCapabilitySource = { type: string; capabilities: Record<string, unknown> };

export function runtimeRequiresImage(runtime: RuntimeCapabilitySource) {
  if (typeof runtime.capabilities.requiresImage === "boolean") return runtime.capabilities.requiresImage;
  return runtime.type !== "local";
}

export function runtimeUsesManagedArtifacts(runtime: RuntimeCapabilitySource) {
  return runtime.capabilities.artifactKind !== "none";
}
