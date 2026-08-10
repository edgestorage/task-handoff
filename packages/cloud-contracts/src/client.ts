import { z } from "zod";
import { ControlPlaneDirectoryEntrySchema, type ControlPlaneDirectoryEntry } from "./binding.ts";
import { CONTROL_PLANE_BINDING_PROTOCOL_VERSION } from "./versions.ts";

const DirectoryResponseSchema = z.strictObject({
  data: z.strictObject({
    protocolVersion: z.literal(CONTROL_PLANE_BINDING_PROTOCOL_VERSION),
    items: z.array(ControlPlaneDirectoryEntrySchema),
  }),
});

const directoryKeys = Object.keys(ControlPlaneDirectoryEntrySchema.shape);

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

export class OfficialAccountClient {
  protected readonly origin: string;
  protected readonly accessToken: () => Promise<string>;
  protected readonly request: OfficialRequestFunction;

  constructor(options: OfficialAccountClientOptions) {
    this.origin = new URL(options.origin).origin;
    this.accessToken = options.accessToken;
    this.request = options.request ?? ((input, init) => fetch(input, init));
  }

  async listControlPlanes(): Promise<ControlPlaneDirectoryEntry[]> {
    const response = await this.call("/api/v1/control-planes", { method: "GET" });
    return DirectoryResponseSchema.parse(sanitizeDirectoryResponse(response)).data.items;
  }

  async updateControlPlaneMetadata(controlPlaneId: string, displayName: JsonObject): Promise<unknown> {
    const response = await this.call<{ data: unknown }>(`/api/v1/control-planes/${encodeURIComponent(controlPlaneId)}/metadata`, { method: "PATCH", body: JSON.stringify({ displayName }) });
    return response.data;
  }

  protected async call<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const response = await this.request(`${this.origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-task-handoff-protocol": CONTROL_PLANE_BINDING_PROTOCOL_VERSION } });
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
