export type CloudDiscoveryConfig = {
  readonly record: string;
  readonly fallbackOrigin: string;
  readonly allowedHostSuffixes: readonly string[];
};

export type ParsedCloudDiscoveryRecord = {
  readonly version: "v1";
  readonly origins: readonly string[];
};

export type CloudDiscoverySource = "txt" | "cache" | "fallback";

export type CloudEndpointResolverOptions = {
  config?: CloudDiscoveryConfig;
  fallbackOrigin: string;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  now?: () => number;
  queryTimeoutMs?: number;
  healthTimeoutMs?: number;
  healthCheckPath?: string;
  cacheMaxAgeMs?: number;
  cooldownMs?: number;
};

export const CLOUD_DISCOVERY_VERSION: "v1";
export const MAX_CLOUD_DISCOVERY_ENDPOINTS: 5;

export class CloudDiscoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function decodeDnsTxtValue(value: string): string;
export function hostMatchesSuffix(hostname: string, suffix: string): boolean;
export function parseCloudDiscoveryRecord(raw: string, config: Pick<CloudDiscoveryConfig, "allowedHostSuffixes">): ParsedCloudDiscoveryRecord;
export function queryCloudDiscoveryTxt(record: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<string>;

export class CloudEndpointResolver {
  constructor(options: CloudEndpointResolverOptions);
  readonly enabled: boolean;
  readonly activeOrigin: string;
  readonly endpoints: readonly string[];
  readonly currentSource: CloudDiscoverySource;
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  isTrustedOrigin(origin: unknown): boolean;
  markSuccess(origin: string): void;
  markFailure(origin: string): void;
  request(input: string | URL, init?: RequestInit): Promise<Response>;
}
