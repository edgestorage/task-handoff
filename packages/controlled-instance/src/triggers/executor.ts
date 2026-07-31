import type { AiSessionController } from "@task-handoff/ai-session-runtime";
import type { TriggerConfig, TriggerDeployment, TriggerRun } from "@task-handoff/protocol/triggers";
import type { TriggerStore } from "./store.ts";

export type TriggerExecuteInput = {
  config: TriggerConfig;
  deployment: TriggerDeployment;
  eventType: TriggerRun["eventType"];
  eventSummary?: string;
  promptOverride?: string;
};

export class TriggerExecutor {
  private readonly store: TriggerStore;
  private readonly aiSessionController: AiSessionController;
  private draining = false;

  constructor(
    store: TriggerStore,
    aiSessionController: AiSessionController,
  ) {
    this.store = store;
    this.aiSessionController = aiSessionController;
  }

  beginDrain() {
    this.draining = true;
  }

  endDrain() {
    this.draining = false;
  }

  async execute(input: TriggerExecuteInput) {
    if (this.draining) {
      throw Object.assign(new Error("Triggers are unavailable while the controlled instance is draining for a runtime update."), {
        code: "TRIGGER_RUNTIME_DRAINING",
      });
    }
    const run = this.store.startRun(input.config, input.deployment, input.eventType, input.eventSummary);
    const text = input.promptOverride || renderPrompt(input.config.action.promptTemplate, {
      trigger: input.config,
      event: { type: input.eventType, summary: input.eventSummary || "" },
    });
    try {
      let result: unknown;
      try {
        result = await this.aiSessionController.sendMessage(input.deployment.target.aiSessionId, { message: text });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && String(error.code) === "AI_SESSION_NOT_FOUND") {
          this.store.deleteDeployment(input.deployment.configHash, input.deployment.deploymentId || input.deployment.configHash);
        }
        throw error;
      }
      const completed = this.store.completeRun(run);
      return { run: completed, result };
    } catch (error) {
      const failed = this.store.completeRun(run, error);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { run: failed });
    }
  }
}

function renderPrompt(template: string, context: { trigger: TriggerConfig; event: { type: string; summary: string } }) {
  return template
    .replaceAll("{{trigger.configHash}}", context.trigger.configHash)
    .replaceAll("{{trigger.name}}", context.trigger.name)
    .replaceAll("{{event.type}}", context.event.type)
    .replaceAll("{{event.summary}}", context.event.summary);
}
