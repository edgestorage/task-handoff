export type CloudEnvironment = {
  readonly id: string;
  readonly serviceOrigin: string;
  readonly coordinatorHostSuffixes: readonly string[];
  readonly relayHostSuffixes: readonly string[];
  readonly allowInsecureRelay: boolean;
};

export type CloudDiscovery = {
  readonly record: string;
  readonly fallbackOrigin: string;
  readonly allowedHostSuffixes: readonly string[];
};

export const CLOUD_ENVIRONMENT_VARIABLES: Readonly<{
  environment: "TASK_HANDOFF_CLOUD_ENV";
  serviceOrigin: "TASK_HANDOFF_CLOUD_SERVICE_ORIGIN";
  serviceOrigins: "TASK_HANDOFF_CLOUD_SERVICE_ORIGINS";
  coordinatorHostSuffixes: "TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES";
  relayHostSuffixes: "TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES";
  allowInsecureRelay: "TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY";
  discoveryRecord: "TASK_HANDOFF_CLOUD_DISCOVERY_RECORD";
  discoveryFallbackOrigin: "TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN";
}>;

export function configuredCloudEnvironmentVariables(environment?: NodeJS.ProcessEnv): Readonly<Record<string, string>>;
export function resolveCloudEnvironment(name?: string, fallback?: string, environment?: NodeJS.ProcessEnv): CloudEnvironment;
export function resolveCloudDiscovery(environmentOrName?: CloudEnvironment | string, environment?: NodeJS.ProcessEnv): CloudDiscovery | undefined;
export function cloudEnvironmentForServiceOrigin(serviceOrigin: string, environment?: NodeJS.ProcessEnv): CloudEnvironment;
export function isTrustedCloudServiceOrigin(environment: CloudEnvironment, value: string | undefined): boolean;
export function isTrustedCloudRelayUrl(environment: CloudEnvironment, value: string | URL): boolean;
