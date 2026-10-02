import type { FastifyInstance } from "fastify";
import {
  NodeAgentModelRelaySchema,
  UpdateNodeAgentModelRelaySchema,
  type NodeAgentModelRelay,
} from "@task-handoff/protocol/control-plane";
import type { JsonFile } from "../../shared/persistence/store.ts";
import type { NodeAgentRuntimeSettings } from "../runtime-settings.ts";
import type { NodeModelRegistry } from "./registry.ts";

/**
 * Process-wide live view of the persisted relay switch. The runtime settings
 * file stays the only authority; this holder exists so route resolution and
 * assignment gates do not re-read and re-parse the file on every request.
 */
export class NodeModelRelaySwitch {
  private value = false;

  enabled() {
    return this.value;
  }

  set(enabled: boolean) {
    this.value = enabled;
  }
}

/**
 * Node-level model relay switch persisted in runtime-settings.json. Missing or
 * malformed stored values are reported as `source: "default"` and keep relay
 * disabled; only an explicit persisted boolean flips the live switch.
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
    this.relaySwitch.set(effective.enabled);
    return effective;
  }

  effective(): NodeAgentModelRelay {
    const stored = this.settings.get().modelRelay;
    return NodeAgentModelRelaySchema.parse(stored
      ? { enabled: stored.enabled, source: "persisted" }
      : { enabled: false, source: "default" });
  }

  enabled() {
    return this.relaySwitch.enabled();
  }

  update(input: unknown): NodeAgentModelRelay {
    const candidate = UpdateNodeAgentModelRelaySchema.parse(input);
    if (!candidate.enabled) this.assertDisableAllowed();
    this.settings.put({ ...this.settings.get(), version: 1, modelRelay: { enabled: candidate.enabled } });
    this.relaySwitch.set(candidate.enabled);
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
