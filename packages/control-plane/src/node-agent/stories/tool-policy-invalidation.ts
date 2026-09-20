import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import {
  StoryAgentToolPolicyInvalidatedSchema,
  type StoryAgentToolPolicyInvalidated,
} from "@task-handoff/protocol/story-agent-tools";
import type { NodeAgentState } from "../state.ts";

export class StoryToolPolicyInvalidationNotifier {
  private readonly state: Pick<NodeAgentState, "listInstances">;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;
  private readonly warn: (data: Record<string, unknown>, message: string) => void;

  constructor(
    state: Pick<NodeAgentState, "listInstances">,
    fetchImpl: typeof fetch,
    resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>,
    warn: (data: Record<string, unknown>, message: string) => void,
  ) {
    this.state = state;
    this.fetchImpl = fetchImpl;
    this.resolveInstanceWeb = resolveInstanceWeb;
    this.warn = warn;
  }

  async notify(input: StoryAgentToolPolicyInvalidated) {
    const event = StoryAgentToolPolicyInvalidatedSchema.parse(input);
    const targets = this.state.listInstances().filter((instance) => (
      instance.registrationToken
      && instance.aiSessions.sessions.some((session) => session.storyId === event.storyId)
    ));
    await Promise.all(targets.map((instance) => this.notifyInstance(instance, event)));
  }

  private async notifyInstance(instance: ControlledInstance, event: StoryAgentToolPolicyInvalidated) {
    try {
      const response = await this.fetchImpl(`${await this.resolveInstanceWeb(instance)}/api/internal/node-agent/story-agent-tools/invalidate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${instance.registrationToken}`,
        },
        body: JSON.stringify(event),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      this.warn({
        storyId: event.storyId,
        revision: event.revision,
        instanceId: instance.id,
        error: error instanceof Error ? error.message : String(error),
      }, "Story Agent Tool policy invalidation failed");
    }
  }
}
