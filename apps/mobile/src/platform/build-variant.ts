import Constants from 'expo-constants';

export const isMobileTestMode = Constants.expoConfig?.extra?.variant === 'development';
export const isMobileStagingMode = Constants.expoConfig?.extra?.variant === 'staging';

export type MobileCloudEnvironment = {
  id: string;
  serviceOrigin: string;
  coordinatorHostSuffixes: readonly string[];
  relayHostSuffixes: readonly string[];
  allowInsecureRelay: boolean;
};

export type MobileCloudDiscoveryConfig = {
  record: string;
  fallbackOrigin: string;
  allowedHostSuffixes: readonly string[];
};

// Cloud access is disabled until a manifest supplies an environment. The reserved
// `.invalid` domain makes an accidental request fail closed without embedding an
// official production host in the source tree.
const UNCONFIGURED_CLOUD_ENVIRONMENT: MobileCloudEnvironment = Object.freeze({
  id: 'unconfigured',
  serviceOrigin: 'https://cloud.invalid',
  coordinatorHostSuffixes: Object.freeze([]),
  relayHostSuffixes: Object.freeze([]),
  allowInsecureRelay: false,
});

function safeUrl(value: unknown) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function parseCloudEnvironment(value: unknown): MobileCloudEnvironment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const serviceOrigin = safeUrl(candidate.serviceOrigin);
  const coordinatorHostSuffixes = hostList(candidate.coordinatorHostSuffixes);
  const relayHostSuffixes = hostList(candidate.relayHostSuffixes);
  if (!serviceOrigin || coordinatorHostSuffixes.length === 0 || relayHostSuffixes.length === 0) return undefined;
  return Object.freeze({
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : 'custom',
    serviceOrigin: serviceOrigin.origin,
    coordinatorHostSuffixes: Object.freeze(coordinatorHostSuffixes),
    relayHostSuffixes: Object.freeze(relayHostSuffixes),
    allowInsecureRelay: candidate.allowInsecureRelay === true,
  });
}

function hostList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((host): host is string => typeof host === 'string' && host.length > 0).map((host) => host.toLowerCase().replace(/^\./, '').replace(/\.$/, ''))
    : [];
}

// Ad-hoc clouds (local HTTP stacks and build-time overrides) may only reach a Relay
// served from the same host, and plain `ws://` is limited to HTTP service origins.
export function mobileCloudEnvironmentForServiceOrigin(serviceOrigin: string): MobileCloudEnvironment | undefined {
  const parsed = safeUrl(serviceOrigin);
  if (!parsed) return undefined;
  return Object.freeze({
    id: 'custom',
    serviceOrigin: parsed.origin,
    coordinatorHostSuffixes: Object.freeze([parsed.hostname]),
    relayHostSuffixes: Object.freeze([parsed.hostname]),
    allowInsecureRelay: parsed.protocol === 'http:',
  });
}

export const mobileCloudEnvironment: MobileCloudEnvironment = parseCloudEnvironment(Constants.expoConfig?.extra?.cloudEnvironment)
  ?? mobileCloudEnvironmentForServiceOrigin(Constants.expoConfig?.extra?.cloudServiceOrigin)
  ?? UNCONFIGURED_CLOUD_ENVIRONMENT;

function parseCloudDiscoveryConfig(value: unknown): MobileCloudDiscoveryConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const fallbackOrigin = safeUrl(candidate.fallbackOrigin);
  const allowedHostSuffixes = Array.isArray(candidate.allowedHostSuffixes)
    ? candidate.allowedHostSuffixes.filter((suffix): suffix is string => typeof suffix === 'string' && suffix.length > 0)
    : [];
  if (typeof candidate.record !== 'string' || !candidate.record || !fallbackOrigin || allowedHostSuffixes.length === 0) return undefined;
  return Object.freeze({
    record: candidate.record,
    fallbackOrigin: fallbackOrigin.origin,
    allowedHostSuffixes: Object.freeze(allowedHostSuffixes),
  });
}

const parsedCloudDiscoveryConfig = parseCloudDiscoveryConfig(Constants.expoConfig?.extra?.cloudDiscovery);
export const mobileCloudDiscoveryConfig: MobileCloudDiscoveryConfig | undefined = parsedCloudDiscoveryConfig
  && mobileCloudEnvironment.coordinatorHostSuffixes.length > 0
  ? Object.freeze({
      ...parsedCloudDiscoveryConfig,
      allowedHostSuffixes: mobileCloudEnvironment.coordinatorHostSuffixes,
    })
  : undefined;

function hostMatchesSuffix(hostname: string, suffix: string) {
  const normalized = suffix.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function isTrustedMobileCloudServiceOrigin(origin: unknown) {
  const parsed = safeUrl(origin);
  if (!parsed) return false;
  if (parsed.origin === mobileCloudEnvironment.serviceOrigin) return true;
  return parsed.protocol === 'https:'
    && mobileCloudEnvironment.coordinatorHostSuffixes.some((suffix) => hostMatchesSuffix(parsed.hostname, suffix));
}

export function isTrustedMobileCloudRelayHost(url: URL) {
  return mobileCloudEnvironment.relayHostSuffixes.some((suffix) => hostMatchesSuffix(url.hostname, suffix));
}

export function isTrustedMobileCloudRelayUrl(url: URL) {
  if (!isTrustedMobileCloudRelayHost(url)) return false;
  return url.protocol === 'wss:' || (url.protocol === 'ws:' && mobileCloudEnvironment.allowInsecureRelay);
}

const configuredScheme = Array.isArray(Constants.expoConfig?.scheme) ? Constants.expoConfig.scheme[0] : Constants.expoConfig?.scheme;
export const mobileAppScheme = typeof configuredScheme === 'string' && configuredScheme.length > 0 ? configuredScheme : 'taskhandoff';

export type MobileFeatureFlag = 'officialAccount';

export function isMobileFeatureEnabled(flag: MobileFeatureFlag) {
  const flags = Constants.expoConfig?.extra?.featureFlags;
  if (flags && typeof flags === 'object' && typeof flags[flag] === 'boolean') return flags[flag];
  // Compatibility for v0.0.32: native manifests exposed only cloudRelayEnabled.
  if (flag === 'officialAccount') return Constants.expoConfig?.extra?.cloudRelayEnabled === true;
  return false;
}
