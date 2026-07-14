import type { ReceiverControlClient } from "../web/receiver-control-client";
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
  constructor(
    private readonly store: TriggerStore,
    private readonly receiverControl: ReceiverControlClient,
    private readonly aiSessionController?: AiSessionController,
  ) {}

  async execute(input: TriggerExecuteInput) {
    const run = this.store.startRun(input.config, input.deployment, input.eventType, input.eventSummary);
    const text = input.promptOverride || renderPrompt(input.config.action.promptTemplate, {
      trigger: input.config,
      event: { type: input.eventType, summary: input.eventSummary || "" },
    });
    try {
      if (input.deployment.target.type === "ai-session") {
        if (!this.aiSessionController) {
          throw Object.assign(new Error("AI session trigger targets are not available."), { code: "TRIGGER_AI_SESSION_TARGET_UNAVAILABLE", statusCode: 400 });
        }
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
      }
      const result = await this.receiverControl.message({
        channel: "web",
        chatSessionId: `trigger:${input.deployment.deploymentId || input.deployment.configHash}`,
        userId: "trigger",
        conversationId: input.deployment.target.conversationId,
        text,
        attachments: [],
      });
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
