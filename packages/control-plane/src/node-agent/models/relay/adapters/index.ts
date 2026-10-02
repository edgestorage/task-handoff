import type { ModelRelayAdapter } from "../types.ts";
import { createAnthropicMessagesAdapter } from "./anthropic-messages.ts";
import { createOpenAiChatCompletionsAdapter } from "./openai-chat-completions.ts";
import { createOpenAiResponsesAdapter } from "./openai-responses.ts";

/** All relay protocols the node currently supports. */
export function createModelRelayAdapters(): ModelRelayAdapter[] {
  return [
    createOpenAiResponsesAdapter(),
    createOpenAiChatCompletionsAdapter(),
    createAnthropicMessagesAdapter(),
  ];
}
