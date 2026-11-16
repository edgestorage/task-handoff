import type { FinalComputerCapabilities } from "@task-handoff/protocol/control-plane";
import { validNativePackageIntegrity } from "./native-package";
import type {
  ManagedAppRecipeArch,
  ManagedAppRecipePlatform,
  NativePackageInstallRecipe,
  RegistryNativePackageInstallRecipe,
} from "./types";

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/i;
const NPM_DIST_TAG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SUPPORTED_PLATFORMS = new Set<ManagedAppRecipePlatform>(["linux", "darwin", "win32"]);
const SUPPORTED_ARCHES = new Set<ManagedAppRecipeArch>(["x64", "arm64"]);
const DEFAULT_REGISTRIES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"];
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REGISTRY_REDIRECTS = 3;

export type RegistryNativePackageResolverOptions = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  registries?: string[];
  timeoutMs?: number;
};

function normalizedRegistry(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function registryCandidates(options: RegistryNativePackageResolverOptions) {
  const configured = [
    ...(options.registries || []),
    normalizedRegistry(options.env?.npm_config_registry),
    normalizedRegistry(options.env?.NPM_CONFIG_REGISTRY),
    ...DEFAULT_REGISTRIES,
  ];
  const result: string[] = [];
  for (const candidate of configured) {
    const normalized = normalizedRegistry(candidate);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function registryPackageUrl(registry: string, packageName: string) {
  return `${registry}/${encodeURIComponent(packageName)}`;
}

function registryMetadataPackageUrl(registry: string, packageName: string, version: string) {
  return `${registry}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}

function canonicalHttpsUrl(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function readRegistryJson(request: typeof fetch, value: string, timeoutMs: number) {
  let current = new URL(value);
  for (let redirects = 0; redirects <= MAX_REGISTRY_REDIRECTS; redirects += 1) {
    if (current.protocol !== "https:" || !current.hostname || current.username || current.password || current.search || current.hash) {
      throw new Error("npm registry redirects must use HTTPS without credentials, query strings, or fragments.");
    }
    const response = await request(current.toString(), {
      headers: {
        accept: "application/vnd.npm.install-v1+json",
        "user-agent": "task-handoff-controlled-instance",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error("npm registry redirect has no location.");
      if (redirects === MAX_REGISTRY_REDIRECTS) throw new Error("npm registry redirect limit exceeded.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error("npm returned invalid JSON.");
    }
  }
  throw new Error("npm registry redirect limit exceeded.");
}

function packageNameForTarget(recipe: RegistryNativePackageInstallRecipe, platform: ManagedAppRecipePlatform, arch: ManagedAppRecipeArch) {
  const packageName = `${recipe.packagePrefix}-${platform}-${arch}`;
  if (!NPM_PACKAGE_NAME.test(recipe.packagePrefix) || !NPM_PACKAGE_NAME.test(packageName)) {
    throw new Error("The registry native package prefix is invalid.");
  }
  return packageName;
}

function parseRegistryVersion(metadata: unknown, packageName: string, expectedVersion: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("npm returned invalid package metadata.");
  const manifest = metadata as {
    name?: unknown;
    version?: unknown;
    dist?: { integrity?: unknown; tarball?: unknown };
  };
  if (manifest.name !== packageName || manifest.version !== expectedVersion) {
    throw new Error(`npm manifest identity does not match ${packageName}@${expectedVersion}.`);
  }
  const integrity = manifest.dist?.integrity;
  if (typeof integrity !== "string" || !validNativePackageIntegrity(integrity)) {
    throw new Error(`npm manifest for ${packageName}@${expectedVersion} has no valid integrity.`);
  }
  const tarballUrl = canonicalHttpsUrl(manifest.dist?.tarball);
  if (!tarballUrl) throw new Error(`npm manifest for ${packageName}@${expectedVersion} has no canonical HTTPS tarball.`);
  return { version: expectedVersion, integrity, tarballUrl };
}

function latestVersion(metadata: unknown, packageName: string, distTag: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("npm returned invalid package metadata.");
  const value = metadata as {
    name?: unknown;
    "dist-tags"?: Record<string, unknown>;
    versions?: Record<string, unknown>;
  };
  if (value.name !== packageName) throw new Error(`npm metadata is for ${String(value.name || "an unknown package")}, expected ${packageName}.`);
  const latest = value["dist-tags"]?.[distTag];
  if (typeof latest !== "string" || !EXACT_VERSION.test(latest)) throw new Error(`npm did not provide an exact ${distTag} version for ${packageName}.`);
  if (!value.versions?.[latest]) throw new Error(`npm metadata has no manifest for ${packageName}@${latest}.`);
  return latest;
}

async function readRegistryManifest(
  request: typeof fetch,
  registry: string,
  packageName: string,
  distTag: string,
  timeoutMs: number,
) {
  const metadata = await readRegistryJson(request, registryPackageUrl(registry, packageName), timeoutMs);
  const version = latestVersion(metadata, packageName, distTag);
  // The exact endpoint is a second authority check. It also supplies the
  // immutable tarball URL so the native installer never has to invoke npm or
  // recompute a mutable registry path.
  const exactMetadata = await readRegistryJson(request, registryMetadataPackageUrl(registry, packageName, version), timeoutMs);
  const exact = parseRegistryVersion(exactMetadata, packageName, version);
  const listedManifest = (metadata as { versions?: Record<string, { dist?: { integrity?: unknown; tarball?: unknown } }> }).versions?.[version];
  if (listedManifest?.dist?.integrity && listedManifest.dist.integrity !== exact.integrity) {
    throw new Error(`npm changed ${packageName}@${version} while resolving it.`);
  }
  if (listedManifest?.dist?.tarball && canonicalHttpsUrl(listedManifest.dist.tarball) !== exact.tarballUrl) {
    throw new Error(`npm changed the ${packageName}@${version} tarball while resolving it.`);
  }
  return exact;
}

export async function resolveRegistryNativePackage(
  recipe: RegistryNativePackageInstallRecipe,
  capabilities: FinalComputerCapabilities,
  options: RegistryNativePackageResolverOptions = {},
): Promise<NativePackageInstallRecipe> {
  const platform = capabilities.platform as ManagedAppRecipePlatform;
  const arch = capabilities.arch as ManagedAppRecipeArch;
  if (!SUPPORTED_PLATFORMS.has(platform) || !SUPPORTED_ARCHES.has(arch) || !recipe.platforms.includes(platform) || (recipe.arches?.length && !recipe.arches.includes(arch))) {
    throw new Error(`Registry native package does not support ${capabilities.platform}/${capabilities.arch}.`);
  }
  const packageName = packageNameForTarget(recipe, platform, arch);
  const distTag = recipe.distTag || "latest";
  if (!NPM_DIST_TAG.test(distTag)) throw new Error("The registry native package dist-tag is invalid.");
  const candidates = registryCandidates(options);
  if (!candidates.length) throw new Error("No valid HTTPS npm registry is available.");
  const request = options.fetch || fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: string[] = [];
  for (const registry of candidates) {
    try {
      const resolved = await readRegistryManifest(request, registry, packageName, distTag, timeoutMs);
      return {
        type: "native-package",
        platforms: [platform],
        arches: [arch],
        ...(recipe.libc ? { libc: recipe.libc } : {}),
        privilege: recipe.privilege || "user",
        package: packageName,
        packageVersion: resolved.version,
        version: resolved.version,
        integrity: resolved.integrity,
        launchPath: recipe.launchPath,
        tarballUrl: resolved.tarballUrl,
      };
    } catch (error) {
      failures.push(`${registry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Remote desktop package source is unavailable: ${failures.join("; ")}`);
}

export function isRegistryNativePackageRecipe(
  recipe: { type: string },
): recipe is RegistryNativePackageInstallRecipe {
  return recipe.type === "registry-native-package";
}
