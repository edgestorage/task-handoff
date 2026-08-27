import type { AiSessionProviderCapability } from "@task-handoff/protocol/control-plane";
import type { AiSessionHistoryItem } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionControlProvider, AiSessionController } from "./ai-session-control";
import type { AiSessionDiscoveryCoordinator, AiSessionDiscoveryProvider } from "./ai-session-discovery";

export type AiSessionProviderDescriptor = {
  agent: string;
  controlProvider: AiSessionControlProvider;
  discoveryProvider?: AiSessionDiscoveryProvider;
  ensureReady?: () => void | Promise<void>;
  resume?: (item: AiSessionHistoryItem) => void | Promise<void>;
  capability: AiSessionProviderCapability | (() => AiSessionProviderCapability);
};

export class AiSessionProviderRegistry {
  private readonly descriptors = new Map<string, AiSessionProviderDescriptor>();

  constructor(
    private readonly controller: AiSessionController,
    private readonly discovery: AiSessionDiscoveryCoordinator,
  ) {}

  register(descriptor: AiSessionProviderDescriptor) {
    if (descriptor.agent !== descriptor.controlProvider.agent) {
      throw new Error(`AI Session provider descriptor ${descriptor.agent} controls ${descriptor.controlProvider.agent}.`);
    }
    if (this.descriptors.has(descriptor.agent)) {
      throw new Error(`Duplicate AI Session provider descriptor: ${descriptor.agent}`);
    }
    this.descriptors.set(descriptor.agent, descriptor);
    this.controller.register(descriptor.controlProvider);
    if (descriptor.discoveryProvider) this.discovery.register(descriptor.discoveryProvider);
    return descriptor;
  }

  get(agent: string) {
    return this.descriptors.get(agent);
  }

  require(agent: string) {
    const descriptor = this.get(agent);
    if (!descriptor) {
      throw Object.assign(new Error(`${agent} sessions do not have a registered provider runtime.`), {
        code: "AI_SESSION_PROVIDER_UNAVAILABLE",
        statusCode: 400,
      });
    }
    return descriptor;
  }

  async ensureReady(agent: string) {
    await this.require(agent).ensureReady?.();
  }

  async resume(item: AiSessionHistoryItem) {
    const descriptor = this.require(item.agent);
    await descriptor.ensureReady?.();
    if (descriptor.resume) {
      await descriptor.resume(item);
      return;
    }
    await descriptor.controlProvider.resumeSession?.(item.providerSessionId, item.modelSelection, item.reasoningEffort);
  }

  capabilities() {
    return [...this.descriptors.values()].map((descriptor) => (
      typeof descriptor.capability === "function" ? descriptor.capability() : descriptor.capability
    ));
  }
}
