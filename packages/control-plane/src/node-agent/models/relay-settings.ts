import type { FastifyInstance } from "fastify";
import {
  UpdateNodeAgentModelRelaySchema,
  type NodeAgentModelRelay,
  type NodeAgentModelRelayUnknownModelPolicy,
} from "@task-handoff/protocol/control-plane";
import type { JsonFile } from "../../shared/persistence/store.ts";
import type { NodeAgentRuntimeSettings } from "../runtime-settings.ts";
import type { NodeModelRegistry } from "./registry.ts";

/** Effective relay settings; unlike the wire model, the policy is always resolved. */
export type EffectiveNodeAgentModelRelay = NodeAgentModelRelay & {
  unknownModelPolicy: NodeAgentModelRelayUnknownModelPolicy;
};

/**
 * Product default for the node-level relay switch. A node that never persisted
 * `modelRelay` reports `source: "default"` and relays; only an explicit
 * persisted boolean flips the live switch.
 */
export const NODE_MODEL_RELAY_DEFAULT_ENABLED: boolean = true;

/**
 * Process-wide live view of the persisted relay switch. The runtime settings
 * file stays the only authority; this holder exists so route resolution and
 * assignment gates do not re-read and re-parse the file on every request.
 */
export class NodeModelRelaySwitch {
  private enabledValue: boolean = NODE_MODEL_RELAY_DEFAULT_ENABLED;
  private unknownModelPolicyValue: NodeAgentModelRelayUnknownModelPolicy = "passthrough";

  enabled() {
    return this.enabledValue;
  }

  unknownModelPolicy() {
    return this.unknownModelPolicyValue;
  }

  set(input: { enabled: boolean; unknownModelPolicy: NodeAgentModelRelayUnknownModelPolicy }) {
    this.enabledValue = input.enabled;
    this.unknownModelPolicyValue = input.unknownModelPolicy;
  }
}

/**
 * Node-level model relay switch persisted in runtime-settings.json. Missing or
 * malformed stored values are reported as `source: "default"` and keep relay
 * enabled; only an explicit persisted boolean flips the live switch.
 */
export class NodeModelRelaySettings {
  private readonly settings: JsonFile<NodeAgentRuntimeSettings>;
  private readonly registry: NodeModelRegistry;
  private readonly relaySwitch: NodeModelRelaySwitch;

  constructor(input: {
    settings: JsonFile<NodeAgentRuntimeSettings>;
    registry: NodeModelRegistry;
    relaySwitch: NodeModelRelaySwitch;
  }) {
    this.settings = input.settings;
    this.registry = input.registry;
    this.relaySwitch = input.relaySwitch;
  }

  /** Load the persisted value into the live switch during startup. */
  restore(): NodeAgentModelRelay {
    const effective = this.effective();
    this.relaySwitch.set({ enabled: effective.enabled, unknownModelPolicy: effective.unknownModelPolicy });
    return effective;
  }

  effective(): EffectiveNodeAgentModelRelay {
    const stored = this.settings.get().modelRelay;
    // The stored value is already schema-validated by JsonFile, so the
    // effective document is built directly instead of re-parsing.
    return {
      enabled: stored?.enabled ?? NODE_MODEL_RELAY_DEFAULT_ENABLED,
      unknownModelPolicy: stored?.unknownModelPolicy ?? "passthrough",
      source: stored ? "persisted" : "default",
    };
  }

  enabled() {
    return this.relaySwitch.enabled();
  }

  update(input: unknown): NodeAgentModelRelay {
    const candidate = UpdateNodeAgentModelRelaySchema.parse(input);
    if (!candidate.enabled) this.assertDisableAllowed();
    // The policy field is additive: an older control plane that only sends
    // `enabled` must keep the node's current unknown-model policy.
    const unknownModelPolicy = candidate.unknownModelPolicy ?? this.effective().unknownModelPolicy;
    this.settings.put({ ...this.settings.get(), version: 1, modelRelay: { enabled: candidate.enabled, unknownModelPolicy } });
    this.relaySwitch.set({ enabled: candidate.enabled, unknownModelPolicy });
    return this.effective();
  }

  private assertDisableAllowed() {
    const instanceIds = this.registry.mappedAssignmentInstanceIds();
    if (instanceIds.length) {
      throw Object.assign(
        new Error(`Cannot disable the node model relay while ${instanceIds.length} instance${instanceIds.length === 1 ? "" : "s"} use a model name mapping.`),
        { statusCode: 409, code: "NODE_MODEL_RELAY_IN_USE", details: { instanceIds } },
      );
    }
  }
}

/**
 * Local node-agent settings routes consumed by the control-plane gateway.
 * `converge` re-materializes assigned instances after a state change so the
 * projected catalog flips without restarting node-agent or any instance.
 */
export function registerNodeModelRelaySettingsRoutes(
  app: FastifyInstance,
  settings: NodeModelRelaySettings,
  converge: (current: NodeAgentModelRelay) => Promise<void>,
) {
  app.get("/api/node-agent/settings/model-relay", async () => ({ data: settings.effective() }));
  app.patch("/api/node-agent/settings/model-relay", async (request) => {
    const before = settings.enabled();
    const updated = settings.update(request.body);
    if (before !== updated.enabled) await converge(updated);
    return { data: updated };
  });
}
