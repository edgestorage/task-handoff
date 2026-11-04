import crypto from "node:crypto";
import type { ControlledInstance } from "@task-handoff/protocol/control-plane";

export type StoryAiSessionCloseTarget = {
  instance: ControlledInstance;
  sessionId: string;
  storyId: string;
};

export interface StoryAiSessionCloser {
  close(target: StoryAiSessionCloseTarget): Promise<void>;
}

export class StoryAiSessionCloseService implements StoryAiSessionCloser {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;

  constructor(
    fetchImpl: typeof fetch,
    resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>,
  ) {
    this.fetchImpl = fetchImpl;
    this.resolveInstanceWeb = resolveInstanceWeb;
  }

  async close(target: StoryAiSessionCloseTarget) {
    if (!target.instance.registrationToken) throw new Error("AI Session instance is unavailable.");
    const response = await this.fetchImpl(
      `${await this.resolveInstanceWeb(target.instance)}/api/internal/node-agent/ai-sessions/${encodeURIComponent(target.sessionId)}/close-for-story-deletion`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${target.instance.registrationToken}`,
        },
        body: JSON.stringify({ clientRequestId: crypto.randomUUID(), storyId: target.storyId }),
      },
    );
    if (!response.ok) throw new Error(`AI Session close failed with HTTP ${response.status}.`);
  }
}
