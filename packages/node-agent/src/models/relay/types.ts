import type { Readable } from "node:stream";
import type { ModelProtocol, NodeModelConfig } from "@task-handoff/protocol/control-plane";
import type { ModelRelayErrorCode } from "./errors.ts";

export type ModelRelayUpstreamPlan = {
  kind: "upstream";
  /** Stable operation label for diagnostics; never the raw request path. */
  name: string;
  method: string;
  /** Absolute upstream URL built by the adapter from the assigned entity. */
  url: string;
  /** Response body shape the adapter can rewrite. */
  responseMode: "json" | "sse" | "raw";
};

export type ModelRelayOperationPlan =
  | ModelRelayUpstreamPlan
  /** Node-generated response (for example the relay-synthesized model catalog). */
  | { kind: "synthetic"; name: string; status: number; headers?: Record<string, string>; body?: Buffer | string }
  /** Deterministic local rejection (for example the Claude gateway probe). */
  | { kind: "reject"; name: string; status: number; code: ModelRelayErrorCode; message: string };

export type ModelRelayRequestPreparation = {
  /**
   * Body to send upstream. Adapters return a replaying stream when they read
   * a bounded prologue to resolve the model name, otherwise the original.
   */
  body?: Readable;
  /** External name the caller requested; used to map responses back. */
  externalModelName?: string;
  /** Resolved upstream model name for diagnostics and response mapping. */
  upstreamModelName?: string;
  /** Bytes consumed while resolving the model name, for the operation log. */
  requestBytes?: number;
};

/** Safe diagnostic emitted while rewriting a response; never contains names. */
export type ModelRelayDiagnostic = { code: string };

export interface ModelRelayAdapter {
  readonly protocol: ModelProtocol;
  /** Fixed operation allowlist; unknown methods/paths return a `reject` plan. */
  planOperation(input: { method: string; operationPath: string; search: string; model: NodeModelConfig }): ModelRelayOperationPlan;
  /**
   * Resolve the request's external model name and produce the upstream body.
   * Runs before any upstream contact and may only read a bounded prologue.
   */
  prepareRequest(input: {
    body: Readable | undefined;
    plan: ModelRelayUpstreamPlan;
    model: NodeModelConfig;
    resolveUpstreamModelName(externalName: string): string;
    maxPrologueBytes: number;
  }): Promise<ModelRelayRequestPreparation>;
  /**
   * Wrap a successful upstream body so protocol-standard model fields map back
   * to the external name. Return the source unchanged when nothing applies.
   */
  prepareResponse(input: {
    body: Readable;
    plan: ModelRelayUpstreamPlan;
    model: NodeModelConfig;
    externalModelName?: string;
    upstreamModelName?: string;
    maxResponseEventBytes: number;
    onDiagnostic?: (diagnostic: ModelRelayDiagnostic) => void;
  }): Readable;
}

export class ModelRelayAdapterRegistry {
  private readonly adapters = new Map<ModelProtocol, ModelRelayAdapter>();

  constructor(adapters: ModelRelayAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ModelRelayAdapter) {
    this.adapters.set(adapter.protocol, adapter);
  }

  get(protocol: ModelProtocol) {
    return this.adapters.get(protocol);
  }

  protocols(): ModelProtocol[] {
    return [...this.adapters.keys()];
  }
}
