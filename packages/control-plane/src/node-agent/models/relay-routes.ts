import crypto from "node:crypto";
import {
  supportsControlledInstanceModelRelay,
  supportsControlledInstanceModelRelayProtocol,
  type ControlledInstance,
  type ModelProtocol,
  type NodeModelConfig,
} from "@task-handoff/protocol/control-plane";
import { normalizeModelNameEntries } from "@task-handoff/protocol/control-plane";
import type { NodeModelRegistry } from "./registry.ts";

/**
 * relay routes are derived, never persisted. The route id only encodes which
 * assigned entity/protocol pair a provider config points at; it is not a
 * credential, so losing or guessing it grants nothing without the instance's
 * registration token.
 */
export const MODEL_RELAY_ROUTE_PREFIX = "/api/node-agent/model-relay";

export function modelProtocols(model: Pick<NodeModelConfig, "app" | "protocols">): ModelProtocol[] {
  return model.protocols?.length
    ? [...new Set(model.protocols)]
    : model.app === "claude" ? ["anthropic-messages"] : model.app === "opencode" ? ["openai-chat-completions"] : ["openai-responses"];
}

export function deriveModelRelayRouteId(instanceId: string, modelEntityId: string, protocol: ModelProtocol) {
  return `rly_${crypto.createHash("sha256")
    .update(`${instanceId}\u0000${modelEntityId}\u0000${protocol}`)
    .digest("hex")
    .slice(0, 16)}`;
}

export function modelRelayRoutePath(instanceId: string, modelEntityId: string, protocol: ModelProtocol) {
  return `${MODEL_RELAY_ROUTE_PREFIX}/instances/${instanceId}/routes/${deriveModelRelayRouteId(instanceId, modelEntityId, protocol)}/v1`;
}

export function modelRelayRouteBaseUrl(origin: string, instanceId: string, modelEntityId: string, protocol: ModelProtocol) {
  return `${origin.replace(/\/+$/, "")}${modelRelayRoutePath(instanceId, modelEntityId, protocol)}`;
}

/**
 * Split an inbound relay path into its authoritative identity and the
 * protocol-specific operation path. Returns undefined for malformed paths so
 * the caller can fail closed without echoing internals. The operation path is
 * deliberately kept in its raw encoded form: adapters match a fixed allowlist,
 * so decoding it would only widen the surface.
 */
export function parseModelRelayRoutePathname(pathname: string) {
  const match = /^\/api\/node-agent\/model-relay\/instances\/([^/]+)\/routes\/([^/]+)\/v1(?:\/(.*))?$/.exec(pathname);
  if (!match) return undefined;
  // Malformed percent-encoding must not surface as an unhandled URIError in
  // the node-agent auth hook; a path this function cannot read is not a relay
  // route at all.
  let instanceId: string;
  try {
    instanceId = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return {
    instanceId,
    routeId: match[2],
    operationPath: `/${match[3] || ""}`,
  };
}

export type ModelRelayRouteResolution = {
  instance: ControlledInstance;
  model: NodeModelConfig;
  protocol: ModelProtocol;
  routeId: string;
};

function relayError(statusCode: number, code: string, message: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Authoritative per-request resolution. Every lookup reads the current SQLite
 * state and the live relay switch: assignment edits, entity edits, disabled
 * entities and switch changes invalidate previously issued route URLs without
 * any cached topology or restart.
 */
export class NodeModelRelayResolver {
  private readonly registry: NodeModelRegistry;

  constructor(registry: NodeModelRegistry) {
    this.registry = registry;
  }

  /** Live switch value for diagnostics; route resolution re-checks it. */
  relayEnabled() {
    return this.registry.modelRelayEnabled();
  }

  /** Instance lookup for the relay auth hook, before any route/switch state. */
  instance(instanceId: string) {
    return this.registry.instance(instanceId);
  }

  resolveRoute(instanceId: string, routeId: string): ModelRelayRouteResolution {
    if (!this.registry.modelRelayEnabled()) {
      throw relayError(503, "MODEL_RELAY_DISABLED", "The node model relay is disabled.");
    }
    let instance: ControlledInstance;
    try {
      instance = this.registry.instance(instanceId);
    } catch {
      // Unknown instances collapse into the same response as unknown routes so
      // a caller cannot probe which instance ids exist on this node.
      throw relayError(404, "MODEL_RELAY_ROUTE_NOT_FOUND", "The requested model relay route does not exist.");
    }
    if (!supportsControlledInstanceModelRelay(instance.capabilities)) {
      throw relayError(409, "MODEL_RELAY_UNSUPPORTED", `Instance ${instanceId} does not consume node model relay routes.`);
    }
    const assignment = this.registry.assignment(instanceId);
    if (!assignment) {
      throw relayError(404, "MODEL_RELAY_ROUTE_NOT_FOUND", "The requested model relay route does not exist.");
    }
    for (const modelEntityId of this.registry.assignedModelIds(instanceId)) {
      const model = this.registry.getModel(modelEntityId);
      if (!model) continue;
      for (const protocol of modelProtocols(model)) {
        if (deriveModelRelayRouteId(instanceId, modelEntityId, protocol) !== routeId) continue;
        if (!model.enabled) {
          throw relayError(409, "MODEL_RELAY_ENTITY_DISABLED", `Model ${modelEntityId} is disabled.`);
        }
        if (!supportsControlledInstanceModelRelayProtocol(instance.capabilities, protocol)) {
          throw relayError(409, "MODEL_RELAY_UNSUPPORTED", `Instance ${instanceId} does not consume ${protocol} relay routes.`);
        }
        return { instance, model, protocol, routeId };
      }
    }
    throw relayError(404, "MODEL_RELAY_ROUTE_NOT_FOUND", "The requested model relay route does not exist.");
  }

  /**
   * Map the request's external model name onto the upstream name. Unknown or
   * ambiguous names fail closed before any upstream contact; there is no
   * default-model fallback.
   */
  resolveUpstreamModelName(model: Pick<NodeModelConfig, "modelNames" | "model">, requestedName: string) {
    const matches = normalizeModelNameEntries(model.modelNames, model.model).filter((entry) => entry.name === requestedName);
    if (!matches.length) {
      throw relayError(400, "MODEL_RELAY_UNKNOWN_MODEL_NAME", `Model name ${JSON.stringify(requestedName)} is not assigned to this relay route.`);
    }
    if (matches.length > 1) {
      throw relayError(409, "MODEL_RELAY_AMBIGUOUS_MODEL_NAME", `Model name ${JSON.stringify(requestedName)} is ambiguous on this relay route.`);
    }
    return matches[0].upstreamName!;
  }
}
