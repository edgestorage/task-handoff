export type CloudEnvironment = {
  readonly id: string;
  readonly serviceOrigin: string;
  readonly relayHosts: readonly string[];
  readonly allowInsecureRelay: boolean;
};

export type CloudDiscovery = {
  readonly record: string;
  readonly fallbackOrigin: string;
  readonly allowedHostSuffixes: readonly string[];
};

export const CLOUD_ENVIRONMENTS: Readonly<Record<"production" | "staging", CloudEnvironment>>;
export const CLOUD_DISCOVERY: Readonly<Record<"production" | "staging", CloudDiscovery>>;
export const DEFAULT_CLOUD_ENVIRONMENT: "production";

export function resolveCloudEnvironment(name?: string, fallback?: string): CloudEnvironment;
export function cloudEnvironmentForServiceOrigin(serviceOrigin: string): CloudEnvironment;
export function isTrustedCloudServiceOrigin(environment: CloudEnvironment, value: string | undefined): boolean;
export function isTrustedCloudRelayUrl(environment: CloudEnvironment, value: string | URL): boolean;
