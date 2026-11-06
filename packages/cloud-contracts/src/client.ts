import { z } from "zod";
import { ControlPlaneDirectoryEntrySchema, type ControlPlaneDirectoryEntry } from "./binding.ts";
import { NodeRelayRegistryProjectionSchema, type NodeRelayRegistryProjection } from "./node-relay.ts";
import { RESOURCE_SHARING_CAPABILITY_HEADER, RESOURCE_SHARING_CLIENT_CAPABILITY } from "./relay.ts";
import { CONTROL_PLANE_BINDING_PROTOCOL_VERSION } from "./versions.ts";

// Optional, untrusted diagnostics only; never use a version as authorization.
export const OFFICIAL_CLIENT_VERSION_HEADER = "x-task-handoff-client-version";
export const OFFICIAL_CLIENT_BUILD_HEADER = "x-task-handoff-client-build";

export function officialClientMetadataFromHeaders(headers: Readonly<Record<string, unknown>>) {
  const bounded = (value: unknown) => typeof value === "string" && /^[\x21-\x7e]{1,80}$/.test(value) ? value : undefined;
  const clientVersion = bounded(headers[OFFICIAL_CLIENT_VERSION_HEADER]);
  const clientBuild = bounded(headers[OFFICIAL_CLIENT_BUILD_HEADER]);
  return { ...(clientVersion ? { clientVersion } : {}), ...(clientBuild ? { clientBuild } : {}) };
}

const DirectoryResponseSchema = z.strictObject({
  data: z.strictObject({
    protocolVersion: z.literal(CONTROL_PLANE_BINDING_PROTOCOL_VERSION),
    items: z.array(ControlPlaneDirectoryEntrySchema),
  }),
});

const NodeDirectoryResponseSchema = z.strictObject({
  data: z.strictObject({
    items: z.array(NodeRelayRegistryProjectionSchema),
  }),
});

const directoryKeys = Object.keys(ControlPlaneDirectoryEntrySchema.shape);
const nodeDirectoryKeys = Object.keys(NodeRelayRegistryProjectionSchema.shape);

type JsonObject = Readonly<Record<string, unknown>>;
export interface OfficialHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type OfficialRequestFunction = (input: string, init?: RequestInit) => Promise<OfficialHttpResponse>;

export interface OfficialAccountClientOptions {
  origin: string;
  accessToken: () => Promise<string>;
  request?: OfficialRequestFunction;
  clientVersion?: string;
  clientBuild?: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sanitizeDirectoryResponse(value: unknown): unknown {
  const root = objectValue(value);
  const data = objectValue(root?.data);
  if (!root || !data) return value;
  const items = Array.isArray(data.items) ? data.items.map((item) => {
    if (!item || typeof item !== "object") return item;
    // Independently upgraded clients ignore additive server fields before
    // applying the current strict contract.
    const record = item as Record<string, unknown>;
    return Object.fromEntries(directoryKeys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
  }) : data.items;
  return { data: { protocolVersion: data.protocolVersion, items } };
}

function sanitizeNodeDirectoryResponse(value: unknown): unknown {
  const root = objectValue(value);
  const data = objectValue(root?.data);
  if (!root || !data) return value;
  const items = Array.isArray(data.items) ? data.items.map((item) => {
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(nodeDirectoryKeys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
  }) : data.items;
  return { data: { items } };
}

export class OfficialAccountClient {
  protected readonly origin: string;
  protected readonly accessToken: () => Promise<string>;
  protected readonly request: OfficialRequestFunction;
  private readonly metadataHeaders: Record<string, string>;

  constructor(options: OfficialAccountClientOptions) {
    const metadata = officialClientMetadataFromHeaders({
      [OFFICIAL_CLIENT_VERSION_HEADER]: options.clientVersion,
      [OFFICIAL_CLIENT_BUILD_HEADER]: options.clientBuild,
    });
    this.metadataHeaders = {
      ...(metadata.clientVersion ? { [OFFICIAL_CLIENT_VERSION_HEADER]: metadata.clientVersion } : {}),
      ...(metadata.clientBuild ? { [OFFICIAL_CLIENT_BUILD_HEADER]: metadata.clientBuild } : {}),
    };
    this.origin = new URL(options.origin).origin;
    this.accessToken = options.accessToken;
    this.request = options.request ?? ((input, init) => fetch(input, init));
  }

  async listControlPlanes(): Promise<ControlPlaneDirectoryEntry[]> {
    const response = await this.call("/api/v1/control-planes", { method: "GET" });
    return DirectoryResponseSchema.parse(sanitizeDirectoryResponse(response)).data.items;
  }

  async listNodes(): Promise<NodeRelayRegistryProjection[]> {
    const response = await this.call("/api/v1/nodes", { method: "GET" });
    return NodeDirectoryResponseSchema.parse(sanitizeNodeDirectoryResponse(response)).data.items;
  }

  async updateControlPlaneMetadata(controlPlaneId: string, displayName: JsonObject): Promise<unknown> {
    const response = await this.call<{ data: unknown }>(`/api/v1/control-planes/${encodeURIComponent(controlPlaneId)}/metadata`, { method: "PATCH", body: JSON.stringify({ displayName }) });
    return response.data;
  }

  protected requestHeaders(): Record<string, string> {
    return {
      ...this.metadataHeaders,
      [RESOURCE_SHARING_CAPABILITY_HEADER]: RESOURCE_SHARING_CLIENT_CAPABILITY,
    };
  }

  protected async call<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const response = await this.request(`${this.origin}${path}`, { ...init, headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-task-handoff-protocol": CONTROL_PLANE_BINDING_PROTOCOL_VERSION,
      ...this.requestHeaders(),
    } });
    const body: unknown = await response.json();
    if (!response.ok) throw officialClientError(body, response.status);
    return body as T;
  }
}

export function officialClientError(body: unknown, status: number): Error & { code?: string; status: number } {
  const error = objectValue(objectValue(body)?.error);
  const message = typeof error?.message === "string" ? error.message : "Official service request failed.";
  const code = typeof error?.code === "string" ? error.code : undefined;
  return Object.assign(new Error(message), { code, status });
}
