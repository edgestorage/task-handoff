export type EventScope = {
  nodeId?: string;
  instanceId?: string;
  [key: string]: unknown;
};

export type EventEnvelope<T = unknown> = {
  v: 1;
  id: string;
  seq: number;
  type: string;
  topic: string;
  createdAt: string;
  payload: T;
  scope?: EventScope;
};

export type EventSubscribeMessage = {
  v?: 1;
  type: "subscribe";
  topics?: string[];
};

export type SessionStreamTopic = z.infer<typeof SessionStreamTopicSchema>;
export type SessionStreamDescriptor = z.infer<typeof SessionStreamDescriptorSchema>;
export type SessionStreamsHello = z.infer<typeof SessionStreamsHelloSchema>;

export function eventTopic(type: string) {
  if (type.startsWith("ai-session.") || type.startsWith("ai.session.")) {
    return "ai.sessions";
  }
  if (type.startsWith("app-session.")) {
    return "app.sessions";
  }
  if (type.startsWith("receiver.")) {
    return "receiver";
  }
  if (type.startsWith("conversation.")) {
    return "conversations";
  }
  if (type.startsWith("trigger.")) {
    return "triggers";
  }
  if (type.startsWith("channel.")) {
    return "channels";
  }
  if (type.startsWith("instance.")) {
    return "instances";
  }
  if (type.startsWith("node.")) {
    return "nodes";
  }
  if (type.startsWith("project.")) {
    return "projects";
  }
  if (type.startsWith("model.")) {
    return "models";
  }
  if (type.startsWith("image.")) {
    return "images";
  }
  return "system";
}
import { z } from "zod";

export const SESSION_STREAM_PROTOCOL_VERSION = 1;

export const SessionStreamTopicSchema = z.enum(["ai.sessions", "app.sessions"]);

export const SessionStreamDescriptorSchema = z.object({
  topic: SessionStreamTopicSchema,
  instanceId: z.string().trim().min(1).max(160),
  streamId: z.string().trim().min(1).max(240),
  latestRevision: z.number().int().min(0),
  earliestRetainedRevision: z.number().int().min(0),
}).strict();

export const SessionStreamsHelloSchema = z.object({
  protocolVersion: z.literal(SESSION_STREAM_PROTOCOL_VERSION),
  streams: z.array(SessionStreamDescriptorSchema),
}).strict();

export const SessionStreamsHelloEventType = "streams.hello";
