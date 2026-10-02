import { z } from "zod";

/**
 * Wire protocols an upstream model endpoint may expose. The enum is shared by
 * the control-plane/node-agent model records and by both capability documents
 * of the model-relay boundary; it stays independent from the consuming app.
 */
export const ModelProtocolSchema = z.enum(["openai-responses", "openai-chat-completions", "anthropic-messages"]);
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>;
