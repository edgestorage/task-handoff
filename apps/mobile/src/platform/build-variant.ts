import Constants from 'expo-constants';

export const isMobileTestMode = Constants.expoConfig?.extra?.variant === 'development';
export const isMobileStagingMode = Constants.expoConfig?.extra?.variant === 'staging';

export type MobileCloudEnvironment = {
  id: string;
  serviceOrigin: string;
  relayHosts: readonly string[];
  allowInsecureRelay: boolean;
};

export type MobileCloudDiscoveryConfig = {
  record: string;
  fallbackOrigin: string;
  allowedHostSuffixes: readonly string[];
};

// Last-resort default for JS bundles that run against a manifest produced before
// `extra.cloudEnvironment` existed. It mirrors `shared/cloud-environments.cjs`
// (asserted by `__tests__/cloud-domain-test.ts`); every current build bakes the
// selected environment into the manifest instead of relying on this value.
export const MOBILE_PRODUCTION_CLOUD_ORIGIN = 'https://cloud.thandoff.com';
const PRODUCTION_CLOUD_ENVIRONMENT: MobileCloudEnvironment = Object.freeze({
  id: 'production',
  serviceOrigin: MOBILE_PRODUCTION_CLOUD_ORIGIN,
  relayHosts: Object.freeze([
    'relay.thandoff.com',
    'relay.th.xpbox.cn',
    'relay.aaasu.com',
  ]),
  allowInsecureRelay: false,
});

const STAGING_CLOUD_ENVIRONMENT: MobileCloudEnvironment = Object.freeze({
  id: 'staging',
  serviceOrigin: 'https://th.aaasu.com',
  relayHosts: Object.freeze(['relay.aaasu.com']),
  allowInsecureRelay: false,
});

// Registered origins keep their declared Relay hosts, mirroring
// `shared/cloud-environments.cjs` (asserted by `__tests__/cloud-domain-test.ts`).
const KNOWN_CLOUD_ENVIRONMENTS: readonly MobileCloudEnvironment[] = Object.freeze([
  PRODUCTION_CLOUD_ENVIRONMENT,
  STAGING_CLOUD_ENVIRONMENT,
]);

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
  const relayHosts = Array.isArray(candidate.relayHosts) ? candidate.relayHosts.filter((host): host is string => typeof host === 'string' && host.length > 0) : [];
  if (!serviceOrigin || relayHosts.length === 0) return undefined;
  return Object.freeze({
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : 'custom',
    serviceOrigin: serviceOrigin.origin,
    relayHosts: Object.freeze(relayHosts),
    allowInsecureRelay: candidate.allowInsecureRelay === true,
  });
}

// Ad-hoc clouds (local HTTP stacks and build-time overrides) may only reach a Relay
// served from the same host, and plain `ws://` is limited to HTTP service origins.
export function mobileCloudEnvironmentForServiceOrigin(serviceOrigin: string): MobileCloudEnvironment | undefined {
  const parsed = safeUrl(serviceOrigin);
  if (!parsed) return undefined;
  const known = KNOWN_CLOUD_ENVIRONMENTS.find((environment) => environment.serviceOrigin === parsed.origin);
  if (known) return known;
  return Object.freeze({
    id: 'custom',
    serviceOrigin: parsed.origin,
    relayHosts: Object.freeze([parsed.hostname]),
    allowInsecureRelay: parsed.protocol === 'http:',
  });
}

export const mobileCloudEnvironment: MobileCloudEnvironment = parseCloudEnvironment(Constants.expoConfig?.extra?.cloudEnvironment)
  ?? mobileCloudEnvironmentForServiceOrigin(Constants.expoConfig?.extra?.cloudServiceOrigin)
  ?? PRODUCTION_CLOUD_ENVIRONMENT;

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

export const mobileCloudDiscoveryConfig = parseCloudDiscoveryConfig(Constants.expoConfig?.extra?.cloudDiscovery);

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
    && Boolean(mobileCloudDiscoveryConfig?.allowedHostSuffixes.some((suffix) => hostMatchesSuffix(parsed.hostname, suffix)));
}

export function isTrustedMobileCloudRelayHost(url: URL) {
  return mobileCloudEnvironment.relayHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
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
